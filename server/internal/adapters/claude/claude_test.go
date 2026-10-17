package claude

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

type seen struct {
	body   map[string]any
	raw    string
	header http.Header
}

// fakeClaude answers /v1/messages: a tool call first (after a thinking
// block), text once it sees a tool result, JSON when output_config.format is set.
func fakeClaude(t *testing.T, reqs *[]seen, status int) *httptest.Server {
	var mu sync.Mutex
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		*reqs = append(*reqs, seen{body, string(raw), r.Header.Clone()})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if status != 200 {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`)
			return
		}
		msg := func(content, stop string) {
			_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":`+content+
				`,"stop_reason":"`+stop+`","stop_details":null,"usage":{"input_tokens":10,"output_tokens":5}}`)
		}
		switch {
		case strings.Contains(string(raw), `"output_config":{"effort":"medium","format"`):
			msg(`[{"type":"text","text":"{\"items\":[]}"}]`, "end_turn")
		case strings.Contains(string(raw), `"tool_result"`):
			msg(`[{"type":"text","text":"You wrote about the budget in [Standup](dotion:x)."}]`, "end_turn")
		default:
			msg(`[{"type":"thinking","thinking":"","signature":"sig-1"},{"type":"tool_use","id":"tu_1","name":"search_notes","input":{"query":"budget"}}]`, "tool_use")
		}
	}))
}

func TestRespondRunsTools(t *testing.T) {
	var reqs []seen
	srv := fakeClaude(t, &reqs, 200)
	defer srv.Close()
	c := New("sk-test", "", srv.URL)

	var calls []string
	run := func(_ context.Context, name string, args map[string]any) map[string]any {
		calls = append(calls, name+":"+args["query"].(string))
		return map[string]any{"matches": []any{}}
	}
	tools := []core.ToolSpec{{Name: "search_notes", Description: "search", Parameters: map[string]any{
		"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}, "required": []string{"query"},
	}}}
	system := "You are the assistant." + core.SystemVolatileMark + "Now: Monday."
	text, err := c.Respond(context.Background(), system, tools, []syncproto.AIMessage{{Role: "user", Text: "hi"}, {Role: "model", Text: "hello"}, {Role: "user", Text: "budget?"}}, run)
	if err != nil || !strings.HasPrefix(text, "You wrote about the budget") {
		t.Fatalf("Respond = %q, %v", text, err)
	}
	if len(calls) != 1 || calls[0] != "search_notes:budget" || len(reqs) != 2 {
		t.Fatalf("calls = %v, requests = %d", calls, len(reqs))
	}

	first := reqs[0]
	if first.body["model"] != "claude-opus-5-5" || first.body["fallbacks"] != "default" ||
		!strings.Contains(first.header.Get("anthropic-beta"), "server-side-fallback-2026-07-01") || first.header.Get("x-api-key") != "sk-test" {
		t.Errorf("first request = %s / %v", first.raw, first.header)
	}
	// Fixed instructions cached in their own block; the time after, uncached.
	sys := first.body["system"].([]any)
	if len(sys) != 2 || sys[0].(map[string]any)["cache_control"] == nil || sys[1].(map[string]any)["text"] != "Now: Monday." {
		t.Errorf("system = %v", sys)
	}
	if !strings.Contains(first.raw, `"effort":"high"`) || !strings.Contains(first.raw, `"required":["query"]`) || !strings.Contains(first.raw, `"role":"assistant"`) {
		t.Errorf("first request = %s", first.raw)
	}
	// Claude's turn goes back unchanged (thinking signature included), then the result.
	if !strings.Contains(reqs[1].raw, `"signature":"sig-1"`) || !strings.Contains(reqs[1].raw, `"tool_use_id":"tu_1"`) {
		t.Errorf("second request = %s", reqs[1].raw)
	}
}

func TestExtractAndErrors(t *testing.T) {
	var reqs []seen
	srv := fakeClaude(t, &reqs, 200)
	defer srv.Close()
	schema := map[string]any{"type": "object", "properties": map[string]any{"items": map[string]any{"type": "array"}}, "required": []string{"items"}, "additionalProperties": false}
	raw, err := New("sk-test", "claude-haiku-5-5", srv.URL).Extract(context.Background(), "find tasks", "note", schema)
	if err != nil || string(raw) != `{"items":[]}` {
		t.Fatalf("Extract = %s, %v", raw, err)
	}
	if reqs[0].body["model"] != "claude-haiku-5-5" || !strings.Contains(reqs[0].raw, `"type":"json_schema"`) {
		t.Errorf("extract request = %s", reqs[0].raw)
	}

	var bad []seen
	denied := fakeClaude(t, &bad, 401)
	defer denied.Close()
	_, err = New("wrong", "", denied.URL).Extract(context.Background(), "x", "y", schema)
	if !errors.Is(err, core.ErrAIUnavailable) || !strings.Contains(err.Error(), "DIARY_ANTHROPIC_API_KEY") {
		t.Errorf("error = %v", err)
	}
}
