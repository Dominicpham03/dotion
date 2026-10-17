// Package ollama is the core.ChatModel adapter for a local model served by
// Ollama (https://ollama.com). Nothing leaves the machine that runs it.
package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

// DefaultModel is used when DIARY_OLLAMA_MODEL is not set.
const DefaultModel = "qwen3:14b"

const (
	maxRounds      = 10    // tool-call rounds per answer; the last one must answer in text
	maxToolChars   = 12000 // of one tool result, so a local model's context isn't flooded
	DefaultContext = 16384 // tokens; fits a 14B model plus its cache in about 12 GB of VRAM
)

type Client struct {
	base    string
	model   string
	context int
	http    *http.Client
}

// New makes a client for the Ollama server at baseURL (e.g. http://localhost:11434).
func New(baseURL, model string, contextTokens int) *Client {
	if model == "" {
		model = DefaultModel
	}
	if contextTokens <= 0 {
		contextTokens = DefaultContext
	}
	// Local models can take minutes on a long question; the request context sets the limit.
	return &Client{base: strings.TrimRight(baseURL, "/"), model: model, context: contextTokens, http: &http.Client{}}
}

func (c *Client) Model() string { return c.model }

type toolCall struct {
	Function struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	} `json:"function"`
}

type message struct {
	Role      string     `json:"role"`
	Content   string     `json:"content"`
	Thinking  string     `json:"thinking,omitempty"`
	ToolCalls []toolCall `json:"tool_calls,omitempty"`
	ToolName  string     `json:"tool_name,omitempty"`
}

type tool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

type chatRequest struct {
	Model    string         `json:"model"`
	Messages []message      `json:"messages"`
	Tools    []tool         `json:"tools,omitempty"`
	Format   any            `json:"format,omitempty"`
	Think    bool           `json:"think"`
	Stream   bool           `json:"stream"`
	Options  map[string]any `json:"options,omitempty"`
}

type chatResponse struct {
	Message    message `json:"message"`
	DoneReason string  `json:"done_reason"`
	Error      string  `json:"error"`
}

func unavailable(format string, a ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{core.ErrAIUnavailable}, a...)...)
}

func (c *Client) chat(ctx context.Context, req chatRequest) (chatResponse, error) {
	req.Model, req.Stream = c.model, false
	req.Options = map[string]any{"num_ctx": c.context}
	body, _ := json.Marshal(req)
	hreq, err := http.NewRequestWithContext(ctx, "POST", c.base+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return chatResponse{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(hreq)
	if err != nil {
		return chatResponse{}, unavailable("can't reach Ollama at %s: %v", c.base, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	var out chatResponse
	_ = json.Unmarshal(raw, &out)
	if res.StatusCode != http.StatusOK {
		if out.Error == "" {
			out.Error = strings.TrimSpace(string(raw))
		}
		if res.StatusCode == http.StatusNotFound {
			return out, unavailable("model %q isn't installed; run: ollama pull %s", c.model, c.model)
		}
		return out, unavailable("ollama answered %d: %s", res.StatusCode, out.Error)
	}
	return out, nil
}

// Respond runs the conversation with tools until the model answers in text.
// Qwen3 and similar models think before answering ("think": true).
func (c *Client) Respond(ctx context.Context, system string, tools []core.ToolSpec, history []syncproto.AIMessage, run core.ToolRunner) (string, error) {
	msgs := []message{{Role: "system", Content: system}}
	for _, m := range history {
		role := "user"
		if m.Role == "model" {
			role = "assistant"
		}
		msgs = append(msgs, message{Role: role, Content: m.Text})
	}
	defs := make([]tool, 0, len(tools))
	for _, t := range tools {
		var d tool
		d.Type = "function"
		d.Function.Name, d.Function.Description, d.Function.Parameters = t.Name, t.Description, t.Parameters
		defs = append(defs, d)
	}

	for round := 1; ; round++ {
		req := chatRequest{Messages: msgs, Think: true}
		if round < maxRounds {
			req.Tools = defs // the last round has no tools, so the model must answer
		}
		res, err := c.chat(ctx, req)
		if err != nil {
			return "", err
		}
		if len(res.Message.ToolCalls) == 0 {
			text := stripThink(res.Message.Content)
			if text == "" {
				return "", unavailable("the model gave an empty answer (%s)", res.DoneReason)
			}
			return text, nil
		}
		msgs = append(msgs, res.Message)
		for _, call := range res.Message.ToolCalls {
			out := run(ctx, call.Function.Name, call.Function.Arguments)
			b, _ := json.Marshal(out)
			msgs = append(msgs, message{Role: "tool", ToolName: call.Function.Name, Content: clip(string(b))})
		}
	}
}

// Extract asks for JSON matching schema (Ollama's structured outputs).
func (c *Client) Extract(ctx context.Context, system, prompt string, schema map[string]any) (json.RawMessage, error) {
	msgs := []message{{Role: "system", Content: system}, {Role: "user", Content: prompt}}
	// Thinking first gives better results; if a model can't combine it with
	// structured output, try again without.
	for _, think := range []bool{true, false} {
		res, err := c.chat(ctx, chatRequest{Messages: msgs, Format: schema, Think: think, Options: nil})
		if err != nil {
			return nil, err
		}
		text := stripThink(res.Message.Content)
		if json.Valid([]byte(text)) {
			return json.RawMessage(text), nil
		}
	}
	return nil, unavailable("the model didn't return valid JSON")
}

// stripThink removes a <think>…</think> block, for models that put their
// reasoning in the answer instead of the separate thinking field.
func stripThink(s string) string {
	if i := strings.Index(s, "</think>"); i >= 0 && strings.HasPrefix(strings.TrimSpace(s), "<think>") {
		s = s[i+len("</think>"):]
	}
	return strings.TrimSpace(s)
}

func clip(s string) string {
	if len(s) <= maxToolChars {
		return s
	}
	return s[:maxToolChars] + ` … [cut off: the result was too long; ask for something narrower]`
}

// Ping reports whether Ollama is reachable and has the model, for the startup log.
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", c.base+"/api/show", strings.NewReader(fmt.Sprintf(`{"model":%q}`, c.model)))
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("can't reach Ollama at %s: %w", c.base, err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("model %q isn't installed; run: ollama pull %s", c.model, c.model)
	}
	return nil
}
