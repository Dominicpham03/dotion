package core

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"diary/shared/syncproto"
)

// CalendarEvent is one event from a connected calendar, read-only.
type CalendarEvent = syncproto.CalendarEvent

// Grant is what a completed sign-in with the calendar provider yields.
type Grant struct {
	RefreshToken string
	Email        string
	Scopes       string // space-separated, as granted
}

// ErrGrantRevoked means the user withdrew access on the provider's side.
var ErrGrantRevoked = errors.New("calendar access was revoked")

// CalendarProvider talks to an external calendar (Google) on the user's behalf.
type CalendarProvider interface {
	AuthURL(state, redirectURI string) string
	Exchange(ctx context.Context, code, redirectURI string) (Grant, error)
	Events(ctx context.Context, refreshToken string, start, end time.Time) ([]CalendarEvent, error)
	Revoke(ctx context.Context, refreshToken string) error
}

// Integration is a stored connection to an external service. RefreshToken
// holds the secret (Google refresh token, GitLab access token); Config holds
// provider settings as JSON.
type Integration struct {
	Provider     string
	RefreshToken string
	Email        string
	Config       json.RawMessage
	CreatedAt    time.Time
}

// IntegrationStore keeps connections per user. GetIntegration returns
// ErrNotFound when there is none.
type IntegrationStore interface {
	GetIntegration(ctx context.Context, userID, provider string) (Integration, error)
	PutIntegration(ctx context.Context, userID string, in Integration) error
	DeleteIntegration(ctx context.Context, userID, provider string) error
	IntegrationUsers(ctx context.Context, provider string) ([]string, error)
}

// NewEvent is an event to add to the user's calendar. It is all-day when only
// Date is set (EndDate extends it over several days); when Start is set it is a
// timed event (Date/EndDate are then ignored).
type NewEvent struct {
	Key         string // a UUID that identifies the item: the same key never adds a second event
	Title       string
	Description string
	Date        string // YYYY-MM-DD (all-day start)
	EndDate     string // YYYY-MM-DD (all-day last day, inclusive; defaults to Date)
	Start       string // RFC 3339; when set, a timed event
	End         string // RFC 3339; end of a timed event (defaults to Start + 1h)
}

// CreatedEvent identifies an event added to the calendar.
type CreatedEvent struct {
	ID   string
	Link string // opens it in Google Calendar ("" when it already existed)
}

// ErrNoCalendarWrite means the connection may read the calendar but not add to it.
var ErrNoCalendarWrite = errors.New("no permission to add calendar events")

// CalendarWriter adds events to the user's calendar.
type CalendarWriter interface {
	CreateEvent(ctx context.Context, refreshToken string, ev NewEvent) (CreatedEvent, error)
}

// CalendarEventsScope lets Dotion add events; older connections lack it.
const CalendarEventsScope = "https://www.googleapis.com/auth/calendar.events"

// DriveProvider reads the user's Google Drive (read-only).
type DriveProvider interface {
	DriveSearch(ctx context.Context, refreshToken, query, pageToken string) ([]syncproto.DriveFile, string, error)
	DriveMarkdown(ctx context.Context, refreshToken, fileID string) (name, markdown string, err error)
}
