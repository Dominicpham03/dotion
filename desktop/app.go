package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"diary/desktop/internal/api"
	"diary/desktop/internal/localdb"
	"diary/desktop/internal/secrets"
	"diary/desktop/internal/syncclient"
	"diary/shared/model"
	"diary/shared/prosemirror"
	"diary/shared/syncproto"
)

// App holds the methods exposed to the UI through Wails. Every call is a
// local SQLite operation; only Connect/SignIn touch the network directly.
type App struct {
	ctx     context.Context
	cancel  context.CancelFunc
	db      *localdb.DB
	engine  *syncclient.Engine
	secrets secrets.Store
}

func NewApp() *App { return &App{secrets: secrets.Keychain{}} }

// ---- types the UI sees (camelCase, matching ui/src/platform/types.ts) -----

type UIEntry struct {
	ID        string          `json:"id"`
	EntryDate *string         `json:"entryDate"`
	Kind      string          `json:"kind"`
	ParentID  *string         `json:"parentId"`
	Title     string          `json:"title"`
	Body      json.RawMessage `json:"body"`
	Meta      json.RawMessage `json:"meta"`
	Version   int             `json:"version"`
	UpdatedAt string          `json:"updatedAt"`
	DeletedAt *string         `json:"deletedAt"`
}

type UISummary struct {
	ID        string  `json:"id"`
	EntryDate *string `json:"entryDate"`
	Kind      string  `json:"kind"`
	ParentID  *string `json:"parentId"`
	Icon      string  `json:"icon"`
	Title     string  `json:"title"`
	Preview   string  `json:"preview"`
	Words     int     `json:"words"`
	UpdatedAt string  `json:"updatedAt"`
}

type UIDraft struct {
	ID        string          `json:"id"`
	EntryDate *string         `json:"entryDate"`
	Kind      string          `json:"kind"`
	ParentID  *string         `json:"parentId"`
	Title     string          `json:"title"`
	Body      json.RawMessage `json:"body"`
	Meta      json.RawMessage `json:"meta"`
}

type UISaveResult struct {
	Status string   `json:"status"` // "queued"
	Entry  *UIEntry `json:"entry"`
}

type UISearchHit struct {
	ID        string  `json:"id"`
	EntryDate *string `json:"entryDate"`
	Title     string  `json:"title"`
	Snippet   string  `json:"snippet"`
}

type Settings struct {
	ServerURL  string            `json:"serverUrl"`
	Login      string            `json:"login"`
	LastSyncAt string            `json:"lastSyncAt"`
	Pending    int               `json:"pending"`
	Status     syncclient.Status `json:"status"`
	DataPath   string            `json:"dataPath"`
}

type ConnectResult struct {
	OK            bool   `json:"ok"`
	NeedsPassword bool   `json:"needsPassword"`
	Login         string `json:"login"`
	Message       string `json:"message"`
}

type ConflictEvent struct {
	ID     string `json:"id"`
	CopyID string `json:"copyId"`
}

func toUI(e *model.Entry) *UIEntry {
	if e == nil {
		return nil
	}
	u := &UIEntry{ID: e.ID, EntryDate: e.EntryDate, Kind: e.Kind, ParentID: e.ParentID, Title: e.Title,
		Body: e.Body, Meta: e.Meta, Version: e.Version,
		UpdatedAt: e.UpdatedAt.UTC().Format(time.RFC3339)}
	if e.DeletedAt != nil {
		s := e.DeletedAt.UTC().Format(time.RFC3339)
		u.DeletedAt = &s
	}
	return u
}

func toSummaries(list []model.Entry) []UISummary {
	out := make([]UISummary, 0, len(list))
	for _, e := range list {
		out = append(out, UISummary{ID: e.ID, EntryDate: e.EntryDate, Kind: e.Kind, ParentID: e.ParentID,
			Icon: icon(e.Meta), Title: e.Title,
			Preview: preview(e.Body), Words: len(strings.Fields(prosemirror.ExtractText(e.Body))),
			UpdatedAt: e.UpdatedAt.UTC().Format(time.RFC3339)})
	}
	return out
}

func icon(meta json.RawMessage) string {
	var m struct {
		Icon string `json:"icon"`
	}
	_ = json.Unmarshal(meta, &m)
	return m.Icon
}

func preview(body json.RawMessage) string {
	text := strings.Join(strings.Fields(prosemirror.ExtractText(body)), " ")
	if utf8.RuneCountInString(text) > 140 {
		text = string([]rune(text)[:140]) + "…"
	}
	return text
}

// ---- lifecycle --------------------------------------------------------------

func dataPath() (string, error) {
	dir, err := os.UserConfigDir() // %APPDATA% on Windows
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Dotion", "dotion.db"), nil
}

// startup opens SQLite, runs local migrations and starts the sync engine.
func (a *App) startup(ctx context.Context) {
	a.ctx, a.cancel = context.WithCancel(ctx)
	path, err := dataPath()
	if err == nil {
		a.db, err = localdb.Open(path)
	}
	if err != nil {
		runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
			Type: runtime.ErrorDialog, Title: "Dotion can't open its data",
			Message: fmt.Sprintf("The local database could not be opened: %v", err),
		})
		runtime.Quit(ctx)
		return
	}
	a.engine = syncclient.New(a.db, a.syncConfig)
	a.engine.OnChanged = func(ids []string) { runtime.EventsEmit(a.ctx, "entries:changed", ids) }
	a.engine.OnStatus = func(s syncclient.Status) { runtime.EventsEmit(a.ctx, "sync:status", s) }
	a.engine.OnConflict = func(id, copyID string) {
		runtime.EventsEmit(a.ctx, "conflict:created", ConflictEvent{ID: id, CopyID: copyID})
	}
	a.engine.OnBlobs = func(h []string) { runtime.EventsEmit(a.ctx, "blobs:downloaded", h) }
	go a.engine.Run(a.ctx)
}

// beforeClose asks the UI to flush autosave, then gives the engine up to 3 s
// to push. Anything left stays in the outbox for the next launch.
func (a *App) beforeClose(ctx context.Context) bool {
	if a.engine == nil {
		return false
	}
	runtime.EventsEmit(ctx, "app:flush")
	time.Sleep(300 * time.Millisecond) // the UI's flush is a local write
	a.engine.Flush(context.Background(), 3*time.Second)
	return false
}

func (a *App) shutdown(context.Context) {
	if a.cancel != nil {
		a.cancel()
	}
	if a.db != nil {
		a.db.Close()
	}
}

func (a *App) syncConfig(ctx context.Context) (syncclient.Config, bool) {
	u, err := a.db.State(ctx, localdb.KeyServerURL)
	if err != nil || u == "" {
		return syncclient.Config{}, false
	}
	token, _ := a.secrets.Get(u)
	return syncclient.Config{ServerURL: u, Token: token}, true
}

// ---- reads -------------------------------------------------------------------

func (a *App) GetEntry(id string) (*UIEntry, error) {
	e, err := a.db.GetEntry(a.ctx, id)
	return toUI(e), err
}

func (a *App) GetEntryForDate(date string) (*UIEntry, error) {
	e, err := a.db.GetEntryForDate(a.ctx, date)
	return toUI(e), err
}

func (a *App) ListRange(from, to string) ([]UISummary, error) {
	list, err := a.db.ListRange(a.ctx, from, to)
	return toSummaries(list), err
}

func (a *App) ListRecent(limit int) ([]UISummary, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	list, err := a.db.ListRecent(a.ctx, limit)
	return toSummaries(list), err
}

func (a *App) Search(query string) ([]UISearchHit, error) {
	hits, err := a.db.Search(a.ctx, query, 50)
	out := make([]UISearchHit, 0, len(hits))
	for _, h := range hits {
		out = append(out, UISearchHit{ID: h.ID, EntryDate: h.EntryDate, Title: h.Title, Snippet: h.Snippet})
	}
	return out, err
}

// ---- writes ------------------------------------------------------------------

// SaveEntry writes SQLite and the outbox, then returns at once; the sync
// engine sends it later. baseVersion is ignored: the outbox tracks it.
func (a *App) SaveEntry(d UIDraft, _ int) (UISaveResult, error) {
	e, err := a.db.SaveLocal(a.ctx, localdb.Draft{ID: d.ID, EntryDate: d.EntryDate, Kind: d.Kind, ParentID: d.ParentID,
		Title: d.Title, Body: d.Body, Meta: d.Meta})
	if err != nil {
		return UISaveResult{}, err
	}
	a.engine.Nudge()
	return UISaveResult{Status: "queued", Entry: toUI(&e)}, nil
}

func (a *App) DeleteEntry(id string, _ int) error {
	if err := a.db.DeleteLocal(a.ctx, id); err != nil {
		return err
	}
	a.engine.Nudge()
	runtime.EventsEmit(a.ctx, "entries:changed", []string{id})
	return nil
}

// ---- connection and settings ---------------------------------------------

func (a *App) GetSettings() (Settings, error) {
	s := Settings{Status: a.engine.Status()}
	s.ServerURL, _ = a.db.State(a.ctx, localdb.KeyServerURL)
	s.Login, _ = a.db.State(a.ctx, localdb.KeyLogin)
	s.LastSyncAt, _ = a.db.State(a.ctx, localdb.KeyLastSyncAt)
	s.Pending, _ = a.db.PendingCount(a.ctx)
	s.DataPath, _ = dataPath()
	return s, nil
}

func (a *App) GetSyncStatus() syncclient.Status { return a.engine.Status() }

func normalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw != "" && !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("Enter an address like https://dotion.your-tailnet.ts.net")
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host+u.Path, "/"), nil
}

// Connect tests a server address: health first, then who we are. In
// password mode it reports that a password is needed.
func (a *App) Connect(serverURL string) ConnectResult {
	u, err := normalizeURL(serverURL)
	if err != nil {
		return ConnectResult{Message: err.Error()}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	token, _ := a.secrets.Get(u)
	client := api.New(u, token)
	if err := client.Health(ctx); err != nil {
		return ConnectResult{Message: "Can't reach this address. Check that Tailscale is running on this computer."}
	}
	me, err := client.Me(ctx)
	var ae *api.Error
	if errors.As(err, &ae) && ae.Status == 401 {
		return ConnectResult{NeedsPassword: true, Message: "This diary needs its password."}
	}
	if errors.As(err, &ae) && ae.Status == 403 {
		return ConnectResult{Message: "This server belongs to a different Tailscale account."}
	}
	if err != nil {
		return ConnectResult{Message: "The server answered, but sign-in failed: " + err.Error()}
	}
	return a.finishConnect(u, me.Login)
}

// SignIn exchanges the password for a token kept in the OS keychain.
func (a *App) SignIn(serverURL, password string) ConnectResult {
	u, err := normalizeURL(serverURL)
	if err != nil {
		return ConnectResult{Message: err.Error()}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	res, err := api.New(u, "").Login(ctx, password)
	var ae *api.Error
	switch {
	case errors.As(err, &ae) && ae.Status == 401:
		return ConnectResult{NeedsPassword: true, Message: "That password is not right."}
	case errors.As(err, &ae) && ae.Status == 429:
		return ConnectResult{NeedsPassword: true, Message: "Too many attempts. Wait a minute and try again."}
	case err != nil:
		return ConnectResult{NeedsPassword: true, Message: "Sign-in failed: " + err.Error()}
	}
	if err := a.secrets.Set(u, res.Token); err != nil {
		return ConnectResult{Message: "Signed in, but the token could not be saved in the system keychain: " + err.Error()}
	}
	return a.finishConnect(u, res.Login)
}

func (a *App) finishConnect(u, login string) ConnectResult {
	prev, _ := a.db.State(a.ctx, localdb.KeyServerURL)
	if prev != u {
		_ = a.db.DeleteState(a.ctx, localdb.KeyCursor) // a different server: pull everything
	}
	_ = a.db.SetState(a.ctx, localdb.KeyServerURL, u)
	_ = a.db.SetState(a.ctx, localdb.KeyLogin, login)
	a.engine.Reconfigure()
	return ConnectResult{OK: true, Login: login}
}

// Disconnect stops syncing and forgets the token. Local entries stay.
func (a *App) Disconnect() error {
	u, _ := a.db.State(a.ctx, localdb.KeyServerURL)
	if u != "" {
		_ = a.secrets.Delete(u)
	}
	if err := a.db.DeleteState(a.ctx, localdb.KeyServerURL, localdb.KeyLogin, localdb.KeyCursor, localdb.KeyLastSyncAt); err != nil {
		return err
	}
	a.engine.Reconfigure()
	return nil
}

func (a *App) SyncNow() { a.engine.Nudge() }

// ---- pages, databases, links, images -------------------------------------

// ListChildren returns full entries: database views need every record's properties.
func (a *App) ListChildren(parentID string) ([]UIEntry, error) {
	list, err := a.db.ListChildren(a.ctx, parentID)
	out := make([]UIEntry, 0, len(list))
	for i := range list {
		out = append(out, *toUI(&list[i]))
	}
	return out, err
}

func (a *App) ListPages() ([]UISummary, error) {
	list, err := a.db.ListRootPages(a.ctx)
	return toSummaries(list), err
}

func (a *App) Backlinks(id string) ([]UISummary, error) {
	list, err := a.db.Backlinks(a.ctx, id)
	return toSummaries(list), err
}

// UploadImage stores an image on this computer and queues it for the server.
// The returned src ("/v1/blobs/<hash>") works offline through blobHandler.
func (a *App) UploadImage(dataBase64 string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return "", errors.New("the image could not be read")
	}
	if len(data) > maxImageBytes {
		return "", errors.New("images can be at most 10 MB")
	}
	ct := http.DetectContentType(data)
	if !imageTypes[ct] {
		return "", errors.New("only PNG, JPEG, GIF and WebP images can be added")
	}
	hash, err := a.db.PutBlob(a.ctx, data, ct, false)
	if err != nil {
		return "", err
	}
	a.engine.Nudge()
	return prosemirror.BlobPrefix + hash, nil
}

const maxImageBytes = 10 << 20

var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// blobHandler serves cached images to the WebView at the same paths the web
// app uses, so documents render identically and offline.
func (a *App) blobHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash := prosemirror.BlobHash(r.URL.Path)
		if hash == "" || a.db == nil {
			http.NotFound(w, r)
			return
		}
		ct, err := a.db.BlobType(r.Context(), hash)
		if err != nil || ct == "" {
			http.NotFound(w, r) // not downloaded yet; the next sync fetches it
			return
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, a.db.BlobPath(hash))
	})
}

// ---- Google Calendar (through the diary server) ---------------------------

type UICalendarStatus struct {
	Configured    bool   `json:"configured"`
	Connected     bool   `json:"connected"`
	Email         string `json:"email"`
	RedirectURI   string `json:"redirectUri"`
	Drive         bool   `json:"drive"`
	CalendarWrite bool   `json:"calendarWrite"`
	Offline       bool   `json:"offline"` // the server couldn't be reached
}

type UIEvents struct {
	Connected bool                      `json:"connected"`
	Events    []syncproto.CalendarEvent `json:"events"`
	Stale     bool                      `json:"stale"` // from the cache: the server couldn't be reached
}

func (a *App) client(ctx context.Context) (*api.Client, bool) {
	cfg, ok := a.syncConfig(ctx)
	if !ok {
		return nil, false
	}
	return api.New(cfg.ServerURL, cfg.Token), true
}

func (a *App) CalendarStatus() UICalendarStatus {
	c, ok := a.client(a.ctx)
	if !ok {
		return UICalendarStatus{Offline: true}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	st, err := c.GoogleStatus(ctx)
	if err != nil {
		return UICalendarStatus{Offline: true}
	}
	return UICalendarStatus{Configured: st.Configured, Connected: st.Connected, Email: st.Email, RedirectURI: st.RedirectURI, Drive: st.Drive, CalendarWrite: st.CalendarWrite}
}

// CalendarConnect opens Google's sign-in in the system browser. The UI then
// polls CalendarStatus until the connection appears.
func (a *App) CalendarConnect() error {
	c, ok := a.client(a.ctx)
	if !ok {
		return errors.New("connect this app to your diary server first")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	u, err := c.GoogleStart(ctx)
	if err != nil {
		return err
	}
	runtime.BrowserOpenURL(a.ctx, u)
	return nil
}

func (a *App) CalendarDisconnect() error {
	c, ok := a.client(a.ctx)
	if !ok {
		return errors.New("connect this app to your diary server first")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	return c.GoogleDisconnect(ctx)
}

// CalendarEvents asks the server, and keeps the answer so the same range
// still shows offline.
func (a *App) CalendarEvents(start, end string) (UIEvents, error) {
	key := "events:" + start + "|" + end
	if c, ok := a.client(a.ctx); ok {
		ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
		defer cancel()
		if r, err := c.CalendarEvents(ctx, start, end); err == nil {
			if b, err := json.Marshal(r); err == nil {
				_ = a.db.SetState(a.ctx, key, string(b))
			}
			return UIEvents{Connected: r.Connected, Events: r.Events}, nil
		}
	}
	cached, _ := a.db.State(a.ctx, key)
	var r syncproto.EventsResponse
	if cached == "" || json.Unmarshal([]byte(cached), &r) != nil {
		return UIEvents{Events: []syncproto.CalendarEvent{}, Stale: true}, nil
	}
	return UIEvents{Connected: r.Connected, Events: r.Events, Stale: true}, nil
}

// ---- Google Drive and GitLab (through the Dotion server; online only) ----

type UIDriveFiles struct {
	Connected bool                  `json:"connected"`
	Files     []syncproto.DriveFile `json:"files"`
	Next      string                `json:"next"`
}

func (a *App) serverCall(timeout time.Duration) (*api.Client, context.Context, context.CancelFunc, error) {
	c, ok := a.client(a.ctx)
	if !ok {
		return nil, nil, nil, errors.New("connect this app to your Dotion server first")
	}
	ctx, cancel := context.WithTimeout(a.ctx, timeout)
	return c, ctx, cancel, nil
}

func (a *App) DriveSearch(query, page string) (UIDriveFiles, error) {
	c, ctx, cancel, err := a.serverCall(20 * time.Second)
	if err != nil {
		return UIDriveFiles{Files: []syncproto.DriveFile{}}, nil
	}
	defer cancel()
	r, err := c.DriveSearch(ctx, query, page)
	if err != nil {
		return UIDriveFiles{}, err
	}
	if r.Files == nil {
		r.Files = []syncproto.DriveFile{}
	}
	return UIDriveFiles{Connected: r.Connected, Files: r.Files, Next: r.Next}, nil
}

func (a *App) DriveMarkdown(id string) (syncproto.DriveMarkdownResponse, error) {
	c, ctx, cancel, err := a.serverCall(30 * time.Second)
	if err != nil {
		return syncproto.DriveMarkdownResponse{}, err
	}
	defer cancel()
	return c.DriveMarkdown(ctx, id)
}

func (a *App) GitLabStatus() (syncproto.GitLabStatus, error) {
	c, ctx, cancel, err := a.serverCall(10 * time.Second)
	if err != nil {
		return syncproto.GitLabStatus{}, nil
	}
	defer cancel()
	return c.GitLabStatus(ctx)
}

func (a *App) GitLabConnect(baseURL, token string) (syncproto.GitLabStatus, error) {
	c, ctx, cancel, err := a.serverCall(90 * time.Second) // the first sync runs during connect
	if err != nil {
		return syncproto.GitLabStatus{}, err
	}
	defer cancel()
	st, err := c.GitLabConnect(ctx, baseURL, token)
	a.engine.Nudge()
	return st, err
}

func (a *App) GitLabSync() (syncproto.GitLabSyncResponse, error) {
	c, ctx, cancel, err := a.serverCall(90 * time.Second)
	if err != nil {
		return syncproto.GitLabSyncResponse{}, err
	}
	defer cancel()
	r, err := c.GitLabSync(ctx)
	a.engine.Nudge()
	return r, err
}

func (a *App) GitLabDisconnect() error {
	c, ctx, cancel, err := a.serverCall(10 * time.Second)
	if err != nil {
		return err
	}
	defer cancel()
	return c.GitLabDisconnect(ctx)
}

// ---- Gemini assistant and action items (through the Dotion server; online only) ----

func (a *App) AIStatus() (syncproto.AIStatus, error) {
	c, ctx, cancel, err := a.serverCall(10 * time.Second)
	if err != nil {
		return syncproto.AIStatus{}, nil
	}
	defer cancel()
	st, err := c.AIStatus(ctx)
	if err != nil {
		return syncproto.AIStatus{}, nil // offline: the assistant is unavailable
	}
	return st, nil
}

func (a *App) AIChat(req syncproto.AIChatRequest) (syncproto.AIChatResponse, error) {
	c, ctx, cancel, err := a.serverCall(3 * time.Minute)
	if err != nil {
		return syncproto.AIChatResponse{}, err
	}
	defer cancel()
	return c.AIChat(ctx, req)
}

func (a *App) ActionsStatus() (syncproto.ActionsStatus, error) {
	c, ctx, cancel, err := a.serverCall(10 * time.Second)
	if err != nil {
		return syncproto.ActionsStatus{}, err
	}
	defer cancel()
	return c.ActionsStatus(ctx)
}

func (a *App) ActionsConfigure(enabled bool, names []string) (syncproto.ActionsStatus, error) {
	c, ctx, cancel, err := a.serverCall(10 * time.Second)
	if err != nil {
		return syncproto.ActionsStatus{}, err
	}
	defer cancel()
	return c.ActionsConfigure(ctx, syncproto.ActionsConfigRequest{Enabled: enabled, Names: names})
}

func (a *App) ActionsScan(entryID string) (syncproto.ActionsScanResponse, error) {
	c, ctx, cancel, err := a.serverCall(5 * time.Minute)
	if err != nil {
		return syncproto.ActionsScanResponse{}, err
	}
	defer cancel()
	r, err := c.ActionsScan(ctx, entryID)
	a.engine.Nudge() // pull the new Action items records
	return r, err
}
