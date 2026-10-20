// Package core holds the use cases and the ports (interfaces) they depend on.
// It imports nothing from adapters or httpapi.
package core

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"diary/shared/model"
	"diary/shared/syncproto"
)

type Store interface {
	GetEntry(ctx context.Context, userID, id string) (model.Entry, error)
	PutEntry(ctx context.Context, userID string, in PutInput) (model.Entry, error)
	DeleteEntry(ctx context.Context, userID string, in DeleteInput) (model.Entry, error)
	RestoreEntry(ctx context.Context, userID string, in DeleteInput) (model.Entry, error)
	PurgeEntry(ctx context.Context, userID string, in DeleteInput) (model.Entry, error)
	ListTrash(ctx context.Context, userID string, limit int) ([]model.Entry, error)
	ChangesSince(ctx context.Context, userID string, cursor int64, limit int) (ChangePage, error)
	ListByDate(ctx context.Context, userID, from, to string) ([]model.Entry, error)
	ListRecent(ctx context.Context, userID string, limit int) ([]model.Entry, error)
	ListChildren(ctx context.Context, userID, parentID string) ([]model.Entry, error)
	ListRootPages(ctx context.Context, userID string) ([]model.Entry, error)
	Backlinks(ctx context.Context, userID, id string) ([]model.Entry, error)
	AllEntries(ctx context.Context, userID string) ([]model.Entry, error)
	Search(ctx context.Context, userID, query string, limit int) ([]SearchHit, error)
	EnsureUser(ctx context.Context, login string) (userID string, err error)
	Ping(ctx context.Context) error
}

type PutInput struct {
	ID, IdemKey string
	BaseVersion int // 0 = create
	EntryDate   *string
	Kind        string  // model.KindPage or model.KindDatabase
	ParentID    *string // parent page, or the database of a record
	Title       string
	Body        json.RawMessage
	BodyText    string
	Meta        json.RawMessage
	Links       []string // ids this entry points to (page links, views, relations)
	RequestHash [32]byte // sha256 of the request, for idempotency checks
}

type DeleteInput struct {
	ID, IdemKey string
	BaseVersion int
	RequestHash [32]byte
}

type ChangePage struct {
	Changes []model.Entry
	Cursor  int64 // pass back as ?since=
	HasMore bool
}

type SearchHit = syncproto.SearchHit

// BlobInfo describes a stored image.
type BlobInfo struct {
	Hash, ContentType string
	Size              int64
	CreatedAt         time.Time
}

// Blobs stores images, content-addressed by sha256.
type Blobs interface {
	PutBlob(ctx context.Context, userID, contentType string, data []byte) (hash string, err error)
	// OpenBlob returns ErrNotFound unless this user stored the blob.
	OpenBlob(ctx context.Context, userID, hash string) (BlobInfo, io.ReadSeekCloser, error)
}

type Notifier interface {
	Publish(ctx context.Context, userID string, cursor int64) error
	Subscribe(ctx context.Context, userID string) (updates <-chan int64, cancel func())
	CloseAll()
}

type Authenticator interface {
	// Identify returns the stable login for this request, or
	// ErrUnauthenticated / ErrForbidden.
	Identify(r *http.Request) (login string, err error)
}

// PasswordLogin is implemented by authenticators that sign people in with a
// password (password mode only).
type PasswordLogin interface {
	Login(ctx context.Context, password, clientIP string) (login, token string, expires time.Time, err error)
}

type Clock interface{ Now() time.Time }

type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now().UTC() }
