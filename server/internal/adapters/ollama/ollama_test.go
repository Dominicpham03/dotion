package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

// fakeOllama answers /api/chat: a tool call first, then text once it sees
// the tool's result; JSON when a format is requested.
func fakeOllama(t *testing.T, reqs *[]chatRequest) *httptest.Server {
	var mu sync.Mutex
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/show" {
			var body struct{ Model string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Model != "qwen3:14b" {
				w.WriteHeader(404)
			}
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || r.URL.Path != "/api/chat" {
			t.Errorf("bad request %s: %v", r.URL.Path, err)
		}
		mu.Lock()
		*reqs = append(*reqs, req)
		mu.Unlock()
		if req.Model != "qwen3:14b" {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":"model not found"}`))
			return
		}
		last := req.Messages[len(req.Messages)-1]
		switch {
		case req.Format != nil:
			_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"{\"items\":[]}"},"done_reason":"stop"}`))
		case last.Role == "tool":
			_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"<think>ok</think>You wrote about the budget."},"done_reason":"stop"}`))
		default:
			_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"","thinking":"I should search.","tool_calls":[{"function":{"name":"search_notes","arguments":{"query":"budget"}}}]},"done_reason":"stop"}`))
		}
	}))
}

func TestRespondRunsTools(t *testing.T) {
	var reqs []chatRequest
	srv := fakeOllama(t, &reqs)
	defer srv.Close()
	c := New(srv.URL+"/", "", 0)
	if err := c.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	var calls []string
	run := func(_ context.Context, name string, args map[string]any) map[string]any {
		calls = append(calls, name+":"+args["query"].(string))
		return map[string]any{"matches": []any{}, "big": strings.Repeat("x", 20000)}
	}
	tools := []core.ToolSpec{{Name: "search_notes", Description: "search", Parameters: map[string]any{"type": "object"}}}
	text, err := c.Respond(context.Background(), "be brief", tools, []syncproto.AIMessage{{Role: "user", Text: "hi"}, {Role: "model", Text: "hello"}, {Role: "user", Text: "budget?"}}, run)
	if err != nil || text != "You wrote about the budget." {
		t.Fatalf("Respond = %q, %v", text, err)
	}
	if len(calls) != 1 || calls[0] != "search_notes:budget" {
		t.Errorf("calls = %v", calls)
	}
	first, second := reqs[0], reqs[1]
	if !first.Think || first.Options["num_ctx"] != float64(DefaultContext) || first.Messages[0].Role != "system" || first.Messages[2].Role != "assistant" || len(first.Tools) != 1 {
		t.Errorf("first request = %+v", first)
	}
	// The model's turn (with its thinking) goes back, then the clipped tool result.
	if m := second.Messages[len(second.Messages)-2]; m.Thinking != "I should search." || len(m.ToolCalls) != 1 {
		t.Errorf("assistant turn = %+v", m)
	}
	if m := second.Messages[len(second.Messages)-1]; m.Role != "tool" || m.ToolName != "search_notes" || len(m.Content) > maxToolChars+100 || !strings.Contains(m.Content, "cut off") {
		t.Errorf("tool turn = %d chars", len(m.Content))
	}
}

func TestExtractAndMissingModel(t *testing.T) {
	var reqs []chatRequest
	srv := fakeOllama(t, &reqs)
	defer srv.Close()
	raw, err := New(srv.URL, "", 0).Extract(context.Background(), "find tasks", "note", map[string]any{"type": "object"})
	if err != nil || string(raw) != `{"items":[]}` {
		t.Fatalf("Extract = %s, %v", raw, err)
	}

	missing := New(srv.URL, "llama9:999b", 0)
	_, err = missing.Extract(context.Background(), "x", "y", map[string]any{"type": "object"})
	if !errors.Is(err, core.ErrAIUnavailable) || !strings.Contains(err.Error(), "ollama pull llama9:999b") {
		t.Errorf("error = %v", err)
	}
	if missing.Ping(context.Background()) == nil {
		t.Error("Ping should report the missing model")
	}
	if _, err := New("http://127.0.0.1:1", "", 0).Extract(context.Background(), "x", "y", nil); !errors.Is(err, core.ErrAIUnavailable) {
		t.Errorf("unreachable = %v", err)
	}
}
