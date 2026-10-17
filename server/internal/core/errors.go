package core

import (
	"errors"
	"sort"
	"strings"

	"diary/shared/model"
)

var (
	ErrUnauthenticated     = errors.New("unauthenticated")
	ErrForbidden           = errors.New("forbidden")
	ErrNotFound            = errors.New("not found")
	ErrConflict            = errors.New("version conflict") // carries current entry
	ErrIdempotencyMismatch = errors.New("idempotency key reused with a different request")
	ErrCursorAhead         = errors.New("cursor ahead of server")
	ErrResyncRequired      = errors.New("cursor too old") // reserved, see BACKEND.md §8.6
	ErrRateLimited         = errors.New("too many attempts")
)

// ConflictError is returned when a write is not based on the latest version.
type ConflictError struct{ Current model.Entry }

func (e *ConflictError) Error() string { return "version conflict" }
func (e *ConflictError) Unwrap() error { return ErrConflict }

// ValidationError lists invalid request fields.
type ValidationError struct{ Fields map[string]string }

func (e *ValidationError) Error() string {
	keys := make([]string, 0, len(e.Fields))
	for k := range e.Fields {
		keys = append(keys, k+": "+e.Fields[k])
	}
	sort.Strings(keys)
	return "invalid request: " + strings.Join(keys, "; ")
}
