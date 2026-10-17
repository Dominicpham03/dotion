package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"diary/shared/model"
	"diary/shared/syncproto"
)

// GitLabItem is an issue or merge request assigned to the user.
type GitLabItem struct {
	Kind        string // "issue" | "mr"
	GlobalID    int64
	ProjectID   int64
	IID         int64
	Title       string
	Description string
	State       string // opened | closed | merged | locked
	URL         string
	Due         string // YYYY-MM-DD or ""
	Labels      []string
	Ref         string // group/project#12 or group/project!7
	Project     string // group/project
	UpdatedAt   string
}

// GitLabAPI is the GitLab REST API.
type GitLabAPI interface {
	User(ctx context.Context, base, token string) (username string, err error)
	Issues(ctx context.Context, base, token string, since time.Time) ([]GitLabItem, error)
	MergeRequests(ctx context.Context, base, token string, since time.Time) ([]GitLabItem, error)
	SetIssueState(ctx context.Context, base, token string, projectID, iid int64, closed bool) error
}

const GitLabProvider = "gitlab"

// Fixed property and option ids in the GitLab database, so syncs and devices agree.
const (
	glStatus  = "p_gl_status"
	glType    = "p_gl_type"
	glProject = "p_gl_project"
	glLabels  = "p_gl_labels"
	glDue     = "p_gl_due"
	glURL     = "p_gl_url"
	glRef     = "p_gl_ref"

	optOpen   = "opt_glopen"
	optDone   = "opt_gldone"
	optMerged = "opt_glmerged"
	optClosed = "opt_glclosed"
	optIssue  = "opt_glissue"
	optMR     = "opt_glmr"
)

// GitLabConfig is stored with the integration.
type GitLabConfig struct {
	URL        string `json:"url"`
	Username   string `json:"username"`
	DatabaseID string `json:"database_id"`
	LastSync   string `json:"last_sync,omitempty"` // RFC 3339
	LastError  string `json:"last_error,omitempty"`
}

// GitLabResult summarizes one sync.
type GitLabResult struct {
	Created int `json:"created"`
	Updated int `json:"updated"`
	Pushed  int `json:"pushed"` // issues closed or reopened in GitLab
}

// GitLabService mirrors a user's assigned GitLab work into a Dotion database.
// Issue status is two-way: Done/Open in Dotion closes/reopens the issue.
// Merge requests are read-only.
type GitLabService struct {
	entries *EntryService
	store   Store
	ints    IntegrationStore
	api     GitLabAPI
	now     func() time.Time

	mu      sync.Mutex
	running map[string]*sync.Mutex // per user: one sync at a time
	pending map[string]*time.Timer
}

func NewGitLabService(entries *EntryService, store Store, ints IntegrationStore, api GitLabAPI) *GitLabService {
	return &GitLabService{
		entries: entries, store: store, ints: ints, api: api,
		now:     func() time.Time { return time.Now().UTC() },
		running: map[string]*sync.Mutex{}, pending: map[string]*time.Timer{},
	}
}

type syncCtxKey struct{}

// FromSync reports whether a write was made by the GitLab sync itself.
func FromSync(ctx context.Context) bool { return ctx.Value(syncCtxKey{}) != nil }

func (s *GitLabService) lock(userID string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.running[userID]
	if m == nil {
		m = &sync.Mutex{}
		s.running[userID] = m
	}
	return m
}

func (s *GitLabService) config(ctx context.Context, userID string) (Integration, GitLabConfig, error) {
	in, err := s.ints.GetIntegration(ctx, userID, GitLabProvider)
	if err != nil {
		return in, GitLabConfig{}, err
	}
	var cfg GitLabConfig
	_ = json.Unmarshal(in.Config, &cfg)
	return in, cfg, nil
}

func (s *GitLabService) saveConfig(ctx context.Context, userID string, in Integration, cfg GitLabConfig) error {
	in.Config, _ = json.Marshal(cfg)
	return s.ints.PutIntegration(ctx, userID, in)
}

// Status returns the connection, or ok=false when not connected.
func (s *GitLabService) Status(ctx context.Context, userID string) (GitLabConfig, bool, error) {
	_, cfg, err := s.config(ctx, userID)
	if errors.Is(err, ErrNotFound) {
		return GitLabConfig{}, false, nil
	}
	return cfg, err == nil, err
}

// Connect checks the token, saves the connection and runs the first sync.
func (s *GitLabService) Connect(ctx context.Context, userID, baseURL, token string) (GitLabConfig, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "https://gitlab.com"
	}
	if !strings.HasPrefix(baseURL, "https://") && !strings.HasPrefix(baseURL, "http://") {
		return GitLabConfig{}, &ValidationError{Fields: map[string]string{"url": "must start with https://"}}
	}
	if strings.TrimSpace(token) == "" {
		return GitLabConfig{}, &ValidationError{Fields: map[string]string{"token": "is required"}}
	}
	username, err := s.api.User(ctx, baseURL, strings.TrimSpace(token))
	if errors.Is(err, ErrGrantRevoked) {
		return GitLabConfig{}, &ValidationError{Fields: map[string]string{"token": "GitLab didn't accept this token"}}
	}
	if err != nil {
		return GitLabConfig{}, fmt.Errorf("couldn't reach GitLab at %s: %w", baseURL, err)
	}
	cfg := GitLabConfig{URL: baseURL, Username: username, DatabaseID: dbIDFor(userID)}
	if _, old, err := s.config(ctx, userID); err == nil && old.URL == baseURL {
		cfg.LastSync = old.LastSync // reconnecting to the same GitLab keeps the history
	}
	in := Integration{Provider: GitLabProvider, RefreshToken: strings.TrimSpace(token), Email: username}
	if err := s.saveConfig(ctx, userID, in, cfg); err != nil {
		return GitLabConfig{}, err
	}
	if _, err := s.Sync(ctx, userID); err != nil {
		return cfg, err
	}
	cfg, _, err = s.Status(ctx, userID)
	return cfg, err
}

// Disconnect forgets the token. The GitLab database stays as ordinary pages.
func (s *GitLabService) Disconnect(ctx context.Context, userID string) error {
	return s.ints.DeleteIntegration(ctx, userID, GitLabProvider)
}

func dbIDFor(userID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("dotion:gitlab-db:"+userID)).String()
}

func recordIDFor(userID string, it GitLabItem) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("dotion:gitlab:%s:%s:%d", userID, it.Kind, it.GlobalID))).String()
}

func optionID(prefix, s string) string {
	h := fnv.New64a()
	h.Write([]byte(s))
	return fmt.Sprintf("opt_gl%s%x", prefix, h.Sum64())
}

// Sync pushes status changes made in Dotion, then pulls changes from GitLab.
func (s *GitLabService) Sync(ctx context.Context, userID string) (GitLabResult, error) {
	m := s.lock(userID)
	m.Lock()
	defer m.Unlock()
	ctx = context.WithValue(ctx, syncCtxKey{}, true)

	in, cfg, err := s.config(ctx, userID)
	if err != nil {
		return GitLabResult{}, err
	}
	res, err := s.sync(ctx, userID, in, &cfg)
	cfg.LastError = ""
	if err != nil {
		cfg.LastError = err.Error()
		if errors.Is(err, ErrGrantRevoked) {
			cfg.LastError = "GitLab no longer accepts the token. Connect again with a new one."
		}
	}
	_ = s.saveConfig(ctx, userID, in, cfg)
	return res, err
}

type glMeta struct {
	Kind      string `json:"kind"`
	ProjectID int64  `json:"project_id"`
	IID       int64  `json:"iid"`
	State     string `json:"state"` // as last seen in GitLab
}

type recordMeta struct {
	Icon   string                     `json:"icon,omitempty"`
	Props  map[string]json.RawMessage `json:"props"`
	GitLab *glMeta                    `json:"gitlab,omitempty"`
}

func (s *GitLabService) sync(ctx context.Context, userID string, in Integration, cfg *GitLabConfig) (GitLabResult, error) {
	var res GitLabResult
	started := s.now()
	db, err := s.ensureDatabase(ctx, userID, cfg)
	if err != nil {
		return res, err
	}
	records, err := s.store.ListChildren(ctx, userID, db.ID)
	if err != nil {
		return res, err
	}
	byID := map[string]model.Entry{}
	for _, r := range records {
		byID[r.ID] = r
	}

	// 1. Push: issue status changed in Dotion → close or reopen in GitLab.
	pushed := map[string]bool{}
	for _, r := range records {
		var meta recordMeta
		if json.Unmarshal(r.Meta, &meta) != nil || meta.GitLab == nil || meta.GitLab.Kind != "issue" {
			continue
		}
		var status string
		_ = json.Unmarshal(meta.Props[glStatus], &status)
		wantClosed := status == optDone || status == optClosed
		isClosed := meta.GitLab.State == "closed"
		if status == "" || wantClosed == isClosed {
			continue
		}
		if err := s.api.SetIssueState(ctx, cfg.URL, in.RefreshToken, meta.GitLab.ProjectID, meta.GitLab.IID, wantClosed); err != nil {
			return res, err
		}
		meta.GitLab.State = map[bool]string{true: "closed", false: "opened"}[wantClosed]
		if e, err := s.writeMeta(ctx, userID, r, meta); err == nil {
			byID[r.ID] = e
		}
		pushed[r.ID] = true
		res.Pushed++
	}

	// 2. Pull everything changed since the last sync (first time: 180 days).
	since := started.Add(-180 * 24 * time.Hour)
	if t, err := time.Parse(time.RFC3339, cfg.LastSync); err == nil {
		since = t.Add(-2 * time.Minute)
	}
	issues, err := s.api.Issues(ctx, cfg.URL, in.RefreshToken, since)
	if err != nil {
		return res, err
	}
	mrs, err := s.api.MergeRequests(ctx, cfg.URL, in.RefreshToken, since)
	if err != nil {
		return res, err
	}
	items := append(issues, mrs...)

	// New projects and labels become select options.
	if err := s.addOptions(ctx, userID, db, items); err != nil {
		return res, err
	}

	for _, it := range items {
		id := recordIDFor(userID, it)
		if pushed[id] {
			continue // our own change; GitLab's copy may lag a moment
		}
		cur, exists := byID[id]
		outcome, err := s.upsert(ctx, userID, db.ID, id, it, cur, exists)
		if errors.Is(err, ErrConflict) {
			continue // edited at this moment on a device; the next sync settles it
		}
		if err != nil {
			return res, err
		}
		switch outcome {
		case "created":
			res.Created++
		case "updated":
			res.Updated++
		}
	}
	cfg.LastSync = started.Format(time.RFC3339)
	return res, nil
}

func statusOption(it GitLabItem) string {
	switch {
	case it.State == "merged":
		return optMerged
	case it.State == "closed" && it.Kind == "mr":
		return optClosed
	case it.State == "closed":
		return optDone
	default:
		return optOpen
	}
}

// upsert writes the record for an item. Fields from GitLab overwrite the
// record's GitLab properties; the page body (your notes) and any other
// properties are kept.
func (s *GitLabService) upsert(ctx context.Context, userID, dbID, id string, it GitLabItem, cur model.Entry, exists bool) (string, error) {
	meta := recordMeta{Props: map[string]json.RawMessage{}}
	body := json.RawMessage(nil)
	if exists {
		_ = json.Unmarshal(cur.Meta, &meta)
		if meta.Props == nil {
			meta.Props = map[string]json.RawMessage{}
		}
		body = cur.Body
	} else {
		body = descriptionDoc(it.Description)
	}
	set := func(k string, v any) {
		if v == nil {
			delete(meta.Props, k)
			return
		}
		b, _ := json.Marshal(v)
		meta.Props[k] = b
	}
	set(glStatus, statusOption(it))
	set(glType, map[bool]string{true: optMR, false: optIssue}[it.Kind == "mr"])
	set(glProject, optionID("p", it.Project))
	labels := make([]string, 0, len(it.Labels))
	for _, l := range it.Labels {
		labels = append(labels, optionID("l", l))
	}
	if len(labels) > 0 {
		set(glLabels, labels)
	} else {
		set(glLabels, nil)
	}
	if it.Due != "" {
		set(glDue, it.Due)
	} else {
		set(glDue, nil)
	}
	set(glURL, it.URL)
	set(glRef, it.Ref)
	meta.GitLab = &glMeta{Kind: it.Kind, ProjectID: it.ProjectID, IID: it.IID, State: it.State}

	metaJSON, _ := json.Marshal(meta)
	if exists && cur.Title == it.Title && sameJSON(cur.Meta, metaJSON) {
		return "unchanged", nil // nothing changed: no new version
	}
	base := 0
	if exists {
		base = cur.Version
	}
	parent := dbID
	req := syncproto.PutEntryRequest{BaseVersion: base, ParentID: &parent, Title: it.Title, Body: body, Meta: metaJSON}
	raw, _ := json.Marshal(req)
	if _, err := s.entries.Put(ctx, userID, id, randomKey(), req, raw); err != nil {
		return "", err
	}
	if exists {
		return "updated", nil
	}
	return "created", nil
}

func (s *GitLabService) writeMeta(ctx context.Context, userID string, r model.Entry, meta recordMeta) (model.Entry, error) {
	metaJSON, _ := json.Marshal(meta)
	req := syncproto.PutEntryRequest{BaseVersion: r.Version, EntryDate: r.EntryDate, Kind: r.Kind, ParentID: r.ParentID, Title: r.Title, Body: r.Body, Meta: metaJSON}
	raw, _ := json.Marshal(req)
	return s.entries.Put(ctx, userID, r.ID, randomKey(), req, raw)
}

func (s *GitLabService) ensureDatabase(ctx context.Context, userID string, cfg *GitLabConfig) (model.Entry, error) {
	if cfg.DatabaseID == "" {
		cfg.DatabaseID = dbIDFor(userID)
	}
	db, err := s.store.GetEntry(ctx, userID, cfg.DatabaseID)
	if err == nil && db.DeletedAt == nil {
		return db, nil
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return model.Entry{}, err
	}
	base := 0
	if err == nil {
		base = db.Version // deleted by the user: bring it back
	}
	schema := map[string]any{
		"properties": []map[string]any{
			{"id": glStatus, "name": "Status", "type": "status", "options": []map[string]string{
				{"id": optOpen, "name": "Open", "color": "blue"}, {"id": optDone, "name": "Done", "color": "green"},
				{"id": optMerged, "name": "Merged", "color": "purple"}, {"id": optClosed, "name": "Closed", "color": "gray"},
			}},
			{"id": glType, "name": "Type", "type": "select", "options": []map[string]string{
				{"id": optIssue, "name": "Issue", "color": "orange"}, {"id": optMR, "name": "Merge request", "color": "pink"},
			}},
			{"id": glProject, "name": "Project", "type": "select", "options": []map[string]string{}},
			{"id": glLabels, "name": "Labels", "type": "multi_select", "options": []map[string]string{}},
			{"id": glDue, "name": "Due", "type": "date"},
			{"id": glURL, "name": "GitLab link", "type": "url"},
			{"id": glRef, "name": "Reference", "type": "text"},
		},
		"views": []map[string]any{
			{"id": "v_glopen", "name": "Open", "type": "table",
				"filters": []map[string]any{{"propertyId": glStatus, "op": "is", "value": optOpen}},
				"sorts":   []map[string]any{{"propertyId": glDue, "direction": "asc"}}},
			{"id": "v_glboard", "name": "Board", "type": "board", "groupBy": glStatus, "filters": []any{}, "sorts": []any{}},
			{"id": "v_glcal", "name": "Due dates", "type": "calendar", "dateProperty": glDue, "filters": []any{}, "sorts": []any{}},
			{"id": "v_glall", "name": "All", "type": "table", "filters": []any{}, "sorts": []map[string]any{{"propertyId": "updated", "direction": "desc"}}},
		},
	}
	meta, _ := json.Marshal(map[string]any{"icon": "🦊", "schema": schema})
	body, _ := json.Marshal(map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text",
			"text": "Issues and merge requests assigned to you in GitLab. Set an issue's Status to Done to close it in GitLab, or back to Open to reopen it."}}},
	}})
	req := syncproto.PutEntryRequest{BaseVersion: base, Kind: model.KindDatabase, Title: "GitLab", Body: body, Meta: meta}
	raw, _ := json.Marshal(req)
	return s.entries.Put(ctx, userID, cfg.DatabaseID, randomKey(), req, raw)
}

// addOptions adds unseen projects and labels to the database's select options.
func (s *GitLabService) addOptions(ctx context.Context, userID string, db model.Entry, items []GitLabItem) error {
	var meta map[string]json.RawMessage
	if err := json.Unmarshal(db.Meta, &meta); err != nil {
		return err
	}
	var schema struct {
		Properties []map[string]any `json:"properties"`
		Views      json.RawMessage  `json:"views"`
	}
	if err := json.Unmarshal(meta["schema"], &schema); err != nil {
		return err
	}
	want := map[string]map[string]string{glProject: {}, glLabels: {}}
	for _, it := range items {
		want[glProject][optionID("p", it.Project)] = it.Project
		for _, l := range it.Labels {
			want[glLabels][optionID("l", l)] = l
		}
	}
	colors := []string{"blue", "green", "orange", "purple", "pink", "yellow", "brown", "red", "gray"}
	changed := false
	for _, p := range schema.Properties {
		id, _ := p["id"].(string)
		names, ok := want[id]
		if !ok {
			continue
		}
		opts, _ := p["options"].([]any)
		have := map[string]bool{}
		for _, o := range opts {
			if m, ok := o.(map[string]any); ok {
				have[fmt.Sprint(m["id"])] = true
			}
		}
		ids := make([]string, 0, len(names))
		for oid := range names {
			ids = append(ids, oid)
		}
		sort.Strings(ids)
		for _, oid := range ids {
			if have[oid] {
				continue
			}
			opts = append(opts, map[string]any{"id": oid, "name": names[oid], "color": colors[len(opts)%len(colors)]})
			changed = true
		}
		p["options"] = opts
	}
	if !changed {
		return nil
	}
	meta["schema"], _ = json.Marshal(schema)
	metaJSON, _ := json.Marshal(meta)
	req := syncproto.PutEntryRequest{BaseVersion: db.Version, Kind: model.KindDatabase, ParentID: db.ParentID, Title: db.Title, Body: db.Body, Meta: metaJSON}
	raw, _ := json.Marshal(req)
	_, err := s.entries.Put(ctx, userID, db.ID, randomKey(), req, raw)
	return err
}

// Changed is called after any entry write. A status change to a GitLab
// record schedules a sync a few seconds later (several quick edits, one sync).
func (s *GitLabService) Changed(ctx context.Context, userID string, e model.Entry) {
	if FromSync(ctx) || e.ParentID == nil || *e.ParentID != dbIDFor(userID) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.pending[userID]; t != nil {
		t.Stop()
	}
	s.pending[userID] = time.AfterFunc(3*time.Second, func() {
		_, _ = s.Sync(context.Background(), userID)
	})
}

// Loop syncs every connected user every interval until ctx ends.
func (s *GitLabService) Loop(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		users, err := s.ints.IntegrationUsers(ctx, GitLabProvider)
		if err != nil {
			continue
		}
		for _, u := range users {
			_, _ = s.Sync(ctx, u)
		}
	}
}

func descriptionDoc(desc string) json.RawMessage {
	content := []any{}
	for _, para := range strings.Split(strings.ReplaceAll(desc, "\r\n", "\n"), "\n\n") {
		if para = strings.TrimSpace(para); para == "" {
			continue
		}
		if len(content) >= 200 {
			break
		}
		content = append(content, map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": para}}})
	}
	b, _ := json.Marshal(map[string]any{"type": "doc", "content": content})
	return b
}

func sameJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	ja, _ := json.Marshal(x)
	jb, _ := json.Marshal(y)
	return string(ja) == string(jb)
}

func randomKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
