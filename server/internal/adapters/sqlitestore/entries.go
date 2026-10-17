package sqlitestore

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"diary/server/internal/adapters/sqlitestore/sqlcgen"
	"diary/server/internal/core"
	"diary/shared/model"
)

const emptyBody = `{"type":"doc","content":[]}`

func (s *Store) GetEntry(ctx context.Context, userID, id string) (model.Entry, error) {
	row, err := sqlcgen.New(s.reader).GetEntry(ctx, sqlcgen.GetEntryParams{ID: id, UserID: userID})
	if errors.Is(err, sql.ErrNoRows) {
		return model.Entry{}, core.ErrNotFound
	}
	if err != nil {
		return model.Entry{}, err
	}
	return toModel(row), nil
}

// PutEntry runs BACKEND.md §7.3 in one transaction: idempotency check, version
// check, next server_seq, write, store the response.
func (s *Store) PutEntry(ctx context.Context, userID string, in core.PutInput) (model.Entry, error) {
	return s.write(ctx, userID, in.IdemKey, in.RequestHash, func(q *sqlcgen.Queries, now string) (model.Entry, error) {
		cur, err := q.GetEntryVersion(ctx, sqlcgen.GetEntryVersionParams{ID: in.ID, UserID: userID})
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return model.Entry{}, err
		}
		switch {
		case !exists && in.BaseVersion > 0:
			return model.Entry{}, core.ErrNotFound
		case exists && int(cur.Version) != in.BaseVersion:
			return model.Entry{}, s.conflict(ctx, q, userID, in.ID)
		}

		seq, err := q.NextSeq(ctx, userID)
		if err != nil {
			return model.Entry{}, err
		}
		date, parent := nullString(in.EntryDate), nullString(in.ParentID)
		kind, meta := in.Kind, string(in.Meta)
		if kind == "" {
			kind = model.KindPage
		}
		if meta == "" {
			meta = model.EmptyMeta
		}
		if !exists {
			err = q.InsertEntry(ctx, sqlcgen.InsertEntryParams{
				ID: in.ID, UserID: userID, EntryDate: date, Kind: kind, ParentID: parent, Title: in.Title,
				Body: string(in.Body), BodyText: in.BodyText, Meta: meta, ServerSeq: seq,
				CreatedAt: now, UpdatedAt: now,
			})
			if isUniqueViolation(err) {
				return model.Entry{}, core.ErrForbidden // the id belongs to another user
			}
			if err != nil {
				return model.Entry{}, err
			}
		} else {
			n, err := q.UpdateEntry(ctx, sqlcgen.UpdateEntryParams{
				EntryDate: date, Kind: kind, ParentID: parent, Title: in.Title, Body: string(in.Body), BodyText: in.BodyText,
				Meta: meta, ServerSeq: seq, UpdatedAt: now, ID: in.ID, UserID: userID, Version: int64(in.BaseVersion),
			})
			if err != nil {
				return model.Entry{}, err
			}
			if n != 1 { // the SQL guard caught a version change
				return model.Entry{}, s.conflict(ctx, q, userID, in.ID)
			}
		}
		if err := setLinks(ctx, q, userID, in.ID, in.Links); err != nil {
			return model.Entry{}, err
		}
		return getIn(ctx, q, userID, in.ID)
	})
}

// DeleteEntry turns the entry into a tombstone with its content wiped.
func (s *Store) DeleteEntry(ctx context.Context, userID string, in core.DeleteInput) (model.Entry, error) {
	return s.write(ctx, userID, in.IdemKey, in.RequestHash, func(q *sqlcgen.Queries, now string) (model.Entry, error) {
		cur, err := q.GetEntryVersion(ctx, sqlcgen.GetEntryVersionParams{ID: in.ID, UserID: userID})
		if errors.Is(err, sql.ErrNoRows) {
			return model.Entry{}, core.ErrNotFound
		}
		if err != nil {
			return model.Entry{}, err
		}
		if int(cur.Version) != in.BaseVersion {
			return model.Entry{}, s.conflict(ctx, q, userID, in.ID)
		}
		if cur.DeletedAt.Valid { // already a tombstone: nothing to change
			return getIn(ctx, q, userID, in.ID)
		}
		seq, err := q.NextSeq(ctx, userID)
		if err != nil {
			return model.Entry{}, err
		}
		n, err := q.TombstoneEntry(ctx, sqlcgen.TombstoneEntryParams{
			DeletedAt: sql.NullString{String: now, Valid: true}, ServerSeq: seq, UpdatedAt: now,
			ID: in.ID, UserID: userID, Version: int64(in.BaseVersion),
		})
		if err != nil {
			return model.Entry{}, err
		}
		if n != 1 {
			return model.Entry{}, s.conflict(ctx, q, userID, in.ID)
		}
		if err := setLinks(ctx, q, userID, in.ID, nil); err != nil {
			return model.Entry{}, err
		}
		return getIn(ctx, q, userID, in.ID)
	})
}

// setLinks replaces the links an entry points to, inside the write transaction.
func setLinks(ctx context.Context, q *sqlcgen.Queries, userID, from string, to []string) error {
	if err := q.DeleteLinksFrom(ctx, sqlcgen.DeleteLinksFromParams{UserID: userID, FromID: from}); err != nil {
		return err
	}
	for _, id := range to {
		if err := q.InsertLink(ctx, sqlcgen.InsertLinkParams{UserID: userID, FromID: from, ToID: id}); err != nil {
			return err
		}
	}
	return nil
}

// write wraps a change in BEGIN IMMEDIATE … COMMIT with the idempotency check
// before it and the stored response after it.
func (s *Store) write(ctx context.Context, userID, idemKey string, hash [32]byte,
	fn func(q *sqlcgen.Queries, now string) (model.Entry, error)) (model.Entry, error) {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return model.Entry{}, err
	}
	defer tx.Rollback()
	q := sqlcgen.New(tx)
	now := s.stamp()

	if idemKey != "" {
		prev, err := q.GetIdempotency(ctx, sqlcgen.GetIdempotencyParams{UserID: userID, Key: idemKey})
		switch {
		case err == nil && !bytes.Equal(prev.RequestHash, hash[:]):
			return model.Entry{}, core.ErrIdempotencyMismatch
		case err == nil:
			var e model.Entry
			if err := json.Unmarshal(prev.Response, &e); err != nil {
				return model.Entry{}, fmt.Errorf("stored response: %w", err)
			}
			return e, nil // a retry: return what we answered the first time
		case !errors.Is(err, sql.ErrNoRows):
			return model.Entry{}, err
		}
	}

	e, err := fn(q, now)
	if err != nil {
		return model.Entry{}, err
	}

	if idemKey != "" {
		resp, err := json.Marshal(e)
		if err != nil {
			return model.Entry{}, err
		}
		if err := q.InsertIdempotency(ctx, sqlcgen.InsertIdempotencyParams{
			UserID: userID, Key: idemKey, RequestHash: hash[:], Status: 200, Response: resp, CreatedAt: now,
		}); err != nil {
			return model.Entry{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return model.Entry{}, err
	}
	return e, nil
}

func (s *Store) conflict(ctx context.Context, q *sqlcgen.Queries, userID, id string) error {
	cur, err := getIn(ctx, q, userID, id)
	if err != nil {
		return err
	}
	return &core.ConflictError{Current: cur}
}

func getIn(ctx context.Context, q *sqlcgen.Queries, userID, id string) (model.Entry, error) {
	row, err := q.GetEntry(ctx, sqlcgen.GetEntryParams{ID: id, UserID: userID})
	if err != nil {
		return model.Entry{}, err
	}
	return toModel(row), nil
}

// ChangesSince returns every entry changed after cursor, each once at its
// latest state, oldest change first.
func (s *Store) ChangesSince(ctx context.Context, userID string, cursor int64, limit int) (core.ChangePage, error) {
	tx, err := s.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return core.ChangePage{}, err
	}
	defer tx.Rollback()
	q := sqlcgen.New(tx)

	last, err := q.GetLastSeq(ctx, userID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return core.ChangePage{}, err
	}
	if cursor > last {
		return core.ChangePage{}, core.ErrCursorAhead
	}
	rows, err := q.ChangesSince(ctx, sqlcgen.ChangesSinceParams{UserID: userID, ServerSeq: cursor, Limit: int64(limit) + 1})
	if err != nil {
		return core.ChangePage{}, err
	}
	page := core.ChangePage{Cursor: cursor, Changes: make([]model.Entry, 0, len(rows))}
	if len(rows) > limit {
		rows, page.HasMore = rows[:limit], true
	}
	for _, r := range rows {
		page.Changes = append(page.Changes, toModel(r))
	}
	if n := len(page.Changes); n > 0 {
		page.Cursor = page.Changes[n-1].ServerSeq
	}
	return page, nil
}

func (s *Store) ListByDate(ctx context.Context, userID, from, to string) ([]model.Entry, error) {
	rows, err := sqlcgen.New(s.reader).ListByDate(ctx, sqlcgen.ListByDateParams{
		UserID:   userID,
		FromDate: sql.NullString{String: from, Valid: true},
		ToDate:   sql.NullString{String: to, Valid: true},
	})
	return toModels(rows, err)
}

func (s *Store) ListRecent(ctx context.Context, userID string, limit int) ([]model.Entry, error) {
	rows, err := sqlcgen.New(s.reader).ListRecent(ctx, sqlcgen.ListRecentParams{UserID: userID, RowLimit: int64(limit)})
	return toModels(rows, err)
}

func (s *Store) AllEntries(ctx context.Context, userID string) ([]model.Entry, error) {
	rows, err := sqlcgen.New(s.reader).AllEntries(ctx, userID)
	return toModels(rows, err)
}

// DeleteOldIdempotency removes idempotency records older than maxAge.
func (s *Store) DeleteOldIdempotency(ctx context.Context, maxAge time.Duration) (int64, error) {
	cutoff := s.now().Add(-maxAge).UTC().Format(tsFormat)
	return sqlcgen.New(s.writer).DeleteOldIdempotency(ctx, cutoff)
}

// Search runs a full-text query. Written by hand: sqlc cannot parse MATCH
// and snippet().
func (s *Store) Search(ctx context.Context, userID, query string, limit int) ([]core.SearchHit, error) {
	match := ftsQuery(query)
	if match == "" {
		return []core.SearchHit{}, nil
	}
	rows, err := s.reader.QueryContext(ctx, `
		SELECT e.id, e.entry_date, e.title,
		       snippet(entries_fts, 1, '[', ']', '…', 12) AS snippet
		FROM entries_fts
		JOIN entries e ON e.rowid = entries_fts.rowid
		WHERE entries_fts MATCH ? AND e.user_id = ? AND e.deleted_at IS NULL
		ORDER BY rank
		LIMIT ?`, match, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []core.SearchHit{}
	for rows.Next() {
		var h core.SearchHit
		var date sql.NullString
		if err := rows.Scan(&h.ID, &date, &h.Title, &h.Snippet); err != nil {
			return nil, err
		}
		if date.Valid {
			h.EntryDate = &date.String
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// ftsQuery quotes each word so user input can never be FTS5 syntax, and
// makes the last word a prefix match ("riv" finds "river").
func ftsQuery(q string) string {
	words := strings.Fields(q)
	parts := make([]string, 0, len(words))
	for _, w := range words {
		w = strings.ReplaceAll(w, `"`, "")
		if w != "" {
			parts = append(parts, `"`+w+`"`)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	parts[len(parts)-1] += "*"
	return strings.Join(parts, " ")
}

func toModels(rows []sqlcgen.Entry, err error) ([]model.Entry, error) {
	if err != nil {
		return nil, err
	}
	out := make([]model.Entry, 0, len(rows))
	for _, r := range rows {
		out = append(out, toModel(r))
	}
	return out, nil
}

func toModel(r sqlcgen.Entry) model.Entry {
	e := model.Entry{
		ID:        r.ID,
		Kind:      r.Kind,
		Title:     r.Title,
		Body:      json.RawMessage(r.Body),
		Meta:      json.RawMessage(r.Meta),
		Version:   int(r.Version),
		ServerSeq: r.ServerSeq,
		CreatedAt: parseTS(r.CreatedAt),
		UpdatedAt: parseTS(r.UpdatedAt),
	}
	if r.Body == "" {
		e.Body = json.RawMessage(emptyBody)
	}
	if r.EntryDate.Valid {
		d := r.EntryDate.String
		e.EntryDate = &d
	}
	if r.ParentID.Valid {
		p := r.ParentID.String
		e.ParentID = &p
	}
	if r.Meta == "" {
		e.Meta = json.RawMessage(model.EmptyMeta)
	}
	if r.DeletedAt.Valid {
		t := parseTS(r.DeletedAt.String)
		e.DeletedAt = &t
	}
	return e
}

func parseTS(s string) time.Time {
	t, err := time.Parse(tsFormat, s)
	if err != nil {
		t, _ = time.Parse(time.RFC3339Nano, s)
	}
	return t.UTC()
}

func nullString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func (s *Store) ListChildren(ctx context.Context, userID, parentID string) ([]model.Entry, error) {
	rows, err := sqlcgen.New(s.reader).ListChildren(ctx, sqlcgen.ListChildrenParams{
		UserID: userID, ParentID: sql.NullString{String: parentID, Valid: true},
	})
	return toModels(rows, err)
}

func (s *Store) ListRootPages(ctx context.Context, userID string) ([]model.Entry, error) {
	rows, err := sqlcgen.New(s.reader).ListRootPages(ctx, userID)
	return toModels(rows, err)
}

func (s *Store) Backlinks(ctx context.Context, userID, id string) ([]model.Entry, error) {
	rows, err := sqlcgen.New(s.reader).Backlinks(ctx, sqlcgen.BacklinksParams{UserID: userID, ToID: id})
	return toModels(rows, err)
}
