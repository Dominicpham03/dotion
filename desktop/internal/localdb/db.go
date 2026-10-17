// Package localdb is the desktop app's own SQLite database: a full copy of
// the entries for offline use, the outbox of unsent changes, and sync state.
package localdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const tsFormat = "2006-01-02T15:04:05.000Z"

// DB wraps one connection pool. The desktop app is the only process using the
// file (Wails' single-instance lock), so one writer connection is enough.
type DB struct {
	db  *sql.DB
	dir string // folder holding diary.db and blobs/
	now func() time.Time
}

// Open opens (and creates) the database at path and applies migrations.
func Open(path string) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return nil, err
	}
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	dsn := "file://" + (&url.URL{Path: p}).EscapedPath() +
		"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	d := &DB{db: db, dir: filepath.Dir(abs), now: func() time.Time { return time.Now().UTC() }}
	if err := d.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return d, nil
}

func (d *DB) Close() error { return d.db.Close() }

func (d *DB) stamp() string { return d.now().UTC().Format(tsFormat) }

var migrations = []string{
	// 1: FRONTEND.md §8.2
	`CREATE TABLE entries (
	  id          TEXT PRIMARY KEY,
	  entry_date  TEXT,
	  title       TEXT NOT NULL DEFAULT '',
	  body        TEXT NOT NULL,
	  body_text   TEXT NOT NULL DEFAULT '',
	  version     INTEGER NOT NULL,     -- last version confirmed by the server (0 = never synced)
	  server_seq  INTEGER,
	  created_at  TEXT NOT NULL,
	  updated_at  TEXT NOT NULL,
	  deleted_at  TEXT
	);
	CREATE INDEX entries_date ON entries(entry_date) WHERE deleted_at IS NULL;

	CREATE TABLE outbox (
	  entry_id      TEXT PRIMARY KEY,
	  op            TEXT NOT NULL,      -- 'put' | 'delete'
	  payload       TEXT NOT NULL,      -- JSON body for PUT
	  base_version  INTEGER NOT NULL,   -- server version these edits started from
	  rev           INTEGER NOT NULL,   -- bumped on every local edit
	  idem_key      TEXT NOT NULL,      -- regenerated whenever rev changes
	  attempts      INTEGER NOT NULL DEFAULT 0,
	  next_try_at   TEXT,
	  last_error    TEXT,
	  failed        INTEGER NOT NULL DEFAULT 0  -- rejected by the server; skipped until edited again
	);

	CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

	CREATE VIRTUAL TABLE entries_fts USING fts5(
	  title, body_text, content='entries', content_rowid='rowid', tokenize='porter unicode61'
	);
	CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
	  INSERT INTO entries_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
	END;
	CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
	  INSERT INTO entries_fts(entries_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
	END;
	CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
	  INSERT INTO entries_fts(entries_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
	  INSERT INTO entries_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
	END;`,
	// 2: pages, databases, links, images
	`ALTER TABLE entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';
	ALTER TABLE entries ADD COLUMN parent_id TEXT;
	ALTER TABLE entries ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
	CREATE INDEX entries_parent ON entries(parent_id) WHERE deleted_at IS NULL;

	CREATE TABLE entry_links (from_id TEXT NOT NULL, to_id TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
	CREATE INDEX entry_links_to ON entry_links(to_id);

	-- Images stored in <dir>/blobs/<hash>. uploaded=0: added offline, not on the server yet.
	CREATE TABLE blobs (hash TEXT PRIMARY KEY, content_type TEXT NOT NULL, size INTEGER NOT NULL, uploaded INTEGER NOT NULL);
	-- Images referenced by pulled entries but not downloaded yet.
	CREATE TABLE blob_wanted (hash TEXT PRIMARY KEY);`,
}

// migrate applies the statements above in order, tracked by PRAGMA user_version.
func (d *DB) migrate(ctx context.Context) error {
	var current int
	if err := d.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	for i := current; i < len(migrations); i++ {
		tx, err := d.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("local migration %d: %w", i+1, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// ---- sync_state -----------------------------------------------------------

const (
	KeyCursor     = "cursor"
	KeyServerURL  = "server_url"
	KeyLogin      = "login"
	KeyLastSyncAt = "last_sync_at"
)

func (d *DB) State(ctx context.Context, key string) (string, error) {
	var v string
	err := d.db.QueryRowContext(ctx, "SELECT value FROM sync_state WHERE key = ?", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (d *DB) SetState(ctx context.Context, key, value string) error {
	_, err := d.db.ExecContext(ctx,
		"INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value)
	return err
}

func (d *DB) DeleteState(ctx context.Context, keys ...string) error {
	for _, k := range keys {
		if _, err := d.db.ExecContext(ctx, "DELETE FROM sync_state WHERE key = ?", k); err != nil {
			return err
		}
	}
	return nil
}
