package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError maps core errors to a status and a stable error code.
func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var (
		conflict *core.ConflictError
		invalid  *core.ValidationError
		tooLarge *http.MaxBytesError
	)
	switch {
	case errors.As(err, &conflict):
		cur := conflict.Current
		writeJSON(w, http.StatusConflict, syncproto.ErrorResponse{
			Error: syncproto.CodeConflict, Message: "This entry was changed on another device.", Current: &cur,
		})
	case errors.As(err, &invalid):
		writeJSON(w, http.StatusBadRequest, syncproto.ErrorResponse{
			Error: syncproto.CodeInvalid, Message: "Some fields are not valid.", Fields: invalid.Fields,
		})
	case errors.As(err, &tooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, syncproto.ErrorResponse{
			Error: syncproto.CodeTooLarge, Message: "This entry is too large to save.",
		})
	case errors.Is(err, core.ErrUnauthenticated):
		writeJSON(w, http.StatusUnauthorized, syncproto.ErrorResponse{Error: syncproto.CodeUnauthenticated, Message: "Sign in to continue."})
	case errors.Is(err, core.ErrForbidden):
		writeJSON(w, http.StatusForbidden, syncproto.ErrorResponse{Error: syncproto.CodeForbidden, Message: "This account can't open this diary."})
	case errors.Is(err, core.ErrNotFound):
		writeJSON(w, http.StatusNotFound, syncproto.ErrorResponse{Error: syncproto.CodeNotFound, Message: "No such entry."})
	case errors.Is(err, core.ErrIdempotencyMismatch):
		writeJSON(w, http.StatusUnprocessableEntity, syncproto.ErrorResponse{
			Error: syncproto.CodeIdempotencyMismatch, Message: "This Idempotency-Key was already used for a different request.",
		})
	case errors.Is(err, core.ErrCursorAhead):
		writeJSON(w, http.StatusConflict, syncproto.ErrorResponse{
			Error: syncproto.CodeCursorAhead, Message: "The server was restored from a backup. Sync again from the start.",
		})
	case errors.Is(err, core.ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		writeJSON(w, http.StatusTooManyRequests, syncproto.ErrorResponse{Error: syncproto.CodeRateLimited, Message: "Too many attempts. Try again in a minute."})
	default:
		h.deps.Log.Error("internal error", "err", err, "path", r.URL.Path, "request_id", r.Context().Value(requestIDKey))
		writeJSON(w, http.StatusInternalServerError, syncproto.ErrorResponse{Error: syncproto.CodeInternal, Message: "Something went wrong on the server."})
	}
}
