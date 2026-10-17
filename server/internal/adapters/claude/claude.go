// Package claude is the core.ChatModel adapter for Anthropic's Claude API.
package claude

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

// DefaultModel is used when DIARY_ANTHROPIC_MODEL is not set.
const DefaultModel = "claude-opus-5-5"

const (
	maxRounds = 10 // tool-call rounds per answer; the last one has no tools, so it must answer
	maxTokens = 16000
)

type Client struct {
	api   anthropic.Client
	model string
}

// New makes a client for the Claude API. baseURL is only for tests.
func New(apiKey, model, baseURL string) *Client {
	if model == "" {
		model = DefaultModel
	}
	opts := []option.RequestOption{option.WithAPIKey(apiKey)}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	return &Client{api: anthropic.NewClient(opts...), model: model}
}

func (c *Client) Model() string { return c.model }

// params is what every request shares. On a safety decline the API re-runs the
// request on Anthropic's recommended fallback model ("fallbacks": "default").
func (c *Client) params(system []anthropic.BetaTextBlockParam, effort anthropic.BetaOutputConfigEffort) anthropic.BetaMessageNewParams {
	return anthropic.BetaMessageNewParams{
		Model:        c.model,
		MaxTokens:    maxTokens,
		System:       system,
		OutputConfig: anthropic.BetaOutputConfigParam{Effort: effort},
		Fallbacks:    anthropic.BetaFallbacksParamOfDefault(),
		Betas:        []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
	}
}

// systemBlocks puts the stable instructions first, cached (with the tools,
// which come before them), and the per-request part (time, open page) after.
func systemBlocks(system string) []anthropic.BetaTextBlockParam {
	stable, volatile, _ := strings.Cut(system, core.SystemVolatileMark)
	blocks := []anthropic.BetaTextBlockParam{{Text: stable, CacheControl: anthropic.NewBetaCacheControlEphemeralParam()}}
	if v := strings.TrimSpace(volatile); v != "" {
		blocks = append(blocks, anthropic.BetaTextBlockParam{Text: v})
	}
	return blocks
}

// Respond runs the conversation with tools until Claude answers in text.
// Claude's own turns are sent back unchanged (thinking blocks included).
func (c *Client) Respond(ctx context.Context, system string, tools []core.ToolSpec, history []syncproto.AIMessage, run core.ToolRunner) (string, error) {
	msgs := make([]anthropic.BetaMessageParam, 0, len(history)+2*maxRounds)
	for _, m := range history {
		role := anthropic.BetaMessageParamRoleUser
		if m.Role == "model" {
			role = anthropic.BetaMessageParamRoleAssistant
		}
		msgs = append(msgs, anthropic.BetaMessageParam{Role: role, Content: []anthropic.BetaContentBlockParamUnion{anthropic.NewBetaTextBlock(m.Text)}})
	}
	defs := make([]anthropic.BetaToolUnionParam, 0, len(tools))
	for _, t := range tools {
		props, _ := t.Parameters["properties"].(map[string]any)
		required, _ := t.Parameters["required"].([]string)
		defs = append(defs, anthropic.BetaToolUnionParam{OfTool: &anthropic.BetaToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Description),
			InputSchema: anthropic.BetaToolInputSchemaParam{Properties: props, Required: required},
		}})
	}

	params := c.params(systemBlocks(system), anthropic.BetaOutputConfigEffortHigh)
	for round := 1; ; round++ {
		params.Messages = msgs
		params.Tools = defs
		if round == maxRounds {
			params.ToolChoice = anthropic.BetaToolChoiceUnionParam{OfNone: &anthropic.BetaToolChoiceNoneParam{}}
		}
		resp, err := c.api.Beta.Messages.New(ctx, params)
		if err != nil {
			return "", apiError(err)
		}
		switch resp.StopReason {
		case anthropic.BetaStopReasonRefusal:
			return "", fmt.Errorf("%w: Claude declined to answer this one", core.ErrAIUnavailable)
		case anthropic.BetaStopReasonToolUse:
			msgs = append(msgs, resp.ToParam())
			var results []anthropic.BetaContentBlockParamUnion
			for _, block := range resp.Content {
				use, ok := block.AsAny().(anthropic.BetaToolUseBlock)
				if !ok {
					continue
				}
				var args map[string]any
				if err := json.Unmarshal([]byte(use.JSON.Input.Raw()), &args); err != nil {
					results = append(results, anthropic.NewBetaToolResultBlock(use.ID, "INVALID_JSON: the tool input wasn't valid JSON; try again", true))
					continue
				}
				result := run(ctx, use.Name, args)
				out, _ := json.Marshal(result)
				_, failed := result["error"]
				results = append(results, anthropic.NewBetaToolResultBlock(use.ID, string(out), failed))
			}
			msgs = append(msgs, anthropic.NewBetaUserMessage(results...)) // all results in one turn
			continue
		}
		var text strings.Builder
		for _, block := range resp.Content {
			if t, ok := block.AsAny().(anthropic.BetaTextBlock); ok {
				text.WriteString(t.Text)
			}
		}
		if s := strings.TrimSpace(text.String()); s != "" {
			return s, nil
		}
		return "", fmt.Errorf("%w: Claude gave an empty answer (%s)", core.ErrAIUnavailable, resp.StopReason)
	}
}

// Extract asks for JSON matching schema (structured outputs).
func (c *Client) Extract(ctx context.Context, system, prompt string, schema map[string]any) (json.RawMessage, error) {
	params := c.params(systemBlocks(system), anthropic.BetaOutputConfigEffortMedium)
	params.OutputConfig.Format = anthropic.BetaJSONSchemaOutputFormat(schema)
	params.Messages = []anthropic.BetaMessageParam{anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(prompt))}
	resp, err := c.api.Beta.Messages.New(ctx, params)
	if err != nil {
		return nil, apiError(err)
	}
	if resp.StopReason == anthropic.BetaStopReasonRefusal || resp.StopReason == anthropic.BetaStopReasonMaxTokens {
		return nil, fmt.Errorf("%w: no usable answer (%s)", core.ErrAIUnavailable, resp.StopReason)
	}
	for _, block := range resp.Content {
		if t, ok := block.AsAny().(anthropic.BetaTextBlock); ok && json.Valid([]byte(t.Text)) {
			return json.RawMessage(t.Text), nil
		}
	}
	return nil, fmt.Errorf("%w: Claude didn't return JSON", core.ErrAIUnavailable)
}

// apiError turns SDK errors into ErrAIUnavailable with a readable reason.
func apiError(err error) error {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case 401, 403:
			return fmt.Errorf("%w: the Anthropic API key was not accepted; check DIARY_ANTHROPIC_API_KEY", core.ErrAIUnavailable)
		case 404:
			return fmt.Errorf("%w: unknown model; check DIARY_ANTHROPIC_MODEL", core.ErrAIUnavailable)
		case 429:
			return fmt.Errorf("%w: too many requests or out of credit; try again in a minute", core.ErrAIUnavailable)
		case 529:
			return fmt.Errorf("%w: Claude is busy right now; try again in a minute", core.ErrAIUnavailable)
		}
		return fmt.Errorf("%w: Anthropic answered %d", core.ErrAIUnavailable, apiErr.StatusCode)
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fmt.Errorf("%w: took too long", core.ErrAIUnavailable)
	}
	return fmt.Errorf("%w: can't reach the Claude API: %v", core.ErrAIUnavailable, err)
}
