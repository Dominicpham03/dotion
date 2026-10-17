package sqlitestore

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	migrations "diary/server/migrations"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data dir") // space checks URI escaping
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(dir, "diary.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return s
}

func TestOpenAndMigrate(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()

	for _, name := range []string{"users", "entries", "seq_counters", "idempotency", "entries_fts"} {
		var n int
		if err := s.reader.QueryRowContext(ctx,
			`SELECT count(*) FROM sqlite_master WHERE name = ?`, name).Scan(&n); err != nil || n != 1 {
			t.Errorf("table %s: count=%d err=%v", name, n, err)
		}
	}

	var mode string
	if err := s.writer.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Errorf("journal_mode = %q, err=%v, want wal", mode, err)
	}
	var fk int
	if err := s.writer.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Errorf("writer foreign_keys = %d, err=%v, want 1", fk, err)
	}

	// Running again with nothing pending is a no-op.
	if err := s.Migrate(ctx); err != nil {
		t.Errorf("second Migrate: %v", err)
	}
}

func TestReaderIsReadOnly(t *testing.T) {
	s := openTemp(t)
	_, err := s.reader.Exec(`INSERT INTO users (id, login, created_at) VALUES ('x', 'x', 'x')`)
	if err == nil {
		t.Fatal("write through the reader pool succeeded, want an error")
	}
}

func TestEnsureUser(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()

	a, err := s.EnsureUser(ctx, "you@github")
	if err != nil || a == "" {
		t.Fatalf("EnsureUser: id=%q err=%v", a, err)
	}
	again, err := s.EnsureUser(ctx, "you@github")
	if err != nil || again != a {
		t.Errorf("second call: id=%q err=%v, want %q", again, err, a)
	}
	b, err := s.EnsureUser(ctx, "other@github")
	if err != nil || b == a {
		t.Errorf("other login: id=%q err=%v, want a different id", b, err)
	}
	if _, err := s.EnsureUser(ctx, ""); err == nil {
		t.Error("empty login: want an error")
	}
}

func TestSearchIndexFollowsEntries(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	user, err := s.EnsureUser(ctx, "you@github")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.writer.ExecContext(ctx,
		`INSERT INTO entries (id, user_id, title, body_text, version, server_seq, created_at, updated_at)
		 VALUES ('e1', ?, 'Monday', 'walked along the river', 1, 1, 't', 't')`, user)
	if err != nil {
		t.Fatalf("insert entry: %v", err)
	}
	var n int
	if err := s.reader.QueryRowContext(ctx,
		`SELECT count(*) FROM entries_fts WHERE entries_fts MATCH 'walking'`).Scan(&n); err != nil || n != 1 {
		t.Errorf("fts match (porter stemming): count=%d err=%v, want 1", n, err)
	}
	// Foreign keys are enforced: an entry needs an existing user.
	_, err = s.writer.ExecContext(ctx,
		`INSERT INTO entries (id, user_id, version, server_seq, created_at, updated_at)
		 VALUES ('e2', 'nobody', 1, 2, 't', 't')`)
	if err == nil {
		t.Error("entry with unknown user_id was accepted, want a foreign key error")
	}
}

func TestBlobsAreContentAddressedAndPerUser(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	a, _ := s.EnsureUser(ctx, "a@test")
	b, _ := s.EnsureUser(ctx, "b@test")
	png := []byte("\x89PNG\r\n\x1a\nfake image bytes")

	h1, err := s.PutBlob(ctx, a, "image/png", png)
	if err != nil || len(h1) != 64 {
		t.Fatalf("PutBlob = %q, %v", h1, err)
	}
	h2, _ := s.PutBlob(ctx, a, "image/png", png)
	if h2 != h1 {
		t.Error("same bytes gave a different hash")
	}
	info, f, err := s.OpenBlob(ctx, a, h1)
	if err != nil || info.Size != int64(len(png)) || info.ContentType != "image/png" {
		t.Fatalf("OpenBlob = %+v, %v", info, err)
	}
	f.Close()
	if _, _, err := s.OpenBlob(ctx, b, h1); err == nil {
		t.Error("another user opened the blob")
	}
}

func TestUpgradeFromFirstSchemaKeepsEntries(t *testing.T) {
	// A database created by migration 1 only must upgrade and keep its rows.
	dir := t.TempDir()
	path := filepath.Join(dir, "diary.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.writer.ExecContext(ctx, `
		CREATE TABLE goose_db_version (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, is_applied INTEGER NOT NULL, tstamp TIMESTAMP DEFAULT (datetime('now')));
		INSERT INTO goose_db_version (version_id, is_applied) VALUES (0, 1);`); err != nil {
		t.Fatal(err)
	}
	v1, _ := migrations.FS.ReadFile("0001_init.sql")
	up := strings.SplitN(strings.SplitN(string(v1), "-- +goose Down", 2)[0], "-- +goose Up", 2)[1]
	up = strings.NewReplacer("-- +goose StatementBegin", "", "-- +goose StatementEnd", "").Replace(up)
	if _, err := s.writer.ExecContext(ctx, up+`
		INSERT INTO goose_db_version (version_id, is_applied) VALUES (1, 1);
		INSERT INTO users VALUES ('u1', 'old@test', 't');
		INSERT INTO entries (id, user_id, title, body_text, version, server_seq, created_at, updated_at)
		VALUES ('e1', 'u1', 'Old entry', 'from before', 1, 1, 't', 't');`); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	e, err := s.GetEntry(ctx, "u1", "e1")
	if err != nil || e.Title != "Old entry" || e.Kind != "page" || string(e.Meta) != "{}" {
		t.Errorf("after upgrade = %+v, %v", e, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "backups", "diary-pre-0002.db")); err != nil {
		t.Errorf("no pre-migration backup: %v", err)
	}
	s.Close()
}
