package localdb

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"diary/shared/conflict"
	"diary/shared/model"
	"diary/shared/prosemirror"
	"diary/shared/syncproto"
)

const emptyBody = `{"type":"doc","content":[]}`

// Draft is what the editor saves.
type Draft struct {
	ID        string
	EntryDate *string
	Kind      string
	ParentID  *string
	Title     string
	Body      json.RawMessage
	Meta      json.RawMessage
}

// OutboxRow is one pending change.
type OutboxRow struct {
	EntryID     string
	Op          string // "put" | "delete"
	Payload     json.RawMessage
	BaseVersion int
	Rev         int
	IdemKey     string
	Attempts    int
}

const entryCols = "id, entry_date, kind, parent_id, title, body, meta, version, server_seq, created_at, updated_at, deleted_at"

type scanner interface{ Scan(...any) error }

func scanEntry(s scanner) (model.Entry, error) {
	var (
		e                       model.Entry
		date, parent, deleted   sql.NullString
		seq                     sql.NullInt64
		body, meta, created, up string
	)
	if err := s.Scan(&e.ID, &date, &e.Kind, &parent, &e.Title, &body, &meta, &e.Version, &seq, &created, &up, &deleted); err != nil {
		return model.Entry{}, err
	}
	e.Body, e.Meta = json.RawMessage(body), json.RawMessage(meta)
	e.ServerSeq = seq.Int64
	e.CreatedAt, e.UpdatedAt = parseTS(created), parseTS(up)
	if date.Valid {
		e.EntryDate = &date.String
	}
	if parent.Valid {
		e.ParentID = &parent.String
	}
	if deleted.Valid {
		t := parseTS(deleted.String)
		e.DeletedAt = &t
	}
	return e, nil
}

func parseTS(s string) time.Time {
	t, err := time.Parse(tsFormat, s)
	if err != nil {
		t, _ = time.Parse(time.RFC3339Nano, s)
	}
	return t.UTC()
}

func (d *DB) queryEntries(ctx context.Context, q string, args ...any) ([]model.Entry, error) {
	rows, err := d.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// GetEntry returns the entry, or nil if there is none (tombstones included).
func (d *DB) GetEntry(ctx context.Context, id string) (*model.Entry, error) {
	e, err := scanEntry(d.db.QueryRowContext(ctx, "SELECT "+entryCols+" FROM entries WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// GetEntryForDate returns the first live entry for a day, or nil.
func (d *DB) GetEntryForDate(ctx context.Context, date string) (*model.Entry, error) {
	list, err := d.queryEntries(ctx, "SELECT "+entryCols+` FROM entries
		WHERE entry_date = ? AND deleted_at IS NULL AND parent_id IS NULL ORDER BY created_at LIMIT 1`, date)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

func (d *DB) ListRange(ctx context.Context, from, to string) ([]model.Entry, error) {
	return d.queryEntries(ctx, "SELECT "+entryCols+` FROM entries
		WHERE entry_date >= ? AND entry_date <= ? AND deleted_at IS NULL ORDER BY entry_date, created_at`, from, to)
}

// ListRecent skips database records; they are reached through their database.
func (d *DB) ListRecent(ctx context.Context, limit int) ([]model.Entry, error) {
	return d.queryEntries(ctx, "SELECT "+entryCols+` FROM entries
		WHERE deleted_at IS NULL
		  AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM entries WHERE kind = 'database'))
		ORDER BY updated_at DESC LIMIT ?`, limit)
}

// ListChildren returns the sub-pages of a page, or the records of a database.
func (d *DB) ListChildren(ctx context.Context, parentID string) ([]model.Entry, error) {
	return d.queryEntries(ctx, "SELECT "+entryCols+` FROM entries
		WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at`, parentID)
}

// ListRootPages returns undated pages and databases with no parent.
func (d *DB) ListRootPages(ctx context.Context) ([]model.Entry, error) {
	return d.queryEntries(ctx, "SELECT "+entryCols+` FROM entries
		WHERE parent_id IS NULL AND entry_date IS NULL AND deleted_at IS NULL
		ORDER BY title COLLATE NOCASE, created_at`)
}

// Backlinks returns the live entries that link to id.
func (d *DB) Backlinks(ctx context.Context, id string) ([]model.Entry, error) {
	return d.queryEntries(ctx, "SELECT "+entryCols+` FROM entries
		WHERE deleted_at IS NULL AND id != ?
		  AND id IN (SELECT from_id FROM entry_links WHERE to_id = ?)
		ORDER BY updated_at DESC`, id, id)
}

// Search works offline against the local FTS index.
func (d *DB) Search(ctx context.Context, query string, limit int) ([]syncproto.SearchHit, error) {
	words := strings.Fields(query)
	parts := make([]string, 0, len(words))
	for _, w := range words {
		if w = strings.ReplaceAll(w, `"`, ""); w != "" {
			parts = append(parts, `"`+w+`"`)
		}
	}
	hits := []syncproto.SearchHit{}
	if len(parts) == 0 {
		return hits, nil
	}
	parts[len(parts)-1] += "*"
	rows, err := d.db.QueryContext(ctx, `
		SELECT e.id, e.entry_date, e.title, snippet(entries_fts, 1, '[', ']', '…', 12)
		FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
		WHERE entries_fts MATCH ? AND e.deleted_at IS NULL
		ORDER BY rank LIMIT ?`, strings.Join(parts, " "), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var h syncproto.SearchHit
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

// searchText mirrors the server: body text plus free-text property values.
func searchText(body, meta json.RawMessage) string {
	text := prosemirror.ExtractText(body)
	if extra := model.MetaText(meta); extra != "" {
		text += "\n" + extra
	}
	return text
}

func normalize(dr *Draft) {
	if len(dr.Body) == 0 || string(dr.Body) == "null" {
		dr.Body = json.RawMessage(emptyBody)
	}
	if len(dr.Meta) == 0 || string(dr.Meta) == "null" {
		dr.Meta = json.RawMessage(model.EmptyMeta)
	}
	if dr.Kind == "" {
		dr.Kind = model.KindPage
	}
	if dr.ParentID != nil && *dr.ParentID == "" {
		dr.ParentID = nil
	}
}

// SaveLocal writes the entry and coalesces it into the outbox, in one
// transaction (FRONTEND.md §8.3). The version is not changed: it stays the
// last one the server confirmed.
func (d *DB) SaveLocal(ctx context.Context, dr Draft) (model.Entry, error) {
	normalize(&dr)
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Entry{}, err
	}
	defer tx.Rollback()
	now := d.stamp()

	_, err = tx.ExecContext(ctx, `
		INSERT INTO entries (id, entry_date, kind, parent_id, title, body, body_text, meta, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
		ON CONFLICT (id) DO UPDATE SET entry_date = excluded.entry_date, kind = excluded.kind, parent_id = excluded.parent_id,
			title = excluded.title, body = excluded.body, body_text = excluded.body_text, meta = excluded.meta,
			updated_at = excluded.updated_at, deleted_at = NULL`,
		dr.ID, nullable(dr.EntryDate), dr.Kind, nullable(dr.ParentID), dr.Title, string(dr.Body),
		searchText(dr.Body, dr.Meta), string(dr.Meta), now, now)
	if err != nil {
		return model.Entry{}, err
	}
	if err := setLinks(ctx, tx, dr.ID, dr.Body, dr.Meta); err != nil {
		return model.Entry{}, err
	}
	payload, err := json.Marshal(syncproto.PutEntryRequest{
		EntryDate: dr.EntryDate, Kind: dr.Kind, ParentID: dr.ParentID, Title: dr.Title, Body: dr.Body, Meta: dr.Meta,
	})
	if err != nil {
		return model.Entry{}, err
	}
	if err := enqueue(ctx, tx, dr.ID, "put", payload); err != nil {
		return model.Entry{}, err
	}
	e, err := scanEntry(tx.QueryRowContext(ctx, "SELECT "+entryCols+" FROM entries WHERE id = ?", dr.ID))
	if err != nil {
		return model.Entry{}, err
	}
	return e, tx.Commit()
}

// setLinks recomputes the ids an entry points to, as on the server.
func setLinks(ctx context.Context, tx *sql.Tx, id string, body, meta json.RawMessage) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM entry_links WHERE from_id = ?", id); err != nil {
		return err
	}
	for _, to := range append(prosemirror.ExtractLinks(body), model.MetaLinks(meta)...) {
		if to == strings.ToLower(id) {
			continue
		}
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO entry_links (from_id, to_id) VALUES (?, ?)", id, to); err != nil {
			return err
		}
	}
	return nil
}

// DeleteLocal tombstones the entry and queues the delete. An entry the server
// has never seen is simply removed.
func (d *DB) DeleteLocal(ctx context.Context, id string) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	err = tx.QueryRowContext(ctx, "SELECT version FROM entries WHERE id = ?", id).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM entry_links WHERE from_id = ?", id); err != nil {
		return err
	}
	if version == 0 {
		if _, err := tx.ExecContext(ctx, "DELETE FROM outbox WHERE entry_id = ?", id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM entries WHERE id = ?", id); err != nil {
			return err
		}
		return tx.Commit()
	}
	now := d.stamp()
	if _, err := tx.ExecContext(ctx, `UPDATE entries SET deleted_at = ?, title = '', body = ?, body_text = '', meta = '{}', updated_at = ?
		WHERE id = ?`, now, emptyBody, now, id); err != nil {
		return err
	}
	if err := enqueue(ctx, tx, id, "delete", json.RawMessage("{}")); err != nil {
		return err
	}
	return tx.Commit()
}

// enqueue inserts or coalesces the outbox row for an entry: new edits replace
// the payload and bump rev, and base_version keeps the version the edits
// started from.
func enqueue(ctx context.Context, tx *sql.Tx, id, op string, payload []byte) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO outbox (entry_id, op, payload, base_version, rev, idem_key)
		VALUES (?, ?, ?, (SELECT version FROM entries WHERE id = ?), 1, ?)
		ON CONFLICT (entry_id) DO UPDATE SET op = excluded.op, payload = excluded.payload,
			rev = outbox.rev + 1, idem_key = excluded.idem_key,
			attempts = 0, next_try_at = NULL, last_error = NULL, failed = 0`,
		id, op, string(payload), id, uuid.NewString())
	return err
}

// ---- outbox, used by the sync engine ---------------------------------------

// Due returns the rows ready to send.
func (d *DB) Due(ctx context.Context) ([]OutboxRow, error) {
	rows, err := d.db.QueryContext(ctx, `
		SELECT entry_id, op, payload, base_version, rev, idem_key, attempts FROM outbox
		WHERE failed = 0 AND (next_try_at IS NULL OR next_try_at <= ?)
		ORDER BY rowid`, d.stamp())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OutboxRow
	for rows.Next() {
		var r OutboxRow
		var payload string
		if err := rows.Scan(&r.EntryID, &r.Op, &payload, &r.BaseVersion, &r.Rev, &r.IdemKey, &r.Attempts); err != nil {
			return nil, err
		}
		r.Payload = json.RawMessage(payload)
		out = append(out, r)
	}
	return out, rows.Err()
}

// PendingCount is the number of entries waiting to sync.
func (d *DB) PendingCount(ctx context.Context) (int, error) {
	var n int
	err := d.db.QueryRowContext(ctx, "SELECT count(*) FROM outbox").Scan(&n)
	return n, err
}

// PushSucceeded records the server's answer. If the user typed while the
// request was in flight (rev moved on), the newer edits stay queued, now based
// on the version the server just confirmed.
func (d *DB) PushSucceeded(ctx context.Context, row OutboxRow, server model.Entry) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "UPDATE entries SET version = ?, server_seq = ? WHERE id = ?",
		server.Version, server.ServerSeq, row.EntryID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM outbox WHERE entry_id = ? AND rev = ?", row.EntryID, row.Rev); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE outbox SET base_version = ? WHERE entry_id = ?", server.Version, row.EntryID); err != nil {
		return err
	}
	return tx.Commit()
}

// PushConflict handles a 409: the local version is saved as a new "conflict
// copy" entry (queued as a create), the original takes the server's version,
// and the original outbox row is dropped. It returns the copy's id ("" if
// nothing was copied).
func (d *DB) PushConflict(ctx context.Context, row OutboxRow, current model.Entry) (string, error) {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	// Use the latest queued edit, not the one that was in flight.
	var op, payload string
	err = tx.QueryRowContext(ctx, "SELECT op, payload FROM outbox WHERE entry_id = ?", row.EntryID).Scan(&op, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		op, payload = row.Op, string(row.Payload)
	} else if err != nil {
		return "", err
	}

	copyID := ""
	if op == "put" {
		var req syncproto.PutEntryRequest
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			return "", err
		}
		// The copy keeps its parent and properties, so a conflicting database
		// record shows up as a second record. It loses its date, so it never
		// competes with the day's entry.
		cp := Draft{ID: uuid.Must(uuid.NewV7()).String(), Kind: req.Kind, ParentID: req.ParentID,
			Title: conflict.CopyTitle(req.Title), Body: req.Body, Meta: req.Meta}
		normalize(&cp)
		copyID = cp.ID
		now := d.stamp()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO entries (id, entry_date, kind, parent_id, title, body, body_text, meta, version, created_at, updated_at)
			VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
			cp.ID, cp.Kind, nullable(cp.ParentID), cp.Title, string(cp.Body), searchText(cp.Body, cp.Meta), string(cp.Meta), now, now); err != nil {
			return "", err
		}
		if err := setLinks(ctx, tx, cp.ID, cp.Body, cp.Meta); err != nil {
			return "", err
		}
		copyPayload, _ := json.Marshal(syncproto.PutEntryRequest{Kind: cp.Kind, ParentID: cp.ParentID, Title: cp.Title, Body: cp.Body, Meta: cp.Meta})
		if err := enqueue(ctx, tx, cp.ID, "put", copyPayload); err != nil {
			return "", err
		}
	}
	// For a delete that lost to an edit, the edit wins: nothing is copied.

	if err := d.upsertFromServer(ctx, tx, current); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM outbox WHERE entry_id = ?", row.EntryID); err != nil {
		return "", err
	}
	return copyID, tx.Commit()
}

// PushNotFound re-queues a put as a create (the server no longer has the
// entry), or drops a delete of an entry the server never had.
func (d *DB) PushNotFound(ctx context.Context, row OutboxRow) error {
	if row.Op == "delete" {
		_, err := d.db.ExecContext(ctx, "DELETE FROM outbox WHERE entry_id = ?", row.EntryID)
		return err
	}
	_, err := d.db.ExecContext(ctx, "UPDATE outbox SET base_version = 0 WHERE entry_id = ?", row.EntryID)
	if err == nil {
		_, err = d.db.ExecContext(ctx, "UPDATE entries SET version = 0 WHERE id = ?", row.EntryID)
	}
	return err
}

// PushFailed records an error. Permanent failures are skipped until the entry
// is edited again; others are retried at nextTry.
func (d *DB) PushFailed(ctx context.Context, row OutboxRow, msg string, permanent bool, nextTry time.Time) error {
	failed := 0
	if permanent {
		failed = 1
	}
	_, err := d.db.ExecContext(ctx, `UPDATE outbox SET attempts = attempts + 1, last_error = ?, failed = ?, next_try_at = ?
		WHERE entry_id = ? AND rev = ?`, msg, failed, nextTry.UTC().Format(tsFormat), row.EntryID, row.Rev)
	return err
}

// ApplyPull stores pulled changes and the new cursor in one transaction.
// Entries with a pending outbox row are skipped: the pull never overwrites
// text the user has not sent yet. It returns the ids that changed.
func (d *DB) ApplyPull(ctx context.Context, changes []model.Entry, cursor int64) ([]string, error) {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	ids := []string{}
	for _, c := range changes {
		var pending int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM outbox WHERE entry_id = ?", c.ID).Scan(&pending); err != nil {
			return nil, err
		}
		if pending > 0 {
			continue
		}
		if err := d.upsertFromServer(ctx, tx, c); err != nil {
			return nil, err
		}
		ids = append(ids, c.ID)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sync_state (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, KeyCursor, formatInt(cursor)); err != nil {
		return nil, err
	}
	return ids, tx.Commit()
}

// upsertFromServer stores the server's copy of an entry, recomputes its
// links, and notes any images it needs that are not on this computer yet.
func (d *DB) upsertFromServer(ctx context.Context, tx *sql.Tx, e model.Entry) error {
	body, meta := string(e.Body), string(e.Meta)
	if body == "" || body == "null" {
		body = emptyBody
	}
	if meta == "" || meta == "null" {
		meta = model.EmptyMeta
	}
	kind := e.Kind
	if kind == "" {
		kind = model.KindPage
	}
	var deleted any
	if e.DeletedAt != nil {
		deleted = e.DeletedAt.UTC().Format(tsFormat)
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO entries (id, entry_date, kind, parent_id, title, body, body_text, meta, version, server_seq, created_at, updated_at, deleted_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET entry_date = excluded.entry_date, kind = excluded.kind, parent_id = excluded.parent_id,
			title = excluded.title, body = excluded.body, body_text = excluded.body_text, meta = excluded.meta,
			version = excluded.version, server_seq = excluded.server_seq,
			created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
		e.ID, nullable(e.EntryDate), kind, nullable(e.ParentID), e.Title, body,
		searchText(json.RawMessage(body), json.RawMessage(meta)), meta,
		e.Version, e.ServerSeq, e.CreatedAt.UTC().Format(tsFormat), e.UpdatedAt.UTC().Format(tsFormat), deleted)
	if err != nil {
		return err
	}
	if err := setLinks(ctx, tx, e.ID, json.RawMessage(body), json.RawMessage(meta)); err != nil {
		return err
	}
	for _, h := range prosemirror.ExtractImages(json.RawMessage(body)) {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO blob_wanted (hash)
			SELECT ? WHERE NOT EXISTS (SELECT 1 FROM blobs WHERE hash = ?)`, h, h); err != nil {
			return err
		}
	}
	return nil
}

func nullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func formatInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
