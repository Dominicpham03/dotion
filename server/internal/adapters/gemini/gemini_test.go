package gemini

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

// fakeGemini answers generateContent: first with a function call (carrying a
// thought signature), then with text once it sees the function's result.
func fakeGemini(t *testing.T, bodies *[]map[string]any) *httptest.Server {
	var mu sync.Mutex
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/models/test-model:generateContent") || r.Header.Get("x-goog-api-key") != "key" {
			http.Error(w, `{"error":{"code":404,"message":"not found","status":"NOT_FOUND"}}`, 404)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		*bodies = append(*bodies, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case body["generationConfig"] != nil && strings.Contains(string(raw), "responseJsonSchema"):
			io.WriteString(w, `{"candidates":[{"content":{"role":"model","parts":[{"text":"{\"items\":[]}"}]},"finishReason":"STOP"}]}`)
		case strings.Contains(string(raw), "functionResponse"):
			io.WriteString(w, `{"candidates":[{"content":{"role":"model","parts":[{"text":"You wrote about the budget."}]},"finishReason":"STOP"}]}`)
		default:
			io.WriteString(w, `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"c1","name":"search_notes","args":{"query":"budget"}},"thoughtSignature":"c2lnbmF0dXJl"}]},"finishReason":"STOP"}]}`)
		}
	}))
}

func TestRespondRunsTools(t *testing.T) {
	var bodies []map[string]any
	srv := fakeGemini(t, &bodies)
	defer srv.Close()
	c, err := New(context.Background(), "key", "test-model", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	var calls []string
	run := func(_ context.Context, name string, args map[string]any) map[string]any {
		calls = append(calls, name+":"+args["query"].(string))
		return map[string]any{"matches": []any{}}
	}
	tools := []core.ToolSpec{{Name: "search_notes", Description: "search", Parameters: map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}}}}
	text, err := c.Respond(context.Background(), "be brief", tools, []syncproto.AIMessage{{Role: "user", Text: "budget?"}}, run)
	if err != nil || text != "You wrote about the budget." {
		t.Fatalf("Respond = %q, %v", text, err)
	}
	if len(calls) != 1 || calls[0] != "search_notes:budget" {
		t.Errorf("calls = %v", calls)
	}
	if len(bodies) != 2 {
		t.Fatalf("requests = %d", len(bodies))
	}
	second, _ := json.Marshal(bodies[1])
	for _, want := range []string{`"thoughtSignature":"c2lnbmF0dXJl"`, `"functionResponse"`, `"id":"c1"`, `"be brief"`} {
		if !strings.Contains(string(second), want) {
			t.Errorf("second request lacks %s: %s", want, second)
		}
	}
}

func TestExtractAndErrors(t *testing.T) {
	var bodies []map[string]any
	srv := fakeGemini(t, &bodies)
	defer srv.Close()
	c, _ := New(context.Background(), "key", "test-model", srv.URL)
	raw, err := c.Extract(context.Background(), "find tasks", "note", map[string]any{"type": "object"})
	if err != nil || string(raw) != `{"items":[]}` {
		t.Fatalf("Extract = %s, %v", raw, err)
	}

	bad, _ := New(context.Background(), "wrong-key", "test-model", srv.URL)
	if _, err := bad.Extract(context.Background(), "x", "y", map[string]any{"type": "object"}); !errors.Is(err, core.ErrAIUnavailable) {
		t.Errorf("error = %v", err)
	}
	if c.Model() != "test-model" {
		t.Error(c.Model())
	}
}
