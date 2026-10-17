package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"diary/server/internal/adapters/google"
	"diary/server/internal/adapters/memnotifier"
	"diary/server/internal/adapters/sqlitestore"
	"diary/server/internal/core"
	"diary/server/internal/httpapi"
)

// fakeGoogle implements the token, calendar list, events and revoke endpoints.
func fakeGoogle(t *testing.T, revoked *atomic.Bool) *httptest.Server {
	t.Helper()
	idToken := "x." + base64.RawURLEncoding.EncodeToString([]byte(`{"email":"you@gmail.com"}`)) + ".y"
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		if revoked.Load() {
			w.WriteHeader(400)
			io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			if r.Form.Get("code") != "good-code" || r.Form.Get("client_secret") != "secret" {
				w.WriteHeader(400)
				io.WriteString(w, `{"error":"invalid_request"}`)
				return
			}
			io.WriteString(w, `{"access_token":"at1","expires_in":3600,"refresh_token":"rt1","id_token":"`+idToken+`"}`)
		case "refresh_token":
			io.WriteString(w, `{"access_token":"at2","expires_in":3600}`)
		}
	})
	mux.HandleFunc("GET /calendar/v3/users/me/calendarList", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"items":[
			{"id":"primary@x","summary":"you@gmail.com","primary":true,"selected":true,"backgroundColor":"#4986e7"},
			{"id":"hidden@x","summary":"Hidden","selected":false},
			{"id":"team@x","summary":"Team","summaryOverride":"Work","selected":true}]}`)
	})
	mux.HandleFunc("GET /calendar/v3/calendars/{id}/events", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer at") || r.URL.Query().Get("singleEvents") != "true" {
			w.WriteHeader(401)
			return
		}
		switch r.PathValue("id") {
		case "primary@x":
			io.WriteString(w, `{"items":[
				{"id":"a","summary":"Dentist","start":{"dateTime":"2026-10-05T15:00:00+02:00"},"end":{"dateTime":"2026-10-05T16:00:00+02:00"},"htmlLink":"https://calendar.google.com/a"},
				{"id":"b","summary":"Holiday","start":{"date":"2026-10-05"},"end":{"date":"2026-10-06"}},
				{"id":"c","status":"cancelled","summary":"Gone","start":{"date":"2026-10-05"},"end":{"date":"2026-10-06"}}]}`)
		case "team@x":
			io.WriteString(w, `{"items":[{"id":"d","summary":"Standup","start":{"dateTime":"2026-10-05T09:00:00+02:00"},"end":{"dateTime":"2026-10-05T09:15:00+02:00"}}]}`)
		default:
			t.Errorf("events requested for %s", r.PathValue("id"))
		}
	})
	mux.HandleFunc("POST /revoke", func(w http.ResponseWriter, r *http.Request) { revoked.Store(true) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newCalendarServer(t *testing.T, withGoogle bool) (*httptest.Server, *atomic.Bool) {
	t.Helper()
	store, err := sqlitestore.Open(filepath.Join(t.TempDir(), "diary.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	revoked := &atomic.Bool{}
	var cal core.CalendarProvider
	if withGoogle {
		g := fakeGoogle(t, revoked)
		c := google.New("client-id", "secret")
		c.AuthEndpoint, c.TokenEndpoint, c.RevokeEndpoint, c.APIBase = g.URL+"/auth", g.URL+"/token", g.URL+"/revoke", g.URL+"/calendar/v3"
		cal = c
	}
	n := memnotifier.New()
	srv := httptest.NewServer(httpapi.New(httpapi.Deps{
		Entries: core.NewEntryService(store, n), Sync: core.NewSyncService(store), Notifier: n,
		Auth: headerAuth{}, Users: store, Blobs: store, Calendar: cal, Integrations: store, Version: "test",
		PublicURL: "https://diary.example.ts.net",
	}))
	t.Cleanup(srv.Close)
	return srv, revoked
}

func TestGoogleCalendarConnectReadDisconnect(t *testing.T) {
	srv, revoked := newCalendarServer(t, true)
	me := client{t, srv.URL, "me@test"}

	code, b := me.do("GET", "/v1/integrations/google", nil, nil)
	st := decode[map[string]any](t, b)
	if code != 200 || st["configured"] != true || st["connected"] != false ||
		st["redirect_uri"] != "https://diary.example.ts.net/v1/integrations/google/callback" {
		t.Fatalf("status = %d %s", code, b)
	}

	code, b = me.do("POST", "/v1/integrations/google/start", map[string]string{"client": "web"}, nil)
	auth, err := url.Parse(decode[map[string]string](t, b)["url"])
	if code != 200 || err != nil {
		t.Fatalf("start = %d %s", code, b)
	}
	q := auth.Query()
	if q.Get("access_type") != "offline" || !strings.Contains(q.Get("scope"), "calendar.readonly") || q.Get("state") == "" {
		t.Errorf("auth url = %s", auth)
	}

	// Google sends the browser back without our session (cross-site): the state identifies the user.
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	cb := srv.URL + "/v1/integrations/google/callback?code=good-code&state=" + q.Get("state")
	res, err := noRedirect.Get(cb)
	if err != nil || res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/settings?google=connected" {
		t.Fatalf("callback = %v %v", res.StatusCode, err)
	}
	res.Body.Close()
	if res, _ := noRedirect.Get(cb); res.StatusCode != 400 {
		t.Errorf("reused state = %d, want 400", res.StatusCode)
	}

	_, b = me.do("GET", "/v1/integrations/google", nil, nil)
	if st := decode[map[string]any](t, b); st["connected"] != true || st["email"] != "you@gmail.com" {
		t.Errorf("after connect = %s", b)
	}
	if _, b := (client{t, srv.URL, "other@test"}).do("GET", "/v1/integrations/google", nil, nil); decode[map[string]any](t, b)["connected"] != false {
		t.Error("another user sees the connection")
	}

	start := url.QueryEscape("2026-10-05T00:00:00+02:00")
	end := url.QueryEscape("2026-10-06T00:00:00+02:00")
	code, b = me.do("GET", "/v1/calendar/events?start="+start+"&end="+end, nil, nil)
	var ev struct {
		Connected bool                 `json:"connected"`
		Events    []core.CalendarEvent `json:"events"`
	}
	_ = json.Unmarshal(b, &ev)
	if code != 200 || !ev.Connected || len(ev.Events) != 3 {
		t.Fatalf("events = %d %s", code, b)
	}
	if ev.Events[0].Title != "Holiday" || !ev.Events[0].AllDay || ev.Events[1].Title != "Standup" || ev.Events[1].Calendar != "Work" || ev.Events[2].Title != "Dentist" {
		t.Errorf("order/fields = %+v", ev.Events)
	}

	if code, _ := me.do("GET", "/v1/calendar/events?start=bad&end="+end, nil, nil); code != 400 {
		t.Errorf("bad range = %d", code)
	}

	// Access withdrawn at Google: the connection is dropped, so the app asks again.
	revoked.Store(true)
	time.Sleep(10 * time.Millisecond)
	if code, b := me.do("DELETE", "/v1/integrations/google", nil, nil); code != 204 {
		t.Errorf("disconnect = %d %s", code, b)
	}
	_, b = me.do("GET", "/v1/integrations/google", nil, nil)
	if decode[map[string]any](t, b)["connected"] != false {
		t.Errorf("after disconnect = %s", b)
	}
}

func TestCalendarOffWithoutCredentials(t *testing.T) {
	srv, _ := newCalendarServer(t, false)
	me := client{t, srv.URL, "me@test"}
	_, b := me.do("GET", "/v1/integrations/google", nil, nil)
	if decode[map[string]any](t, b)["configured"] != false {
		t.Errorf("status = %s", b)
	}
	if code, _ := me.do("POST", "/v1/integrations/google/start", nil, nil); code != 404 {
		t.Errorf("start without credentials = %d", code)
	}
	start := url.QueryEscape("2026-10-05T00:00:00Z")
	end := url.QueryEscape("2026-10-06T00:00:00Z")
	if code, b := me.do("GET", "/v1/calendar/events?start="+start+"&end="+end, nil, nil); code != 200 || !strings.Contains(string(b), `"connected":false`) {
		t.Errorf("events = %d %s", code, b)
	}
}
