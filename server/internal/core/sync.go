package core

import "context"

const (
	DefaultSyncLimit = 500
	MaxSyncLimit     = 500
)

// SyncService serves the change log to clients.
type SyncService struct{ store Store }

func NewSyncService(store Store) *SyncService { return &SyncService{store: store} }

func (s *SyncService) Changes(ctx context.Context, userID string, since int64, limit int) (ChangePage, error) {
	if since < 0 {
		return ChangePage{}, &ValidationError{Fields: map[string]string{"since": "must be 0 or more"}}
	}
	if limit <= 0 || limit > MaxSyncLimit {
		limit = DefaultSyncLimit
	}
	return s.store.ChangesSince(ctx, userID, since, limit)
}
