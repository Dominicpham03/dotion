package httpapi_test

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"diary/server/internal/adapters/auth"
	"diary/server/internal/adapters/memnotifier"
	"diary/server/internal/adapters/sqlitestore"
	"diary/server/internal/core"
	"diary/server/internal/httpapi"
	"diary/shared/model"
	"diary/shared/syncproto"
)

// headerAuth trusts X-Test-Login, so tests can act as several users.
type headerAuth struct{}

func (headerAuth) Identify(r *http.Request) (string, error) {
	if l := r.Header.Get("X-Test-Login"); l != "" {
		return l, nil
	}
	return "", core.ErrUnauthenticated
}

func newServer(t *testing.T, authn core.Authenticator) *httptest.Server {
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
	srv := httptest.NewServer(httpapi.New(httpapi.Deps{
		Entries: core.NewEntryService(store, n), Sync: core.NewSyncService(store), Notifier: n,
		Auth: authn, Users: store, Blobs: store, Ping: store.Ping, AuthMode: "test",
		MaxEntryBytes: 64 << 10, Version: "test", PingInterval: 50 * time.Millisecond,
		WebUI: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "<html>ui</html>") }),
	}))
	t.Cleanup(func() { n.CloseAll(); srv.Close() })
	return srv
}

type client struct {
	t     *testing.T
	base  string
	login string
}

func (c client) do(method, path string, body any, hdr map[string]string) (int, []byte) {
	c.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		j, _ := json.Marshal(b)
		rd = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	if c.login != "" {
		req.Header.Set("X-Test-Login", c.login)
	}
	if method != http.MethodGet {
		req.Header.Set(syncproto.HeaderClient, "1")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, out
}

func (c client) put(id string, base int, title string, key string) (int, []byte) {
	c.t.Helper()
	if key == "" {
		key = uuid.NewString()
	}
	return c.do("PUT", "/v1/entries/"+id, map[string]any{
		"base_version": base, "entry_date": "2026-10-05", "title": title,
		"body": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph",
			"content": []any{map[string]any{"type": "text", "text": title + " body text"}}}}},
	}, map[string]string{syncproto.HeaderIdempotencyKey: key})
}

func decode[T any](t *testing.T, b []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("decode %s: %v", b, err)
	}
	return v
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

func TestBasics(t *testing.T) {
	srv := newServer(t, headerAuth{})
	anon := client{t, srv.URL, ""}
	me := client{t, srv.URL, "me@test"}

	if code, b := anon.do("GET", "/v1/health", nil, nil); code != 200 || decode[syncproto.HealthResponse](t, b).DB != "ok" {
		t.Errorf("health = %d %s", code, b)
	}
	if code, _ := anon.do("GET", "/v1/me", nil, nil); code != 401 {
		t.Errorf("anonymous /v1/me = %d, want 401", code)
	}
	if code, b := me.do("GET", "/v1/me", nil, nil); code != 200 || decode[syncproto.MeResponse](t, b).Login != "me@test" {
		t.Errorf("me = %d %s", code, b)
	}
	if code, _ := me.do("GET", "/v1/nope", nil, nil); code != 404 {
		t.Errorf("unknown api route = %d", code)
	}
	if code, b := anon.do("GET", "/today", nil, nil); code != 200 || !strings.Contains(string(b), "ui") {
		t.Errorf("web ui = %d %s", code, b)
	}

	// CSRF: writes without X-Diary-Client are refused
	req, _ := http.NewRequest("PUT", srv.URL+"/v1/entries/"+newID(), strings.NewReader("{}"))
	req.Header.Set("X-Test-Login", "me@test")
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 403 {
		t.Errorf("PUT without client header = %d, want 403", res.StatusCode)
	}
	res.Body.Close()

	res, _ = http.Get(srv.URL + "/v1/health")
	if res.Header.Get("Content-Security-Policy") == "" || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Error("security headers missing")
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("CORS header emitted")
	}
	res.Body.Close()
}

func TestEntryLifecycle(t *testing.T) {
	srv := newServer(t, headerAuth{})
	c := client{t, srv.URL, "me@test"}
	id := newID()

	code, b := c.put(id, 0, "Monday", "")
	if code != 200 {
		t.Fatalf("create = %d %s", code, b)
	}
	e := decode[model.Entry](t, b)
	if e.Version != 1 || e.ServerSeq == 0 || *e.EntryDate != "2026-10-05" {
		t.Errorf("created = %+v", e)
	}

	// retry with the same key and body: same answer, no new write
	key := uuid.NewString()
	_, first := c.put(id, 1, "Monday v2", key)
	code, retry := c.put(id, 1, "Monday v2", key)
	if code != 200 || decode[model.Entry](t, retry).ServerSeq != decode[model.Entry](t, first).ServerSeq {
		t.Errorf("retry = %d %s", code, retry)
	}
	if code, b := c.put(id, 2, "different", key); code != 422 || decode[syncproto.ErrorResponse](t, b).Error != "idempotency_mismatch" {
		t.Errorf("key reuse = %d %s", code, b)
	}

	// stale base → 409 with the current entry
	code, b = c.put(id, 1, "stale", "")
	cerr := decode[syncproto.ErrorResponse](t, b)
	if code != 409 || cerr.Error != "conflict" || cerr.Current == nil || cerr.Current.Version != 2 {
		t.Errorf("conflict = %d %s", code, b)
	}

	if code, _ := c.put(newID(), 5, "ghost", ""); code != 404 {
		t.Errorf("unknown with base 5 = %d, want 404", code)
	}
	if code, b := c.do("PUT", "/v1/entries/not-a-uuid", map[string]any{"base_version": 0, "body": map[string]any{"type": "doc"}},
		map[string]string{syncproto.HeaderIdempotencyKey: "k"}); code != 400 || decode[syncproto.ErrorResponse](t, b).Fields["id"] == "" {
		t.Errorf("bad id = %d %s", code, b)
	}
	if code, b := c.do("PUT", "/v1/entries/"+newID(), map[string]any{"base_version": 0, "entry_date": "2026-02-30", "body": map[string]any{"type": "paragraph"}},
		map[string]string{syncproto.HeaderIdempotencyKey: "k2"}); code != 400 || len(decode[syncproto.ErrorResponse](t, b).Fields) != 2 {
		t.Errorf("bad date and body = %d %s", code, b)
	}
	if code, _ := c.do("PUT", "/v1/entries/"+newID(), []byte(`{"base_version":0,"body":{"type":"doc"},"extra":1}`),
		map[string]string{syncproto.HeaderIdempotencyKey: "k3"}); code != 400 {
		t.Errorf("unknown field = %d, want 400", code)
	}
	big := strings.Repeat("x", 70<<10)
	if code, _ := c.do("PUT", "/v1/entries/"+newID(), []byte(`{"base_version":0,"title":"`+big+`"}`),
		map[string]string{syncproto.HeaderIdempotencyKey: "k4"}); code != 413 {
		t.Errorf("too large = %d, want 413", code)
	}

	if code, b := c.do("GET", "/v1/entries/"+id, nil, nil); code != 200 || decode[model.Entry](t, b).Title != "Monday v2" {
		t.Errorf("get = %d %s", code, b)
	}
	if code, b := c.do("GET", "/v1/entries?from=2026-10-01&to=2026-10-31", nil, nil); code != 200 || len(decode[syncproto.EntriesResponse](t, b).Entries) != 1 {
		t.Errorf("range = %d %s", code, b)
	}
	if code, b := c.do("GET", "/v1/entries?recent=10", nil, nil); code != 200 || len(decode[syncproto.EntriesResponse](t, b).Entries) != 1 {
		t.Errorf("recent = %d %s", code, b)
	}
	if code, b := c.do("GET", "/v1/search?q=body", nil, nil); code != 200 || len(decode[syncproto.SearchResponse](t, b).Hits) != 1 {
		t.Errorf("search = %d %s", code, b)
	}

	// export
	code, b = c.do("GET", "/v1/export", nil, nil)
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if code != 200 || err != nil || len(zr.File) != 1 || zr.File[0].Name != "2026/2026-10-05 Monday v2.md" {
		t.Fatalf("export = %d, err %v", code, err)
	}

	// delete
	code, b = c.do("DELETE", "/v1/entries/"+id+"?base_version=2", nil, map[string]string{syncproto.HeaderIdempotencyKey: uuid.NewString()})
	if code != 200 || decode[model.Entry](t, b).DeletedAt == nil {
		t.Errorf("delete = %d %s", code, b)
	}
	if code, b := c.do("GET", "/v1/search?q=body", nil, nil); code != 200 || len(decode[syncproto.SearchResponse](t, b).Hits) != 0 {
		t.Errorf("search after delete = %s", b)
	}
}

func TestSyncPagingAndCursorAhead(t *testing.T) {
	srv := newServer(t, headerAuth{})
	c := client{t, srv.URL, "me@test"}
	for i := 0; i < 5; i++ {
		c.put(newID(), 0, fmt.Sprint("e", i), "")
	}
	var cursor int64
	var got int
	for pages := 0; pages < 10; pages++ {
		code, b := c.do("GET", fmt.Sprintf("/v1/sync?since=%d&limit=2", cursor), nil, nil)
		if code != 200 {
			t.Fatalf("sync = %d %s", code, b)
		}
		page := decode[syncproto.SyncResponse](t, b)
		got += len(page.Changes)
		cursor = page.Cursor
		if !page.HasMore {
			break
		}
	}
	if got != 5 {
		t.Errorf("paged %d changes, want 5", got)
	}
	code, b := c.do("GET", fmt.Sprintf("/v1/sync?since=%d", cursor+100), nil, nil)
	if code != 409 || decode[syncproto.ErrorResponse](t, b).Error != "cursor_ahead" {
		t.Errorf("cursor ahead = %d %s", code, b)
	}
	if code, _ := c.do("GET", "/v1/sync", nil, nil); code != 400 {
		t.Errorf("missing since = %d", code)
	}
}

func TestTwoDevicesOneConflict(t *testing.T) {
	// BACKEND.md §8.5: the laptop edits offline while the browser saves first.
	srv := newServer(t, headerAuth{})
	laptop := client{t, srv.URL, "me@test"}
	browser := client{t, srv.URL, "me@test"}
	id := newID()
	laptop.put(id, 0, "Monday", "")

	if code, _ := browser.put(id, 1, "Monday (browser)", ""); code != 200 {
		t.Fatal("browser save failed")
	}
	code, b := laptop.put(id, 1, "Monday (laptop)", "")
	if code != 409 {
		t.Fatalf("laptop = %d, want 409", code)
	}
	current := decode[syncproto.ErrorResponse](t, b).Current
	// the client keeps the server copy and saves its own text as a new entry
	copyID := newID()
	if code, _ := laptop.put(copyID, 0, "Monday (conflict copy)", ""); code != 200 {
		t.Fatal("conflict copy failed")
	}
	_, sb := browser.do("GET", "/v1/sync?since=0", nil, nil)
	changes := decode[syncproto.SyncResponse](t, sb).Changes
	if len(changes) != 2 || changes[0].Title != current.Title || changes[1].Title != "Monday (conflict copy)" {
		t.Errorf("both devices should see both entries, got %+v", changes)
	}
}

func TestUsersAreIsolated(t *testing.T) {
	srv := newServer(t, headerAuth{})
	a := client{t, srv.URL, "a@test"}
	b := client{t, srv.URL, "b@test"}
	id := newID()
	a.put(id, 0, "private", "")
	if code, _ := b.do("GET", "/v1/entries/"+id, nil, nil); code != 404 {
		t.Errorf("b reads a = %d", code)
	}
	if code, _ := b.put(id, 0, "hijack", ""); code != 403 {
		t.Errorf("b creates over a's id = %d, want 403", code)
	}
}

func TestEventsNotifyAfterWrite(t *testing.T) {
	srv := newServer(t, headerAuth{})
	c := client{t, srv.URL, "me@test"}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/events", nil)
	req.Header.Set("X-Test-Login", "me@test")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	lines := bufio.NewScanner(res.Body)
	expect := func(prefix string) string {
		t.Helper()
		for lines.Scan() {
			if strings.HasPrefix(lines.Text(), prefix) {
				return lines.Text()
			}
		}
		t.Fatalf("stream ended before %q: %v", prefix, lines.Err())
		return ""
	}
	expect("retry: 3000")
	expect(": ping") // keep-alive arrives

	_, b := c.put(newID(), 0, "hello", "")
	seq := decode[model.Entry](t, b).ServerSeq
	expect("event: changed")
	if data := expect("data: "); data != fmt.Sprintf(`data: {"cursor":%d}`, seq) {
		t.Errorf("data = %q, want cursor %d", data, seq)
	}
}

func TestPasswordMode(t *testing.T) {
	hash, _ := auth.HashPassword("correct horse")
	pw, _ := auth.NewPassword(hash, []byte("0123456789abcdef0123456789abcdef"))
	srv := newServer(t, pw)
	anon := client{t, srv.URL, ""}

	if code, _ := anon.do("POST", "/v1/auth/login", map[string]string{"password": "nope"}, nil); code != 401 {
		t.Errorf("wrong password = %d", code)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/v1/auth/login", strings.NewReader(`{"password":"correct horse"}`))
	req.Header.Set(syncproto.HeaderClient, "1")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("login = %v %v", res.StatusCode, err)
	}
	login := decode[syncproto.LoginResponse](t, mustRead(res))
	var cookie *http.Cookie
	for _, ck := range res.Cookies() {
		if ck.Name == syncproto.SessionCookie {
			cookie = ck
		}
	}
	if cookie == nil || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie = %+v", cookie)
	}

	// desktop: bearer token
	code, b := anon.do("GET", "/v1/me", nil, map[string]string{"Authorization": "Bearer " + login.Token})
	if code != 200 || decode[syncproto.MeResponse](t, b).Login != "owner" {
		t.Errorf("bearer me = %d %s", code, b)
	}
	// web: cookie
	req, _ = http.NewRequest("GET", srv.URL+"/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value})
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != 200 {
		t.Errorf("cookie me = %d", res.StatusCode)
	}
	res.Body.Close()
}

func TestLoginRouteMissingInTailscaleMode(t *testing.T) {
	srv := newServer(t, auth.Tailscale{Owner: "you@github"})
	if code, _ := (client{t, srv.URL, ""}).do("POST", "/v1/auth/login", map[string]string{"password": "x"}, nil); code != 404 {
		t.Errorf("login in tailscale mode = %d, want 404", code)
	}
}

func mustRead(res *http.Response) []byte {
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return b
}

func TestImagesAndRichExport(t *testing.T) {
	srv := newServer(t, headerAuth{})
	me := client{t, srv.URL, "me@test"}
	other := client{t, srv.URL, "other@test"}

	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	code, b := me.do("POST", "/v1/blobs", png, map[string]string{"Content-Type": "image/png"})
	blob := decode[syncproto.BlobResponse](t, b)
	if code != 200 || len(blob.Hash) != 64 || blob.URL != "/v1/blobs/"+blob.Hash {
		t.Fatalf("upload = %d %s", code, b)
	}
	if code, _ := me.do("POST", "/v1/blobs", []byte("<svg onload=alert(1)>"), nil); code != 400 {
		t.Errorf("svg upload = %d, want 400", code)
	}
	req, _ := http.NewRequest("GET", srv.URL+blob.URL, nil)
	req.Header.Set("X-Test-Login", "me@test")
	res, _ := http.DefaultClient.Do(req)
	got := mustRead(res)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/png" || !bytes.Equal(got, png) ||
		!strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("download = %d %s", res.StatusCode, res.Header)
	}
	if code, _ := other.do("GET", blob.URL, nil, nil); code != 404 {
		t.Errorf("other user download = %d, want 404", code)
	}

	// a database with one record that relates to a page with the image
	page, db, rec := newID(), newID(), newID()
	put := func(id string, body map[string]any) {
		t.Helper()
		if code, b := me.do("PUT", "/v1/entries/"+id, body, map[string]string{syncproto.HeaderIdempotencyKey: uuid.NewString()}); code != 200 {
			t.Fatalf("put %s = %d %s", id, code, b)
		}
	}
	put(page, map[string]any{"base_version": 0, "title": "Whiteboard", "body": map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "image", "attrs": map[string]any{"src": blob.URL, "alt": "sketch"}}}}})
	put(db, map[string]any{"base_version": 0, "kind": "database", "title": "Tasks", "body": map[string]any{"type": "doc"},
		"meta": map[string]any{"schema": map[string]any{"properties": []any{
			map[string]any{"id": "p_status", "name": "Status", "type": "select", "options": []any{map[string]any{"id": "opt_done", "name": "Done"}}},
			map[string]any{"id": "p_rel", "name": "Related", "type": "relation"}}}}})
	put(rec, map[string]any{"base_version": 0, "parent_id": db, "title": "Draw diagram", "body": map[string]any{"type": "doc"},
		"meta": map[string]any{"props": map[string]any{"p_status": "opt_done", "p_rel": []string{page}}}})

	if code, b := me.do("GET", "/v1/entries?parent="+db, nil, nil); code != 200 || len(decode[syncproto.EntriesResponse](t, b).Entries) != 1 {
		t.Errorf("records = %d %s", code, b)
	}
	if code, b := me.do("GET", "/v1/entries?pages=1", nil, nil); code != 200 || len(decode[syncproto.EntriesResponse](t, b).Entries) != 2 {
		t.Errorf("root pages = %d %s", code, b)
	}
	if code, b := me.do("GET", "/v1/entries/"+page+"/backlinks", nil, nil); code != 200 ||
		decode[syncproto.EntriesResponse](t, b).Entries[0].ID != rec {
		t.Errorf("backlinks = %d %s", code, b)
	}
	if code, b := me.do("PUT", "/v1/entries/"+newID(), map[string]any{"base_version": 0, "kind": "spreadsheet", "body": map[string]any{"type": "doc"}},
		map[string]string{syncproto.HeaderIdempotencyKey: "k"}); code != 400 || decode[syncproto.ErrorResponse](t, b).Fields["kind"] == "" {
		t.Errorf("bad kind = %d %s", code, b)
	}

	code, b = me.do("GET", "/v1/export", nil, nil)
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if code != 200 || err != nil {
		t.Fatalf("export = %d %v", code, err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		data, _ := io.ReadAll(rc)
		rc.Close()
		files[f.Name] = string(data)
	}
	if !strings.Contains(files["pages/Whiteboard.md"], "![sketch](../assets/"+blob.Hash+")") {
		t.Errorf("page markdown = %q", files["pages/Whiteboard.md"])
	}
	if files["assets/"+blob.Hash] != string(png) {
		t.Error("image missing from export")
	}
	recMD := files["databases/Tasks/Draw diagram.md"]
	if !strings.Contains(recMD, "- **Status:** Done") || !strings.Contains(recMD, "- **Related:** [[Whiteboard]]") {
		t.Errorf("record markdown = %q (files %v)", recMD, len(files))
	}
}
