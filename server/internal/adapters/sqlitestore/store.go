// Package sqlitestore is the SQLite implementation of core.Store.
package sqlitestore

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

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"

	"diary/server/migrations"
)

const (
	basePragmas  = "_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	writePragmas = basePragmas + "&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"

	// tsFormat has a fixed width, so stored timestamps sort as text.
	tsFormat = "2006-01-02T15:04:05.000Z"
)

// Store holds two pools on the same file: SQLite allows many readers but only
// one writer at a time.
type Store struct {
	path   string
	writer *sql.DB
	reader *sql.DB
	now    func() time.Time
}

type Option func(*Store)

// WithClock replaces the wall clock, for deterministic tests.
func WithClock(now func() time.Time) Option { return func(s *Store) { s.now = now } }

// Open opens (and creates if needed) the database file at path.
func Open(path string, opts ...Option) (*Store, error) {
	uri, err := fileURI(path)
	if err != nil {
		return nil, err
	}

	// _txlock=immediate takes the write lock at BEGIN, which avoids the
	// "upgrade from read to write lock" deadlock.
	writer, err := sql.Open("sqlite", uri+"?"+writePragmas+"&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("open writer: %w", err)
	}
	writer.SetMaxOpenConns(1) // serialise writes in Go, not via SQLITE_BUSY
	if err := writer.Ping(); err != nil {
		writer.Close()
		return nil, fmt.Errorf("open writer: %w", err)
	}

	// Opened after the writer, so the file exists and is already in WAL mode.
	reader, err := sql.Open("sqlite", uri+"?"+basePragmas+"&mode=ro")
	if err != nil {
		writer.Close()
		return nil, fmt.Errorf("open reader: %w", err)
	}
	reader.SetMaxOpenConns(4)
	if err := reader.Ping(); err != nil {
		writer.Close()
		reader.Close()
		return nil, fmt.Errorf("open reader: %w", err)
	}

	s := &Store{path: path, writer: writer, reader: reader, now: func() time.Time { return time.Now().UTC() }}
	for _, o := range opts {
		o(s)
	}
	return s, nil
}

// Migrate applies all pending migrations embedded in the binary. If the
// database already holds data, it is backed up first (diary-pre-NNNN.db).
func (s *Store) Migrate(ctx context.Context) error {
	p, err := goose.NewProvider(goose.DialectSQLite3, s.writer, migrations.FS)
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	pending, err := p.HasPending(ctx)
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	if !pending {
		return nil
	}
	if current, err := p.GetDBVersion(ctx); err == nil && current > 0 {
		dst := filepath.Join(filepath.Dir(s.path), "backups", fmt.Sprintf("diary-pre-%04d.db", current+1))
		if err := s.Backup(ctx, dst); err != nil {
			return fmt.Errorf("backup before migrating: %w", err)
		}
	}
	if _, err := p.Up(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// EnsureUser returns the id of the user with this login, creating it on first use.
func (s *Store) EnsureUser(ctx context.Context, login string) (string, error) {
	if login == "" {
		return "", errors.New("empty login")
	}
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	var userID string
	err = s.writer.QueryRowContext(ctx,
		`INSERT INTO users (id, login, created_at) VALUES (?, ?, ?)
		 ON CONFLICT (login) DO UPDATE SET login = excluded.login
		 RETURNING id`,
		id.String(), login, s.stamp(),
	).Scan(&userID)
	if err != nil {
		return "", fmt.Errorf("ensure user: %w", err)
	}
	return userID, nil
}

// Ping checks that the database answers a query.
func (s *Store) Ping(ctx context.Context) error {
	var one int
	return s.reader.QueryRowContext(ctx, "SELECT 1").Scan(&one)
}

// Backup writes a consistent, compacted copy of the database to dst without
// stopping the server, then truncates the WAL.
func (s *Store) Backup(ctx context.Context, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	_ = os.Remove(dst) // VACUUM INTO refuses to overwrite
	if _, err := s.writer.ExecContext(ctx, "VACUUM INTO ?", dst); err != nil {
		return fmt.Errorf("vacuum into: %w", err)
	}
	_, _ = s.writer.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")
	return nil
}

// CleanupLoop deletes idempotency records older than 7 days, once an hour,
// and runs PRAGMA optimize once a day.
func (s *Store) CleanupLoop(ctx context.Context) {
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for n := 0; ; n++ {
		_, _ = s.DeleteOldIdempotency(ctx, 7*24*time.Hour)
		if n%24 == 23 {
			_, _ = s.writer.ExecContext(ctx, "PRAGMA optimize")
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// Close releases both pools.
func (s *Store) Close() error {
	_, _ = s.writer.Exec("PRAGMA optimize")
	return errors.Join(s.reader.Close(), s.writer.Close())
}

func (s *Store) stamp() string { return s.now().UTC().Format(tsFormat) }

// fileURI turns a file path into a SQLite URI, escaping spaces and the like.
func fileURI(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // Windows: C:/x → /C:/x
	}
	return "file://" + (&url.URL{Path: p}).EscapedPath(), nil
}
