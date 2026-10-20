package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"diary/shared/model"
	"diary/shared/prosemirror"
	"diary/shared/syncproto"
)

const (
	MaxTitleRunes = 300
	MaxSearchHits = 50
	MaxRecent     = 100
	MaxMetaBytes  = 256 << 10
)

// EntryService holds the rules for reading and writing entries.
type EntryService struct {
	store    Store
	notifier Notifier

	// OnPut, if set, runs after every successful save (e.g. to start a GitLab sync).
	OnPut func(ctx context.Context, userID string, e model.Entry)
}

func NewEntryService(store Store, notifier Notifier) *EntryService {
	return &EntryService{store: store, notifier: notifier}
}

func (s *EntryService) Get(ctx context.Context, userID, id string) (model.Entry, error) {
	if !validID(id) {
		return model.Entry{}, ErrNotFound
	}
	return s.store.GetEntry(ctx, userID, id)
}

// Put creates or updates an entry. rawBody is the exact request body, used for
// the idempotency check.
func (s *EntryService) Put(ctx context.Context, userID, id, idemKey string, req syncproto.PutEntryRequest, rawBody []byte) (model.Entry, error) {
	fields := map[string]string{}
	if !validID(id) {
		fields["id"] = "must be a UUID"
	}
	if idemKey == "" || len(idemKey) > 128 {
		fields["Idempotency-Key"] = "header is required (at most 128 characters)"
	}
	if req.BaseVersion < 0 {
		fields["base_version"] = "must be 0 or more"
	}
	if req.EntryDate != nil && !validDate(*req.EntryDate) {
		fields["entry_date"] = "must be a real date as YYYY-MM-DD"
	}
	if utf8.RuneCountInString(req.Title) > MaxTitleRunes {
		fields["title"] = "must be at most 300 characters"
	}
	if !validDoc(req.Body) {
		fields["body"] = `must be a JSON object with "type":"doc"`
	}
	kind := req.Kind
	if kind == "" {
		kind = model.KindPage
	}
	if kind != model.KindPage && kind != model.KindDatabase {
		fields["kind"] = `must be "page" or "database"`
	}
	var parent *string
	if req.ParentID != nil && *req.ParentID != "" {
		p := strings.ToLower(*req.ParentID)
		switch {
		case !validID(p):
			fields["parent_id"] = "must be a UUID"
		case p == strings.ToLower(id):
			fields["parent_id"] = "can't be the entry itself"
		}
		parent = &p
	}
	meta := bytes.TrimSpace(req.Meta)
	if len(meta) == 0 || string(meta) == "null" {
		meta = []byte(model.EmptyMeta)
	}
	if len(meta) > MaxMetaBytes || meta[0] != '{' || !json.Valid(meta) {
		fields["meta"] = "must be a JSON object of at most 256 KB"
	}
	if len(fields) > 0 {
		return model.Entry{}, &ValidationError{Fields: fields}
	}

	text := prosemirror.ExtractText(req.Body)
	if extra := model.MetaText(meta); extra != "" {
		text += "\n" + extra
	}
	e, err := s.store.PutEntry(ctx, userID, PutInput{
		ID:          strings.ToLower(id),
		IdemKey:     idemKey,
		BaseVersion: req.BaseVersion,
		EntryDate:   req.EntryDate,
		Kind:        kind,
		ParentID:    parent,
		Title:       req.Title,
		Body:        req.Body,
		BodyText:    text,
		Meta:        json.RawMessage(meta),
		Links:       links(req.Body, meta, id),
		RequestHash: requestHash("PUT", id, rawBody),
	})
	if err != nil {
		return model.Entry{}, err
	}
	_ = s.notifier.Publish(ctx, userID, e.ServerSeq)
	if s.OnPut != nil {
		s.OnPut(ctx, userID, e)
	}
	return e, nil
}

func (s *EntryService) Delete(ctx context.Context, userID, id, idemKey string, baseVersion int) (model.Entry, error) {
	fields := map[string]string{}
	if !validID(id) {
		fields["id"] = "must be a UUID"
	}
	if idemKey == "" || len(idemKey) > 128 {
		fields["Idempotency-Key"] = "header is required (at most 128 characters)"
	}
	if baseVersion < 1 {
		fields["base_version"] = "must be 1 or more"
	}
	if len(fields) > 0 {
		return model.Entry{}, &ValidationError{Fields: fields}
	}
	e, err := s.store.DeleteEntry(ctx, userID, DeleteInput{
		ID:          strings.ToLower(id),
		IdemKey:     idemKey,
		BaseVersion: baseVersion,
		RequestHash: requestHash("DELETE", id, []byte(strconv.Itoa(baseVersion))),
	})
	if err != nil {
		return model.Entry{}, err
	}
	_ = s.notifier.Publish(ctx, userID, e.ServerSeq)
	return e, nil
}

// trashOp validates and runs a restore or permanent-purge, which share the
// shape of Delete (id + idempotency key + base version).
func (s *EntryService) trashOp(ctx context.Context, userID, id, idemKey string, baseVersion int,
	run func(context.Context, string, DeleteInput) (model.Entry, error), op string) (model.Entry, error) {
	fields := map[string]string{}
	if !validID(id) {
		fields["id"] = "must be a UUID"
	}
	if idemKey == "" || len(idemKey) > 128 {
		fields["Idempotency-Key"] = "header is required (at most 128 characters)"
	}
	if baseVersion < 1 {
		fields["base_version"] = "must be 1 or more"
	}
	if len(fields) > 0 {
		return model.Entry{}, &ValidationError{Fields: fields}
	}
	e, err := run(ctx, userID, DeleteInput{
		ID:          strings.ToLower(id),
		IdemKey:     idemKey,
		BaseVersion: baseVersion,
		RequestHash: requestHash(op, id, []byte(strconv.Itoa(baseVersion))),
	})
	if err != nil {
		return model.Entry{}, err
	}
	_ = s.notifier.Publish(ctx, userID, e.ServerSeq)
	return e, nil
}

// Restore brings a trashed entry back.
func (s *EntryService) Restore(ctx context.Context, userID, id, idemKey string, baseVersion int) (model.Entry, error) {
	return s.trashOp(ctx, userID, id, idemKey, baseVersion, s.store.RestoreEntry, "RESTORE")
}

// PurgePermanently empties one entry from the trash for good.
func (s *EntryService) PurgePermanently(ctx context.Context, userID, id, idemKey string, baseVersion int) (model.Entry, error) {
	return s.trashOp(ctx, userID, id, idemKey, baseVersion, s.store.PurgeEntry, "PURGE")
}

// Trash lists the entries currently in the trash (recoverable).
func (s *EntryService) Trash(ctx context.Context, userID string, limit int) ([]model.Entry, error) {
	if limit <= 0 || limit > MaxRecent {
		limit = MaxRecent
	}
	return s.store.ListTrash(ctx, userID, limit)
}

func (s *EntryService) ListRange(ctx context.Context, userID, from, to string) ([]model.Entry, error) {
	fields := map[string]string{}
	if !validDate(from) {
		fields["from"] = "must be a date as YYYY-MM-DD"
	}
	if !validDate(to) {
		fields["to"] = "must be a date as YYYY-MM-DD"
	}
	if len(fields) > 0 {
		return nil, &ValidationError{Fields: fields}
	}
	return s.store.ListByDate(ctx, userID, from, to)
}

func (s *EntryService) Recent(ctx context.Context, userID string, limit int) ([]model.Entry, error) {
	if limit <= 0 || limit > MaxRecent {
		limit = MaxRecent
	}
	return s.store.ListRecent(ctx, userID, limit)
}

func (s *EntryService) Search(ctx context.Context, userID, query string) ([]SearchHit, error) {
	if strings.TrimSpace(query) == "" {
		return []SearchHit{}, nil
	}
	return s.store.Search(ctx, userID, query, MaxSearchHits)
}

func (s *EntryService) All(ctx context.Context, userID string) ([]model.Entry, error) {
	return s.store.AllEntries(ctx, userID)
}

// Children returns the sub-pages of a page, or the records of a database.
func (s *EntryService) Children(ctx context.Context, userID, parentID string) ([]model.Entry, error) {
	if !validID(parentID) {
		return nil, &ValidationError{Fields: map[string]string{"parent": "must be a UUID"}}
	}
	return s.store.ListChildren(ctx, userID, strings.ToLower(parentID))
}

// RootPages returns undated pages and databases with no parent: the roots of
// the sidebar tree.
func (s *EntryService) RootPages(ctx context.Context, userID string) ([]model.Entry, error) {
	return s.store.ListRootPages(ctx, userID)
}

// Backlinks returns the live entries that link to id.
func (s *EntryService) Backlinks(ctx context.Context, userID, id string) ([]model.Entry, error) {
	if !validID(id) {
		return nil, ErrNotFound
	}
	return s.store.Backlinks(ctx, userID, strings.ToLower(id))
}

// links is every id the entry points to, except itself.
func links(body, meta json.RawMessage, self string) []string {
	self = strings.ToLower(self)
	seen := map[string]bool{}
	for _, id := range append(prosemirror.ExtractLinks(body), model.MetaLinks(meta)...) {
		if id != self {
			seen[id] = true
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	return out
}

func requestHash(method, id string, body []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte(method + " " + strings.ToLower(id) + "\n"))
	h.Write(body)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func validID(id string) bool {
	if len(id) != 36 {
		return false
	}
	_, err := uuid.Parse(id)
	return err == nil
}

func validDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func validDoc(body json.RawMessage) bool {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return false
	}
	var doc struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(body, &doc) == nil && doc.Type == "doc"
}
