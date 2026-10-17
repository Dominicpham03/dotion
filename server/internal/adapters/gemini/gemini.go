// Package gemini is the core.ChatModel adapter for Google's Gemini API.
package gemini

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"google.golang.org/genai"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

// DefaultModel is used when DIARY_GEMINI_MODEL is not set.
const DefaultModel = "gemini-3.8-flash"

// maxRounds caps tool-call rounds per answer; the last round must answer in text.
const maxRounds = 10

type Client struct {
	models *genai.Models
	model  string
}

// New makes a client for the Gemini API. baseURL is only for tests.
func New(ctx context.Context, apiKey, model, baseURL string) (*Client, error) {
	if model == "" {
		model = DefaultModel
	}
	cc := &genai.ClientConfig{APIKey: apiKey, Backend: genai.BackendGeminiAPI}
	if baseURL != "" {
		cc.HTTPOptions.BaseURL = baseURL
	}
	c, err := genai.NewClient(ctx, cc)
	if err != nil {
		return nil, err
	}
	return &Client{models: c.Models, model: model}, nil
}

func (c *Client) Model() string { return c.model }

func unavailable(err error) error { return fmt.Errorf("%w: %v", core.ErrAIUnavailable, err) }

// Respond runs the conversation with tools until Gemini answers in text.
// The model's own turns are sent back unchanged so their thought signatures
// stay valid between tool calls.
func (c *Client) Respond(ctx context.Context, system string, tools []core.ToolSpec, history []syncproto.AIMessage, run core.ToolRunner) (string, error) {
	contents := make([]*genai.Content, 0, len(history)+2*maxRounds)
	for _, m := range history {
		role := genai.RoleUser
		if m.Role == "model" {
			role = genai.RoleModel
		}
		contents = append(contents, genai.NewContentFromText(m.Text, genai.Role(role)))
	}
	decls := make([]*genai.FunctionDeclaration, 0, len(tools))
	for _, t := range tools {
		decls = append(decls, &genai.FunctionDeclaration{Name: t.Name, Description: t.Description, ParametersJsonSchema: t.Parameters})
	}
	cfg := &genai.GenerateContentConfig{
		SystemInstruction: genai.NewContentFromText(system, genai.RoleUser),
		Tools:             []*genai.Tool{{FunctionDeclarations: decls}},
		ThinkingConfig:    &genai.ThinkingConfig{ThinkingLevel: genai.ThinkingLevelMedium},
	}

	for round := 1; ; round++ {
		if round == maxRounds {
			cfg.ToolConfig = &genai.ToolConfig{FunctionCallingConfig: &genai.FunctionCallingConfig{Mode: genai.FunctionCallingConfigModeNone}}
		}
		resp, err := c.models.GenerateContent(ctx, c.model, contents, cfg)
		if err != nil {
			return "", unavailable(err)
		}
		if len(resp.Candidates) == 0 || resp.Candidates[0].Content == nil {
			return "", declined(resp)
		}
		calls := resp.FunctionCalls()
		if len(calls) == 0 || round == maxRounds {
			text := strings.TrimSpace(resp.Text())
			if text == "" {
				return "", declined(resp)
			}
			return text, nil
		}
		contents = append(contents, resp.Candidates[0].Content)
		results := make([]*genai.Part, 0, len(calls))
		for _, call := range calls {
			out := run(ctx, call.Name, call.Args)
			results = append(results, &genai.Part{FunctionResponse: &genai.FunctionResponse{ID: call.ID, Name: call.Name, Response: out}})
		}
		contents = append(contents, &genai.Content{Role: genai.RoleUser, Parts: results})
	}
}

// Extract asks for JSON matching schema (structured output, no tools).
func (c *Client) Extract(ctx context.Context, system, prompt string, schema map[string]any) (json.RawMessage, error) {
	cfg := &genai.GenerateContentConfig{
		SystemInstruction:  genai.NewContentFromText(system, genai.RoleUser),
		ResponseMIMEType:   "application/json",
		ResponseJsonSchema: schema,
		ThinkingConfig:     &genai.ThinkingConfig{ThinkingLevel: genai.ThinkingLevelLow},
	}
	resp, err := c.models.GenerateContent(ctx, c.model, genai.Text(prompt), cfg)
	if err != nil {
		return nil, unavailable(err)
	}
	text := strings.TrimSpace(resp.Text())
	if text == "" || !json.Valid([]byte(text)) {
		return nil, declined(resp)
	}
	return json.RawMessage(text), nil
}

// declined explains an empty answer (blocked prompt, safety stop, …).
func declined(resp *genai.GenerateContentResponse) error {
	reason := "no answer"
	if resp.PromptFeedback != nil && resp.PromptFeedback.BlockReason != "" {
		reason = "prompt blocked: " + string(resp.PromptFeedback.BlockReason)
	} else if len(resp.Candidates) > 0 && resp.Candidates[0].FinishReason != "" {
		reason = "stopped: " + string(resp.Candidates[0].FinishReason)
	}
	return unavailable(fmt.Errorf("gemini gave %s", reason))
}
