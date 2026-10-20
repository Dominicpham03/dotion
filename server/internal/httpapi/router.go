// Package httpapi holds the HTTP handlers, SSE and middleware.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"diary/server/internal/core"
)

// UserResolver maps a login to its user id (the store's EnsureUser).
type UserResolver interface {
	EnsureUser(ctx context.Context, login string) (string, error)
}

type Deps struct {
	Entries       *core.EntryService
	Sync          *core.SyncService
	Notifier      core.Notifier
	Auth          core.Authenticator
	Users         UserResolver
	Blobs         core.Blobs
	Calendar      core.CalendarProvider // nil when Google is not configured
	Drive         core.DriveProvider    // the same Google client, or nil
	Integrations  core.IntegrationStore
	GitLab        *core.GitLabService
	Assistant     *core.AssistantService // nil-safe: Status reports off without a Gemini key
	Actions       *core.ActionsService   // nil without a Gemini key
	PublicURL     string
	Ping          func(ctx context.Context) error // database health
	AuthMode      string
	Log           *slog.Logger
	MaxEntryBytes int64
	Version       string
	WebUI         http.Handler
	PingInterval  time.Duration // SSE keep-alive, default 25 s
}

type Handler struct {
	deps    Deps
	userIDs sync.Map // login → user id
	states  authStates
}

// New builds the routes. /v1/* is registered first and never falls through to
// the web app.
func New(deps Deps) http.Handler {
	if deps.Log == nil {
		deps.Log = slog.New(slog.DiscardHandler)
	}
	if deps.PingInterval == 0 {
		deps.PingInterval = 25 * time.Second
	}
	if deps.MaxEntryBytes == 0 {
		deps.MaxEntryBytes = 2 << 20
	}
	h := &Handler{deps: deps}
	authed := h.requireUser

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", h.health) // no auth
	mux.HandleFunc("POST /v1/auth/login", h.login)
	mux.HandleFunc("POST /v1/auth/logout", h.logout)
	mux.Handle("GET /v1/me", authed(h.me))
	mux.Handle("GET /v1/sync", authed(h.sync))
	mux.Handle("PUT /v1/entries/{id}", authed(h.putEntry))
	mux.Handle("DELETE /v1/entries/{id}", authed(h.deleteEntry))
	mux.Handle("POST /v1/entries/{id}/restore", authed(h.restoreEntry))
	mux.Handle("POST /v1/entries/{id}/purge", authed(h.purgeEntry))
	mux.Handle("GET /v1/trash", authed(h.listTrash))
	mux.Handle("GET /v1/entries/{id}", authed(h.getEntry))
	mux.Handle("GET /v1/entries", authed(h.listEntries)) // ?from=&to=, ?recent=N, ?parent=ID or ?pages=1
	mux.Handle("GET /v1/entries/{id}/backlinks", authed(h.backlinks))
	mux.Handle("POST /v1/blobs", authed(h.putBlob))
	mux.Handle("GET /v1/blobs/{hash}", authed(h.getBlob))
	mux.Handle("GET /v1/search", authed(h.search)) // ?q=
	mux.Handle("GET /v1/integrations/google", authed(h.googleStatus))
	mux.Handle("POST /v1/integrations/google/start", authed(h.googleStart))
	mux.HandleFunc("GET /v1/integrations/google/callback", h.googleCallback) // the state identifies the user
	mux.Handle("DELETE /v1/integrations/google", authed(h.googleDisconnect))
	mux.Handle("GET /v1/calendar/events", authed(h.calendarEvents)) // ?start=&end=
	mux.Handle("POST /v1/calendar/events", authed(h.addCalendarEvent))
	mux.Handle("GET /v1/drive/files", authed(h.driveFiles))         // ?q=&page=
	mux.Handle("GET /v1/drive/files/{id}/markdown", authed(h.driveMarkdown))
	mux.Handle("GET /v1/integrations/gitlab", authed(h.gitlabStatus))
	mux.Handle("POST /v1/integrations/gitlab", authed(h.gitlabConnect))
	mux.Handle("POST /v1/integrations/gitlab/sync", authed(h.gitlabSync))
	mux.Handle("DELETE /v1/integrations/gitlab", authed(h.gitlabDisconnect))
	mux.Handle("GET /v1/ai", authed(h.aiStatus))
	mux.Handle("POST /v1/ai/chat", authed(h.aiChat))
	mux.Handle("GET /v1/ai/actions", authed(h.actionsStatus))
	mux.Handle("PUT /v1/ai/actions", authed(h.actionsConfigure))
	mux.Handle("POST /v1/ai/actions/scan", authed(h.actionsScan))
	mux.Handle("GET /v1/events", authed(h.events))
	mux.Handle("GET /v1/export", authed(h.export))
	mux.HandleFunc("/v1/", h.notFound)
	if deps.WebUI != nil {
		mux.Handle("/", deps.WebUI)
	}

	return chain(mux, h.recoverer, h.requestID, h.accessLog, securityHeaders, csrfGuard)
}
