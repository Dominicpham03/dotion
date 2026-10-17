package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"time"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

// login exists only in password mode.
func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	pl, ok := h.deps.Auth.(core.PasswordLogin)
	if !ok {
		h.notFound(w, r)
		return
	}
	var req syncproto.LoginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"password": "is required"}})
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	login, token, expires, err := pl.Login(r.Context(), req.Password, ip)
	if err != nil {
		h.deps.Log.Warn("login failed", "ip", ip, "err", err)
		h.writeError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: syncproto.SessionCookie, Value: token, Path: "/", Expires: expires,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, syncproto.LoginResponse{Login: login, Token: token, ExpiresAt: expires.UTC().Format(time.RFC3339)})
}

func (h *Handler) logout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: syncproto.SessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(http.StatusNoContent)
}
