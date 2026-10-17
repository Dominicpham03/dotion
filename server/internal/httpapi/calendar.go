package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"net/http"
	"strings"
	"sync"
	"time"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

const googleProvider = "google"

// pendingAuth remembers an in-progress Google sign-in. The callback arrives
// as a cross-site navigation from Google, which carries no SameSite=Strict
// session cookie, so the single-use state is what ties it to the user.
type pendingAuth struct {
	userID   string
	redirect string // the redirect URI sent to Google (must match on exchange)
	client   string // "web": back to /settings; "app": a "you can close this" page
	expires  time.Time
}

type authStates struct {
	mu sync.Mutex
	m  map[string]pendingAuth
}

func (a *authStates) put(p pendingAuth) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	state := hex.EncodeToString(b)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.m == nil {
		a.m = map[string]pendingAuth{}
	}
	for k, v := range a.m { // drop expired ones
		if time.Now().After(v.expires) {
			delete(a.m, k)
		}
	}
	a.m[state] = p
	return state
}

func (a *authStates) take(state string) (pendingAuth, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, ok := a.m[state]
	delete(a.m, state)
	return p, ok && time.Now().Before(p.expires)
}

type googleStatus = syncproto.GoogleStatus

// redirectURI is the callback Google sends the user back to. It must be
// listed in the OAuth client's "Authorized redirect URIs".
func (h *Handler) redirectURI(r *http.Request) string {
	base := h.deps.PublicURL
	if base == "" {
		host := r.Host
		scheme := "https" // behind tailscale serve the request itself is plain HTTP
		if strings.HasPrefix(host, "localhost") || strings.HasPrefix(host, "127.0.0.1") {
			scheme = "http"
		}
		base = scheme + "://" + host
	}
	return base + "/v1/integrations/google/callback"
}

func (h *Handler) googleStatus(w http.ResponseWriter, r *http.Request) {
	st := googleStatus{Configured: h.deps.Calendar != nil, RedirectURI: h.redirectURI(r)}
	if st.Configured {
		if in, err := h.deps.Integrations.GetIntegration(r.Context(), userFrom(r.Context()), googleProvider); err == nil {
			st.Connected, st.Email, st.Drive = true, in.Email, hasDrive(in)
			st.CalendarWrite = strings.Contains(scopesOf(in), core.CalendarEventsScope)
		}
	}
	writeJSON(w, http.StatusOK, st)
}

func (h *Handler) googleStart(w http.ResponseWriter, r *http.Request) {
	if h.deps.Calendar == nil {
		writeJSON(w, http.StatusNotFound, syncproto.ErrorResponse{Error: syncproto.CodeNotFound,
			Message: "Google Calendar isn't set up on this server yet. Add DIARY_GOOGLE_CLIENT_ID and DIARY_GOOGLE_CLIENT_SECRET."})
		return
	}
	var body struct {
		Client string `json:"client"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body)
	if body.Client != "app" {
		body.Client = "web"
	}
	redirect := h.redirectURI(r)
	state := h.states.put(pendingAuth{userID: userFrom(r.Context()), redirect: redirect, client: body.Client, expires: time.Now().Add(10 * time.Minute)})
	writeJSON(w, http.StatusOK, map[string]string{"url": h.deps.Calendar.AuthURL(state, redirect)})
}

// googleCallback finishes the sign-in. It is not behind requireUser: the
// state names the user (see pendingAuth).
func (h *Handler) googleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p, ok := h.states.take(q.Get("state"))
	if !ok || h.deps.Calendar == nil {
		finishPage(w, http.StatusBadRequest, "This sign-in link expired. Go back to Dotion and choose Connect again.")
		return
	}
	if e := q.Get("error"); e != "" {
		if p.client == "web" {
			http.Redirect(w, r, "/settings?google=cancelled", http.StatusSeeOther)
			return
		}
		finishPage(w, http.StatusOK, "Google Calendar wasn't connected. You can close this tab.")
		return
	}
	grant, err := h.deps.Calendar.Exchange(r.Context(), q.Get("code"), p.redirect)
	if err == nil {
		cfg, _ := json.Marshal(map[string]string{"scopes": grant.Scopes})
		err = h.deps.Integrations.PutIntegration(r.Context(), p.userID, core.Integration{Provider: googleProvider, RefreshToken: grant.RefreshToken, Email: grant.Email, Config: cfg})
	}
	if err != nil {
		h.deps.Log.Error("google connect", "err", err)
		finishPage(w, http.StatusBadGateway, "Google didn't accept the sign-in. Go back to Dotion and try again.")
		return
	}
	h.deps.Log.Info("google calendar connected")
	if p.client == "web" {
		http.Redirect(w, r, "/settings?google=connected", http.StatusSeeOther)
		return
	}
	finishPage(w, http.StatusOK, "Google Calendar is connected. You can close this tab and go back to Dotion.")
}

func finishPage(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dotion</title>` +
		`<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">Dotion</h1><p>` +
		html.EscapeString(msg) + `</p></body>`))
}

func (h *Handler) googleDisconnect(w http.ResponseWriter, r *http.Request) {
	userID := userFrom(r.Context())
	if in, err := h.deps.Integrations.GetIntegration(r.Context(), userID, googleProvider); err == nil && h.deps.Calendar != nil {
		_ = h.deps.Calendar.Revoke(r.Context(), in.RefreshToken) // best effort: forget it locally regardless
	}
	if err := h.deps.Integrations.DeleteIntegration(r.Context(), userID, googleProvider); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type eventsResponse = syncproto.EventsResponse

// calendarEvents returns events between ?start and ?end (RFC 3339 instants,
// computed by the client in its own time zone), at most 62 days apart.
func (h *Handler) calendarEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	start, err1 := time.Parse(time.RFC3339, q.Get("start"))
	end, err2 := time.Parse(time.RFC3339, q.Get("end"))
	if err1 != nil || err2 != nil || !end.After(start) || end.Sub(start) > 62*24*time.Hour {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"start": "start and end must be RFC 3339 times, at most 62 days apart"}})
		return
	}
	resp := eventsResponse{Events: []core.CalendarEvent{}}
	if h.deps.Calendar == nil {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	userID := userFrom(r.Context())
	in, err := h.deps.Integrations.GetIntegration(r.Context(), userID, googleProvider)
	if errors.Is(err, core.ErrNotFound) {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	events, err := h.deps.Calendar.Events(r.Context(), in.RefreshToken, start, end)
	if errors.Is(err, core.ErrGrantRevoked) {
		_ = h.deps.Integrations.DeleteIntegration(r.Context(), userID, googleProvider)
		writeJSON(w, http.StatusOK, resp) // access withdrawn at Google: show "connect" again
		return
	}
	if err != nil {
		h.deps.Log.Error("google events", "err", err)
		writeJSON(w, http.StatusBadGateway, syncproto.ErrorResponse{Error: "calendar_unavailable", Message: "Google Calendar didn't answer. Try again later."})
		return
	}
	resp.Connected, resp.Events = true, events
	writeJSON(w, http.StatusOK, resp)
}

// hasDrive reports whether a Google connection includes read access to Drive.
// Connections made before Drive support lack it and must reconnect.
func hasDrive(in core.Integration) bool {
	return strings.Contains(scopesOf(in), "/auth/drive.readonly")
}

func scopesOf(in core.Integration) string {
	var cfg struct {
		Scopes string `json:"scopes"`
	}
	_ = json.Unmarshal(in.Config, &cfg)
	return cfg.Scopes
}

// driveGrant returns the user's Google connection when it can read Drive.
func (h *Handler) driveGrant(r *http.Request) (core.Integration, bool) {
	if h.deps.Drive == nil {
		return core.Integration{}, false
	}
	in, err := h.deps.Integrations.GetIntegration(r.Context(), userFrom(r.Context()), googleProvider)
	if err != nil || !hasDrive(in) {
		return core.Integration{}, false
	}
	return in, true
}

func (h *Handler) driveFiles(w http.ResponseWriter, r *http.Request) {
	resp := syncproto.DriveFilesResponse{Files: []syncproto.DriveFile{}}
	in, ok := h.driveGrant(r)
	if !ok {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	files, next, err := h.deps.Drive.DriveSearch(r.Context(), in.RefreshToken, r.URL.Query().Get("q"), r.URL.Query().Get("page"))
	if errors.Is(err, core.ErrGrantRevoked) {
		_ = h.deps.Integrations.DeleteIntegration(r.Context(), userFrom(r.Context()), googleProvider)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if err != nil {
		h.deps.Log.Error("google drive", "err", err)
		writeJSON(w, http.StatusBadGateway, syncproto.ErrorResponse{Error: "drive_unavailable", Message: "Google Drive didn't answer. Try again later."})
		return
	}
	resp.Connected, resp.Files, resp.Next = true, files, next
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) driveMarkdown(w http.ResponseWriter, r *http.Request) {
	in, ok := h.driveGrant(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, syncproto.ErrorResponse{Error: syncproto.CodeNotFound, Message: "Connect Google Drive in Settings first."})
		return
	}
	name, md, err := h.deps.Drive.DriveMarkdown(r.Context(), in.RefreshToken, r.PathValue("id"))
	if err != nil {
		var invalid *core.ValidationError
		if !errors.As(err, &invalid) {
			h.deps.Log.Error("google drive export", "err", err)
		}
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncproto.DriveMarkdownResponse{Name: name, Markdown: md})
}
