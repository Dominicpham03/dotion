// Package testserver starts a real diary server (SQLite in a temp directory)
// for end-to-end tests, including the desktop sync engine's tests in the
// desktop module. Not used by the production binary.
package testserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"time"

	"diary/server/internal/adapters/memnotifier"
	"diary/server/internal/adapters/sqlitestore"
	"diary/server/internal/core"
	"diary/server/internal/httpapi"
)

// Server is a running test server.
type Server struct {
	*httptest.Server
	store    *sqlitestore.Store
	notifier *memnotifier.Notifier
	dir      string
}

type ownerAuth struct{}

func (ownerAuth) Identify(*http.Request) (string, error) { return "owner@test", nil }

// Start runs a server whose every request is the owner. dir must be an empty
// temporary directory.
func Start(dir string) (*Server, error) {
	store, err := sqlitestore.Open(filepath.Join(dir, "diary.db"))
	if err != nil {
		return nil, err
	}
	if err := store.Migrate(context.Background()); err != nil {
		store.Close()
		return nil, err
	}
	n := memnotifier.New()
	h := httpapi.New(httpapi.Deps{
		Entries: core.NewEntryService(store, n), Sync: core.NewSyncService(store), Notifier: n,
		Auth: ownerAuth{}, Users: store, Blobs: store, Ping: store.Ping, AuthMode: "test",
		Version: "test", PingInterval: time.Second,
	})
	return &Server{Server: httptest.NewServer(h), store: store, notifier: n, dir: dir}, nil
}

// Backup writes a snapshot of the current database to path.
func (s *Server) Backup(path string) error { return s.store.Backup(context.Background(), path) }

func (s *Server) Close() {
	s.notifier.CloseAll()
	s.Server.CloseClientConnections()
	s.Server.Close()
	s.store.Close()
}
