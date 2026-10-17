package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"runtime/debug"
	"time"

	"diary/shared/syncproto"
)

type ctxKey int

const (
	userIDKey ctxKey = iota
	loginKey
	requestIDKey
)

// chain wraps h so the first middleware listed is the outermost.
func chain(h http.Handler, mw ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

// recoverer turns a panic into a logged 500 instead of a crashed process.
func (h *Handler) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				h.deps.Log.Error("panic", "err", v, "path", r.URL.Path, "stack", string(debug.Stack()))
				writeJSON(w, http.StatusInternalServerError, syncproto.ErrorResponse{Error: syncproto.CodeInternal, Message: "Something went wrong on the server."})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" || len(id) > 64 {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			id = hex.EncodeToString(b)
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

// Unwrap lets http.ResponseController reach Flush and SetWriteDeadline.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// accessLog writes one line per request. Entry content is never logged.
func (h *Handler) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		h.deps.Log.Info("request",
			"method", r.Method, "path", r.URL.Path, "status", rec.status,
			"ms", time.Since(start).Milliseconds(), "request_id", r.Context().Value(requestIDKey))
	})
}

func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
		"font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Security-Policy", csp)
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

// csrfGuard requires X-Diary-Client: 1 on every state-changing /v1 request.
// Browsers cannot send a custom header cross-site without a CORS preflight,
// which this server never approves (it emits no CORS headers at all).
func csrfGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if r.Header.Get(syncproto.HeaderClient) != "1" {
				writeJSON(w, http.StatusForbidden, syncproto.ErrorResponse{
					Error: syncproto.CodeForbidden, Message: "Missing the " + syncproto.HeaderClient + " header.",
				})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// requireUser resolves the caller to a user id, or answers 401/403.
func (h *Handler) requireUser(fn http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		login, err := h.deps.Auth.Identify(r)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		userID, ok := h.userIDs.Load(login)
		if !ok {
			id, err := h.deps.Users.EnsureUser(r.Context(), login)
			if err != nil {
				h.writeError(w, r, err)
				return
			}
			h.userIDs.Store(login, id)
			userID = id
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID.(string))
		ctx = context.WithValue(ctx, loginKey, login)
		fn(w, r.WithContext(ctx))
	})
}

func userFrom(ctx context.Context) string  { s, _ := ctx.Value(userIDKey).(string); return s }
func loginFrom(ctx context.Context) string { s, _ := ctx.Value(loginKey).(string); return s }
