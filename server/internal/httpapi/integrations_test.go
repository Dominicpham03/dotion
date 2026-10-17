package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"diary/server/internal/adapters/google"
	"diary/server/internal/adapters/memnotifier"
	"diary/server/internal/adapters/sqlitestore"
	"diary/server/internal/core"
	"diary/server/internal/httpapi"
	"diary/shared/model"
	"diary/shared/syncproto"
)

// fakeGitLab is an in-memory GitLab with one user and a few assigned items.
type fakeGitLab struct {
	mu     sync.Mutex
	token  string
	issues []core.GitLabItem
	mrs    []core.GitLabItem
	closed map[int64]bool // issue iid → closed by Dotion
}

func (f *fakeGitLab) User(_ context.Context, base, token string) (string, error) {
	if token != f.token {
		return "", core.ErrGrantRevoked
	}
	return "dom", nil
}

func (f *fakeGitLab) Issues(context.Context, string, string, time.Time) ([]core.GitLabItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]core.GitLabItem(nil), f.issues...), nil
}

func (f *fakeGitLab) MergeRequests(context.Context, string, string, time.Time) ([]core.GitLabItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]core.GitLabItem(nil), f.mrs...), nil
}

func (f *fakeGitLab) SetIssueState(_ context.Context, _, _ string, _ int64, iid int64, closed bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed[iid] = closed
	for i := range f.issues {
		if f.issues[i].IID == iid {
			f.issues[i].State = map[bool]string{true: "closed", false: "opened"}[closed]
		}
	}
	return nil
}

func newIntegrationServer(t *testing.T, gl core.GitLabAPI, drive bool) (*httptest.Server, *sqlitestore.Store) {
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
	glService := core.NewGitLabService(entries, store, store, gl)
	deps := httpapi.Deps{
		Entries: entries, Sync: core.NewSyncService(store), Notifier: n, Auth: headerAuth{}, Users: store, Blobs: store,
		Integrations: store, GitLab: glService, Version: "test", PublicURL: "https://dotion.example.ts.net",
	}
	if drive {
		var revoked = &atomicBool{}
		g := fakeGoogleWithDrive(t, revoked)
		c := google.New("client-id", "secret")
		c.AuthEndpoint, c.TokenEndpoint, c.RevokeEndpoint, c.APIBase, c.DriveBase = g.URL+"/auth", g.URL+"/token", g.URL+"/revoke", g.URL+"/calendar/v3", g.URL+"/drive/v3"
		deps.Calendar, deps.Drive = c, c
	}
	srv := httptest.NewServer(httpapi.New(deps))
	t.Cleanup(func() { n.CloseAll(); srv.Close() })
	return srv, store
}

type atomicBool struct {
	mu sync.Mutex
	v  bool
}

func TestGitLabTwoWaySync(t *testing.T) {
	gl := &fakeGitLab{
		token:  "glpat-good",
		closed: map[int64]bool{},
		issues: []core.GitLabItem{
			{Kind: "issue", GlobalID: 101, ProjectID: 7, IID: 12, Title: "Fix login redirect", Description: "Users land on /\n\nRepro: sign out.", State: "opened",
				URL: "https://gitlab.example/acme/web/-/issues/12", Due: "2026-10-20", Labels: []string{"bug", "auth"}, Ref: "acme/web#12", Project: "acme/web"},
			{Kind: "issue", GlobalID: 102, ProjectID: 8, IID: 3, Title: "Write runbook", State: "closed", URL: "https://gitlab.example/acme/ops/-/issues/3", Ref: "acme/ops#3", Project: "acme/ops"},
		},
		mrs: []core.GitLabItem{
			{Kind: "mr", GlobalID: 501, ProjectID: 7, IID: 40, Title: "Add SSO", State: "merged", URL: "https://gitlab.example/acme/web/-/merge_requests/40", Ref: "acme/web!40", Project: "acme/web"},
		},
	}
	srv, store := newIntegrationServer(t, gl, false)
	me := client{t, srv.URL, "me@test"}

	if code, b := me.do("GET", "/v1/integrations/gitlab", nil, nil); code != 200 || decode[syncproto.GitLabStatus](t, b).Connected {
		t.Fatalf("status before = %d %s", code, b)
	}
	if code, b := me.do("POST", "/v1/integrations/gitlab", map[string]string{"url": "https://gitlab.example", "token": "wrong"}, nil); code != 400 ||
		!strings.Contains(string(b), "didn't accept") {
		t.Errorf("bad token = %d %s", code, b)
	}
	code, b := me.do("POST", "/v1/integrations/gitlab", map[string]string{"url": "https://gitlab.example/", "token": "glpat-good"}, nil)
	st := decode[syncproto.GitLabStatus](t, b)
	if code != 200 || !st.Connected || st.Username != "dom" || st.URL != "https://gitlab.example" || st.DatabaseID == "" || st.LastSync == "" {
		t.Fatalf("connect = %d %s", code, b)
	}

	// The GitLab database and its three records.
	_, b = me.do("GET", "/v1/entries/"+st.DatabaseID, nil, nil)
	db := decode[model.Entry](t, b)
	if db.Kind != model.KindDatabase || db.Title != "GitLab" || !strings.Contains(string(db.Meta), "acme/web") || !strings.Contains(string(db.Meta), `"name":"bug"`) {
		t.Fatalf("database = %+v", db)
	}
	_, b = me.do("GET", "/v1/entries?parent="+st.DatabaseID, nil, nil)
	records := decode[syncproto.EntriesResponse](t, b).Entries
	if len(records) != 3 {
		t.Fatalf("records = %d", len(records))
	}
	byTitle := map[string]model.Entry{}
	for _, r := range records {
		byTitle[r.Title] = r
	}
	login := byTitle["Fix login redirect"]
	if !strings.Contains(string(login.Meta), `"p_gl_status":"opt_glopen"`) || !strings.Contains(string(login.Meta), `"p_gl_due":"2026-10-20"`) ||
		!strings.Contains(string(login.Body), "Repro: sign out.") {
		t.Errorf("issue record = %s %s", login.Meta, login.Body)
	}
	if !strings.Contains(string(byTitle["Write runbook"].Meta), "opt_gldone") || !strings.Contains(string(byTitle["Add SSO"].Meta), "opt_glmerged") {
		t.Error("closed issue / merged MR mapped wrong")
	}

	// A second sync with nothing new changes nothing.
	_, b = me.do("POST", "/v1/integrations/gitlab/sync", nil, nil)
	if r := decode[syncproto.GitLabSyncResponse](t, b); r.Created != 0 || r.Updated != 0 || r.Pushed != 0 {
		t.Errorf("idle sync = %+v", r)
	}

	// Mark the issue Done in Dotion (as the table view would): it closes in GitLab.
	var meta map[string]any
	_ = json.Unmarshal(login.Meta, &meta)
	meta["props"].(map[string]any)["p_gl_status"] = "opt_gldone"
	if code, b := me.do("PUT", "/v1/entries/"+login.ID, map[string]any{
		"base_version": login.Version, "parent_id": st.DatabaseID, "title": login.Title, "body": json.RawMessage(login.Body), "meta": meta,
	}, map[string]string{syncproto.HeaderIdempotencyKey: uuid.NewString()}); code != 200 {
		t.Fatalf("mark done = %d %s", code, b)
	}
	_, b = me.do("POST", "/v1/integrations/gitlab/sync", nil, nil)
	if r := decode[syncproto.GitLabSyncResponse](t, b); r.Pushed != 1 {
		t.Errorf("sync after Done = %s", b)
	}
	gl.mu.Lock()
	closed := gl.closed[12]
	gl.mu.Unlock()
	if !closed {
		t.Error("issue was not closed in GitLab")
	}

	// GitLab changes flow back: a new title arrives on the next sync.
	gl.mu.Lock()
	gl.issues[0].Title = "Fix login redirect (SSO)"
	gl.mu.Unlock()
	_, b = me.do("POST", "/v1/integrations/gitlab/sync", nil, nil)
	if r := decode[syncproto.GitLabSyncResponse](t, b); r.Updated != 1 {
		t.Errorf("sync after GitLab edit = %s", b)
	}
	if e, err := store.GetEntry(context.Background(), recordOwner(t, store), login.ID); err != nil || e.Title != "Fix login redirect (SSO)" {
		t.Errorf("record after GitLab edit = %q %v", e.Title, err)
	}

	if code, _ := me.do("DELETE", "/v1/integrations/gitlab", nil, nil); code != 204 {
		t.Errorf("disconnect = %d", code)
	}
	if _, b := me.do("GET", "/v1/integrations/gitlab", nil, nil); decode[syncproto.GitLabStatus](t, b).Connected {
		t.Error("still connected")
	}
}

func recordOwner(t *testing.T, store *sqlitestore.Store) string {
	t.Helper()
	id, err := store.EnsureUser(context.Background(), "me@test")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func fakeGoogleWithDrive(t *testing.T, _ *atomicBool) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		if r.Form.Get("grant_type") == "authorization_code" {
			io.WriteString(w, `{"access_token":"at1","expires_in":3600,"refresh_token":"rt1","id_token":"x.eyJlbWFpbCI6InlvdUBnbWFpbC5jb20ifQ.y",
				"scope":"openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly"}`)
			return
		}
		io.WriteString(w, `{"access_token":"at2","expires_in":3600}`)
	})
	mux.HandleFunc("GET /drive/v3/files", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if !strings.Contains(q, "trashed = false") {
			t.Errorf("query without trashed filter: %s", q)
		}
		if strings.Contains(q, "budget") {
			io.WriteString(w, `{"files":[{"id":"doc1","name":"Budget 2027","mimeType":"application/vnd.google-apps.document","modifiedTime":"2026-10-01T10:00:00Z","webViewLink":"https://docs.google.com/document/d/doc1","owners":[{"displayName":"Dom"}]}]}`)
			return
		}
		io.WriteString(w, `{"files":[{"id":"pdf1","name":"Lease.pdf","mimeType":"application/pdf","modifiedTime":"2026-10-02T10:00:00Z","webViewLink":"https://drive.google.com/file/d/pdf1"}],"nextPageToken":"p2"}`)
	})
	mux.HandleFunc("GET /drive/v3/files/{id}", func(w http.ResponseWriter, r *http.Request) {
		mime := map[string]string{"doc1": "application/vnd.google-apps.document", "pdf1": "application/pdf"}[r.PathValue("id")]
		io.WriteString(w, `{"name":"`+map[string]string{"doc1": "Budget 2027", "pdf1": "Lease.pdf"}[r.PathValue("id")]+`","mimeType":"`+mime+`"}`)
	})
	mux.HandleFunc("GET /drive/v3/files/{id}/export", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("mimeType") != "text/markdown" {
			t.Errorf("export type %s", r.URL.Query().Get("mimeType"))
		}
		io.WriteString(w, "# Budget 2027\n\n- Rent\n- Food\n")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestGoogleDrive(t *testing.T) {
	srv, _ := newIntegrationServer(t, &fakeGitLab{closed: map[int64]bool{}}, true)
	me := client{t, srv.URL, "me@test"}

	// Not connected yet: Drive answers "not connected", never an error.
	if _, b := me.do("GET", "/v1/drive/files", nil, nil); decode[syncproto.DriveFilesResponse](t, b).Connected {
		t.Error("drive connected before sign-in")
	}

	// Connect Google (the grant includes Drive).
	_, b := me.do("POST", "/v1/integrations/google/start", map[string]string{"client": "web"}, nil)
	u := decode[map[string]string](t, b)["url"]
	state := u[strings.Index(u, "state=")+6:]
	if i := strings.Index(state, "&"); i > 0 {
		state = state[:i]
	}
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := noRedirect.Get(srv.URL + "/v1/integrations/google/callback?code=c&state=" + state)
	if err != nil || res.StatusCode != http.StatusSeeOther {
		t.Fatalf("callback = %v %v", res.StatusCode, err)
	}
	res.Body.Close()
	if _, b := me.do("GET", "/v1/integrations/google", nil, nil); decode[syncproto.GoogleStatus](t, b).Drive != true {
		t.Errorf("status = %s", b)
	}

	_, b = me.do("GET", "/v1/drive/files", nil, nil)
	recent := decode[syncproto.DriveFilesResponse](t, b)
	if !recent.Connected || len(recent.Files) != 1 || recent.Files[0].Name != "Lease.pdf" || recent.Next != "p2" || recent.Files[0].CanImport {
		t.Errorf("recent files = %s", b)
	}
	_, b = me.do("GET", "/v1/drive/files?q=budget", nil, nil)
	found := decode[syncproto.DriveFilesResponse](t, b)
	if len(found.Files) != 1 || !found.Files[0].CanImport || found.Files[0].Owner != "Dom" {
		t.Errorf("search = %s", b)
	}
	code, b := me.do("GET", "/v1/drive/files/doc1/markdown", nil, nil)
	md := decode[syncproto.DriveMarkdownResponse](t, b)
	if code != 200 || md.Name != "Budget 2027" || !strings.Contains(md.Markdown, "- Rent") {
		t.Errorf("import = %d %s", code, b)
	}
	if code, _ := me.do("GET", "/v1/drive/files/pdf1/markdown", nil, nil); code != 400 {
		t.Errorf("importing a PDF = %d, want 400", code)
	}
}
