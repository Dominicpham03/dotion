package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

func (h *Handler) gitlabStatus(w http.ResponseWriter, r *http.Request) {
	cfg, ok, err := h.deps.GitLab.Status(r.Context(), userFrom(r.Context()))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncproto.GitLabStatus{
		Connected: ok, URL: cfg.URL, Username: cfg.Username, DatabaseID: cfg.DatabaseID, LastSync: cfg.LastSync, LastError: cfg.LastError,
	})
}

func (h *Handler) gitlabConnect(w http.ResponseWriter, r *http.Request) {
	var req syncproto.GitLabConnectRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"token": "is required"}})
		return
	}
	if _, err := h.deps.GitLab.Connect(r.Context(), userFrom(r.Context()), req.URL, req.Token); err != nil {
		var invalid *core.ValidationError
		if errors.As(err, &invalid) {
			h.writeError(w, r, err)
			return
		}
		h.deps.Log.Warn("gitlab connect", "err", err)
		writeJSON(w, http.StatusBadGateway, syncproto.ErrorResponse{Error: "gitlab_unavailable", Message: err.Error()})
		return
	}
	h.gitlabStatus(w, r)
}

func (h *Handler) gitlabSync(w http.ResponseWriter, r *http.Request) {
	res, err := h.deps.GitLab.Sync(r.Context(), userFrom(r.Context()))
	if errors.Is(err, core.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, syncproto.ErrorResponse{Error: syncproto.CodeNotFound, Message: "Connect GitLab in Settings first."})
		return
	}
	if err != nil {
		h.deps.Log.Warn("gitlab sync", "err", err)
		writeJSON(w, http.StatusBadGateway, syncproto.ErrorResponse{Error: "gitlab_unavailable", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, syncproto.GitLabSyncResponse{Created: res.Created, Updated: res.Updated, Pushed: res.Pushed})
}

func (h *Handler) gitlabDisconnect(w http.ResponseWriter, r *http.Request) {
	if err := h.deps.GitLab.Disconnect(r.Context(), userFrom(r.Context())); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
