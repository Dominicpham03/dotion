package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"diary/server/internal/adapters/memnotifier"
	"diary/server/internal/adapters/sqlitestore"
	"diary/server/internal/core"
	"diary/server/internal/httpapi"
	"diary/shared/model"
	"diary/shared/syncproto"
)

// fakeModel plays Gemini: Respond searches, reads the first hit and drafts a
// page; Extract finds "send the budget" in any note that mentions it.
type fakeModel struct {
	mu      sync.Mutex
	systems []string
	prompts []string
	results []map[string]any
}

func (f *fakeModel) Model() string { return "fake-gemini" }

func (f *fakeModel) Respond(ctx context.Context, system string, tools []core.ToolSpec, history []syncproto.AIMessage, run core.ToolRunner) (string, error) {
	f.mu.Lock()
	f.systems = append(f.systems, system)
	f.mu.Unlock()
	hits := run(ctx, "search_notes", map[string]any{"query": "budget"})
	matches, _ := hits["matches"].([]map[string]any)
	if len(matches) == 0 {
		return "I couldn't find anything about the budget.", nil
	}
	id := matches[0]["id"].(string)
	page := run(ctx, "read_page", map[string]any{"id": id})
	draft := run(ctx, "propose_page", map[string]any{"title": "Budget follow-up", "markdown": "- [ ] Send the budget"})
	unknown := run(ctx, "delete_everything", map[string]any{})
	f.mu.Lock()
	f.results = append(f.results, page, draft, unknown)
	f.mu.Unlock()
	return "You agreed to send the budget. See [" + page["title"].(string) + "](dotion:" + id + ").", nil
}

func (f *fakeModel) Extract(_ context.Context, system, prompt string, _ map[string]any) (json.RawMessage, error) {
	f.mu.Lock()
	f.prompts = append(f.prompts, prompt)
	f.mu.Unlock()
	if !strings.Contains(prompt, "budget") {
		return json.RawMessage(`{"items":[]}`), nil
	}
	return json.RawMessage(`{"items":[
		{"task":"Send the Q3 budget to Ana","due_date":"2026-10-23","quote":"Dom to send the Q3 budget to Ana by Friday"},
		{"task":"Old thing","due_date":"2025-01-01","quote":"ancient"},
		{"task":"No date","due_date":"soon","quote":"someday"}]}`), nil
}

type fakeCalendar struct {
	mu     sync.Mutex
	events []core.NewEvent
}

func (f *fakeCalendar) CreateEvent(_ context.Context, refresh string, ev core.NewEvent) (core.CreatedEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if refresh != "rt-cal" {
		return core.CreatedEvent{}, core.ErrGrantRevoked
	}
	f.events = append(f.events, ev)
	return core.CreatedEvent{ID: "dotion" + ev.Key, Link: "https://calendar.google.com/event?eid=" + ev.Key}, nil
}

type aiServer struct {
	url     string
	store   *sqlitestore.Store
	model   *fakeModel
	cal     *fakeCalendar
	actions *core.ActionsService
}

func newAIServer(t *testing.T, enabled bool) aiServer {
	t.Helper()
	store, err := sqlitestore.Open(filepath.Join(t.TempDir(), "diary.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	n := memnotifier.New()
	entries := core.NewEntryService(store, n)
	s := aiServer{store: store, model: &fakeModel{}, cal: &fakeCalendar{}}
	deps := httpapi.Deps{
		Entries: entries, Sync: core.NewSyncService(store), Notifier: n, Auth: headerAuth{}, Users: store, Blobs: store,
		Integrations: store, Version: "test",
	}
	if enabled {
		s.actions = core.NewActionsService(entries, s.model, store, s.cal, nil)
		s.actions.Now = func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) }
		deps.Actions = s.actions
		deps.Assistant = core.NewAssistantService(entries, s.model, store, nil, nil, s.actions)
	}
	srv := newHTTPTestServer(t, httpapi.New(deps))
	t.Cleanup(n.CloseAll)
	s.url = srv
	return s
}

func putPage(t *testing.T, c client, id, title, text string, date *string) {
	t.Helper()
	body := map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": text}}}}}
	if code, b := c.do("PUT", "/v1/entries/"+id, map[string]any{"base_version": 0, "entry_date": date, "title": title, "body": body},
		map[string]string{syncproto.HeaderIdempotencyKey: uuid.NewString()}); code != 200 && code != 201 {
		t.Fatalf("put %s = %d %s", title, code, b)
	}
}

func TestAIDisabledWithoutKey(t *testing.T) {
	s := newAIServer(t, false)
	me := client{t, s.url, "me@test"}
	if code, b := me.do("GET", "/v1/ai", nil, nil); code != 200 || decode[syncproto.AIStatus](t, b).Enabled {
		t.Errorf("status = %d %s", code, b)
	}
	if code, b := me.do("POST", "/v1/ai/chat", map[string]any{"messages": []any{map[string]string{"role": "user", "text": "hi"}}, "now": "2026-10-20T09:00:00-05:00"}, nil); code != 404 || !strings.Contains(string(b), "ai_disabled") {
		t.Errorf("chat = %d %s", code, b)
	}
	if code, _ := me.do("POST", "/v1/ai/actions/scan", nil, nil); code != 404 {
		t.Errorf("scan = %d", code)
	}
}

func TestAIChatUsesNotes(t *testing.T) {
	s := newAIServer(t, true)
	me := client{t, s.url, "me@test"}
	if code, b := me.do("GET", "/v1/ai", nil, nil); code != 200 || decode[syncproto.AIStatus](t, b).Model != "fake-gemini" {
		t.Fatalf("status = %d %s", code, b)
	}
	meeting := newID()
	putPage(t, me, meeting, "Planning sync", "Dom to send the Q3 budget to Ana by Friday.", nil)

	code, b := me.do("POST", "/v1/ai/chat", map[string]any{
		"messages": []any{map[string]string{"role": "user", "text": "What did I promise about the budget?"}},
		"entry_id": meeting, "now": "2026-10-20T09:00:00-05:00",
	}, nil)
	if code != 200 {
		t.Fatalf("chat = %d %s", code, b)
	}
	r := decode[syncproto.AIChatResponse](t, b)
	if !strings.Contains(r.Text, "dotion:"+meeting) || len(r.Sources) != 1 || r.Sources[0].Title != "Planning sync" {
		t.Errorf("answer = %+v", r)
	}
	if len(r.Proposals) != 1 || r.Proposals[0].Title != "Budget follow-up" {
		t.Errorf("proposals = %+v", r.Proposals)
	}
	sys := s.model.systems[0]
	if !strings.Contains(sys, "Planning sync") || !strings.Contains(sys, "2026-10-20") || !strings.Contains(sys, "Google Calendar is not connected") {
		t.Errorf("system prompt = %s", sys)
	}
	page := s.model.results[0]
	if !strings.Contains(page["text"].(string), "Q3 budget") {
		t.Errorf("read_page = %v", page)
	}
	if s.model.results[2]["error"] == nil {
		t.Error("an unknown tool should report an error")
	}
	// Nothing was saved by the draft.
	if _, b := me.do("GET", "/v1/search?q=follow-up", nil, nil); strings.Contains(string(b), "Budget follow-up") {
		t.Error("a proposal must not create a page")
	}

	for name, req := range map[string]map[string]any{
		"ends with model": {"messages": []any{map[string]string{"role": "model", "text": "hi"}}, "now": "2026-10-20T09:00:00Z"},
		"bad role":        {"messages": []any{map[string]string{"role": "system", "text": "hi"}}, "now": "2026-10-20T09:00:00Z"},
		"no clock":        {"messages": []any{map[string]string{"role": "user", "text": "hi"}}},
	} {
		if code, b := me.do("POST", "/v1/ai/chat", req, nil); code != 400 {
			t.Errorf("%s = %d %s", name, code, b)
		}
	}
}

func TestActionItems(t *testing.T) {
	s := newAIServer(t, true)
	me := client{t, s.url, "me@test"}
	owner := recordOwner(t, s.store)
	ctx := context.Background()

	if code, b := me.do("PUT", "/v1/ai/actions", map[string]any{"enabled": true, "names": []string{" Dom ", "dom", "DLP", ""}}, nil); code != 200 ||
		strings.Join(decode[syncproto.ActionsStatus](t, b).Names, ",") != "Dom,DLP" {
		t.Fatalf("configure = %d %s", code, b)
	}
	// Google is connected with permission to add events.
	cfg, _ := json.Marshal(map[string]string{"scopes": "openid email https://www.googleapis.com/auth/calendar.readonly " + core.CalendarEventsScope})
	if err := s.store.PutIntegration(ctx, owner, core.Integration{Provider: "google", RefreshToken: "rt-cal", Email: "dom@example.com", Config: cfg}); err != nil {
		t.Fatal(err)
	}
	_, b := me.do("GET", "/v1/ai/actions", nil, nil)
	st := decode[syncproto.ActionsStatus](t, b)
	if !st.Enabled || !st.CalendarWrite || st.DatabaseID == "" {
		t.Fatalf("status = %s", b)
	}

	meeting := newID()
	date := "2026-10-20"
	putPage(t, me, meeting, "Standup", "Dom to send the Q3 budget to Ana by Friday.", &date)
	putPage(t, me, newID(), "Groceries", "Eggs, milk, bread, apples and coffee beans for the week ahead please.", nil)

	code, b := me.do("POST", "/v1/ai/actions/scan", map[string]string{"entry_id": meeting}, nil)
	res := decode[syncproto.ActionsScanResponse](t, b)
	if code != 200 || res.Scanned != 1 || len(res.Created) != 1 {
		t.Fatalf("scan = %d %s", code, b)
	}
	it := res.Created[0]
	if it.Title != "Send the Q3 budget to Ana" || it.Due != "2026-10-23" || it.SourceID != meeting || it.EventLink == "" {
		t.Errorf("item = %+v", it)
	}
	if !strings.Contains(s.model.prompts[0], "Dom, DLP") || !strings.Contains(s.model.prompts[0], "dom@example.com") || !strings.Contains(s.model.prompts[0], "Tuesday") {
		t.Errorf("prompt = %s", s.model.prompts[0])
	}
	if len(s.cal.events) != 1 || s.cal.events[0].Date != "2026-10-23" || s.cal.events[0].Key != it.ID {
		t.Errorf("calendar = %+v", s.cal.events)
	}

	// The record: in the Action items database, To do, due Friday, linked to the note.
	_, b = me.do("GET", "/v1/entries/"+it.ID, nil, nil)
	rec := decode[model.Entry](t, b)
	if rec.ParentID == nil || *rec.ParentID != st.DatabaseID || !strings.Contains(string(rec.Meta), `"p_ai_status":"opt_aitodo"`) ||
		!strings.Contains(string(rec.Meta), `"p_ai_due":"2026-10-23"`) || !strings.Contains(string(rec.Meta), meeting) || !strings.Contains(string(rec.Body), "pageLink") {
		t.Errorf("record = %s %s", rec.Meta, rec.Body)
	}
	_, b = me.do("GET", "/v1/entries/"+meeting+"/backlinks", nil, nil)
	if !strings.Contains(string(b), it.ID) {
		t.Error("the note should list the action item under Linked from")
	}

	// Scanning again adds nothing new.
	_, b = me.do("POST", "/v1/ai/actions/scan", map[string]string{"entry_id": meeting}, nil)
	if r := decode[syncproto.ActionsScanResponse](t, b); len(r.Created) != 0 || len(s.cal.events) != 1 {
		t.Errorf("rescan = %s", b)
	}
	if !strings.Contains(s.model.prompts[1], "Already listed from this note: Send the Q3 budget to Ana") {
		t.Errorf("rescan prompt = %s", s.model.prompts[1])
	}

	// The automatic scan reads settled notes it hasn't read: just Groceries
	// (the Standup was read above), and skips its own records.
	s.actions.Now = func() time.Time { return time.Now().UTC().Add(10 * time.Minute) }
	r, err := s.actions.Scan(ctx, owner, "")
	if err != nil || r.Scanned != 1 || len(r.Created) != 0 {
		t.Errorf("automatic scan = %+v %v", r, err)
	}
	if r, _ := s.actions.Scan(ctx, owner, ""); r.Scanned != 0 {
		t.Errorf("second automatic scan read %d notes", r.Scanned)
	}

	// Switched off: the automatic scan refuses; a single page still works.
	me.do("PUT", "/v1/ai/actions", map[string]any{"enabled": false, "names": []string{"Dom"}}, nil)
	if code, b := me.do("POST", "/v1/ai/actions/scan", nil, nil); code != 409 {
		t.Errorf("scan while off = %d %s", code, b)
	}
	if code, _ := me.do("POST", "/v1/ai/actions/scan", map[string]string{"entry_id": meeting}, nil); code != 200 {
		t.Errorf("single scan while off = %d", code)
	}
	if code, _ := me.do("POST", "/v1/ai/actions/scan", map[string]string{"entry_id": newID()}, nil); code != 404 {
		t.Errorf("unknown page = %d", code)
	}
}

func newHTTPTestServer(t *testing.T, h http.Handler) string {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}
