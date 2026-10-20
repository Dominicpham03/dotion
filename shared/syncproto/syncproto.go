// Package syncproto defines the /v1 wire types and error codes used by the
// server and by the desktop sync client.
package syncproto

import (
	"encoding/json"

	"diary/shared/model"
)

const (
	HeaderIdempotencyKey = "Idempotency-Key"
	HeaderClient         = "X-Diary-Client" // CSRF guard, value "1"
	SessionCookie        = "diary_session"
)

// Stable machine-readable error codes (the "error" field of ErrorResponse).
const (
	CodeUnauthenticated     = "unauthenticated"
	CodeForbidden           = "forbidden"
	CodeNotFound            = "not_found"
	CodeConflict            = "conflict"
	CodeIdempotencyMismatch = "idempotency_mismatch"
	CodeTooLarge            = "too_large"
	CodeInvalid             = "invalid"
	CodeCursorAhead         = "cursor_ahead"
	CodeResyncRequired      = "resync_required"
	CodeRateLimited         = "rate_limited"
	CodeInternal            = "internal"
)

// PutEntryRequest is the body of PUT /v1/entries/{id}.
type PutEntryRequest struct {
	BaseVersion int             `json:"base_version"` // 0 = create
	EntryDate   *string         `json:"entry_date"`
	Kind        string          `json:"kind,omitempty"`      // "page" (default) or "database"
	ParentID    *string         `json:"parent_id,omitempty"` // parent page or database
	Title       string          `json:"title"`
	Body        json.RawMessage `json:"body"`
	Meta        json.RawMessage `json:"meta,omitempty"` // icon, properties, schema
}

// BlobResponse is the body of POST /v1/blobs.
type BlobResponse struct {
	Hash string `json:"hash"`
	URL  string `json:"url"` // /v1/blobs/<hash>, used as the image src
}

// SyncResponse is the body of GET /v1/sync.
type SyncResponse struct {
	Changes []model.Entry `json:"changes"`
	Cursor  int64         `json:"cursor"`
	HasMore bool          `json:"has_more"`
}

// EntriesResponse is the body of GET /v1/entries.
type EntriesResponse struct {
	Entries []model.Entry `json:"entries"`
}

// SearchHit is one result of GET /v1/search.
type SearchHit struct {
	ID        string  `json:"id"`
	EntryDate *string `json:"entry_date"`
	Title     string  `json:"title"`
	Snippet   string  `json:"snippet"` // matches wrapped in [ ]
}

// SearchResponse is the body of GET /v1/search.
type SearchResponse struct {
	Hits []SearchHit `json:"hits"`
}

// ChangedEvent is the data of the SSE "changed" event on /v1/events.
type ChangedEvent struct {
	Cursor int64 `json:"cursor"`
}

type LoginRequest struct {
	Password string `json:"password"`
}

// LoginResponse carries the token for the desktop app; the web app uses the cookie.
type LoginResponse struct {
	Login     string `json:"login"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

type MeResponse struct {
	Login    string `json:"login"`
	AuthMode string `json:"auth_mode"`
}

type HealthResponse struct {
	Status  string `json:"status"`
	DB      string `json:"db"`
	Version string `json:"version"`
}

type ErrorResponse struct {
	Error   string            `json:"error"`
	Message string            `json:"message,omitempty"`
	Current *model.Entry      `json:"current,omitempty"` // set on conflict
	Fields  map[string]string `json:"fields,omitempty"`  // set on invalid
}

// CalendarEvent is one event from a connected calendar, read-only.
type CalendarEvent struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Start    string `json:"start"` // "2026-10-05" when all-day, else RFC 3339
	End      string `json:"end"`   // exclusive, same format as Start
	AllDay   bool   `json:"all_day"`
	Location string `json:"location,omitempty"`
	Link     string `json:"link,omitempty"` // opens the event in Google Calendar
	Calendar string `json:"calendar"`       // calendar name
	Color    string `json:"color,omitempty"`
}

// EventsResponse is the body of GET /v1/calendar/events.
type EventsResponse struct {
	Connected bool            `json:"connected"`
	Events    []CalendarEvent `json:"events"`
}

// AddEventRequest is the body of POST /v1/calendar/events, added to the user's
// primary ("general") calendar. All-day when only Date is set (optionally
// through EndDate for a multi-day span); a timed event when Start (and
// optionally End) is set — Start and End may fall on different days.
type AddEventRequest struct {
	Title       string `json:"title"`
	Date        string `json:"date"`               // YYYY-MM-DD (all-day start)
	EndDate     string `json:"end_date,omitempty"` // YYYY-MM-DD (all-day last day, inclusive)
	Start       string `json:"start,omitempty"`    // RFC 3339 (timed event)
	End         string `json:"end,omitempty"`      // RFC 3339 (timed event end)
	Description string `json:"description,omitempty"`
}

// AddEventResponse identifies the event that POST /v1/calendar/events created.
type AddEventResponse struct {
	ID   string `json:"id"`
	Link string `json:"link,omitempty"` // opens it in Google Calendar
}

// GoogleStatus is the body of GET /v1/integrations/google.
type GoogleStatus struct {
	Configured  bool   `json:"configured"`
	Connected   bool   `json:"connected"`
	Email       string `json:"email,omitempty"`
	RedirectURI string `json:"redirect_uri"`
	Drive       bool   `json:"drive"` // the connection includes read access to Google Drive
	// CalendarWrite: the connection may add events (action items). Older ones must reconnect.
	CalendarWrite bool `json:"calendar_write"`
}

// DriveFile is one Google Drive file, as listed by GET /v1/drive/files.
type DriveFile struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MimeType  string `json:"mime_type"`
	Modified  string `json:"modified"` // RFC 3339
	Link      string `json:"link"`     // opens the file in Google Drive
	IconLink  string `json:"icon_link,omitempty"`
	Owner     string `json:"owner,omitempty"`
	CanImport bool   `json:"can_import"` // a Google Doc: can become a Dotion page
}

// DriveFilesResponse is the body of GET /v1/drive/files.
type DriveFilesResponse struct {
	Connected bool        `json:"connected"` // Drive permission granted
	Files     []DriveFile `json:"files"`
	Next      string      `json:"next,omitempty"` // page token
}

// DriveMarkdownResponse is the body of GET /v1/drive/files/{id}/markdown.
type DriveMarkdownResponse struct {
	Name     string `json:"name"`
	Markdown string `json:"markdown"`
}

// GitLabStatus is the body of GET /v1/integrations/gitlab.
type GitLabStatus struct {
	Connected  bool   `json:"connected"`
	URL        string `json:"url,omitempty"`
	Username   string `json:"username,omitempty"`
	DatabaseID string `json:"database_id,omitempty"` // the "GitLab" database
	LastSync   string `json:"last_sync,omitempty"`
	LastError  string `json:"last_error,omitempty"`
}

// GitLabConnectRequest is the body of POST /v1/integrations/gitlab.
type GitLabConnectRequest struct {
	URL   string `json:"url"`   // https://gitlab.com or your own GitLab
	Token string `json:"token"` // a personal access token with the "api" scope
}

// GitLabSyncResponse is the body of POST /v1/integrations/gitlab/sync.
type GitLabSyncResponse struct {
	Created int `json:"created"`
	Updated int `json:"updated"`
	Pushed  int `json:"pushed"`
}

// AIStatus is the body of GET /v1/ai.
type AIStatus struct {
	Enabled  bool   `json:"enabled"` // the server has an AI model configured
	Model    string `json:"model,omitempty"`
	Provider string `json:"provider,omitempty"` // "claude", "ollama" or "gemini"
	Local    bool   `json:"local"`              // the model runs on the user's own machine
}

// AIMessage is one turn of an assistant conversation. Role is "user" or "model".
type AIMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// AIChatRequest is the body of POST /v1/ai/chat. The client keeps the
// conversation and sends all of it each time.
type AIChatRequest struct {
	Messages []AIMessage `json:"messages"`
	EntryID  string      `json:"entry_id,omitempty"` // the page open on screen, if any
	Now      string      `json:"now"`                // the client's clock, RFC 3339 with its UTC offset
}

// AISource is a page the assistant read while answering.
type AISource struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	EntryDate *string `json:"entry_date"`
}

// AIProposal is a page the assistant drafted. Nothing is saved until the
// user chooses to create it.
type AIProposal struct {
	Title    string `json:"title"`
	Markdown string `json:"markdown"`
	ParentID string `json:"parent_id,omitempty"`
}

// AIChatResponse is the body of POST /v1/ai/chat.
type AIChatResponse struct {
	Text      string       `json:"text"` // Markdown; [Title](dotion:<id>) links to a page
	Sources   []AISource   `json:"sources"`
	Proposals []AIProposal `json:"proposals"`
}

// ActionItem is a task for the user, with a due date, found in a note.
type ActionItem struct {
	ID          string `json:"id"` // its record in the Action items database
	Title       string `json:"title"`
	Due         string `json:"due"` // YYYY-MM-DD
	SourceID    string `json:"source_id"`
	SourceTitle string `json:"source_title"`
	EventLink   string `json:"event_link,omitempty"` // the Google Calendar event, when one was added
}

// ActionsStatus is the body of GET and PUT /v1/ai/actions.
type ActionsStatus struct {
	Enabled           bool     `json:"enabled"` // scan changed notes automatically
	Names             []string `json:"names"`
	DatabaseID        string   `json:"database_id"`
	LastScan          string   `json:"last_scan,omitempty"`
	LastError         string   `json:"last_error,omitempty"`
	CalendarConnected bool     `json:"calendar_connected"`
	CalendarWrite     bool     `json:"calendar_write"` // the Google connection may add events
}

// ActionsConfigRequest is the body of PUT /v1/ai/actions.
type ActionsConfigRequest struct {
	Enabled bool     `json:"enabled"`
	Names   []string `json:"names"`
}

// ActionsScanRequest is the body of POST /v1/ai/actions/scan.
type ActionsScanRequest struct {
	EntryID string `json:"entry_id,omitempty"` // one note now; empty: every changed note
}

// ActionsScanResponse is the body of POST /v1/ai/actions/scan.
type ActionsScanResponse struct {
	Scanned int          `json:"scanned"`
	Created []ActionItem `json:"created"`
}
