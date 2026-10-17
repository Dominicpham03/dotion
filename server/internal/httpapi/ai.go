package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

func aiOff(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, syncproto.ErrorResponse{Error: "ai_disabled",
		Message: "The AI assistant is off. Set DIARY_GEMINI_API_KEY on the server to turn it on."})
}

func (h *Handler) aiUnavailable(w http.ResponseWriter, err error) {
	h.deps.Log.Warn("gemini", "err", err)
	writeJSON(w, http.StatusBadGateway, syncproto.ErrorResponse{Error: "ai_unavailable", Message: "Gemini didn't answer. Try again in a moment."})
}

// aiStatus also creates the action-item settings on first use, which enrolls
// the user in the automatic scan.
func (h *Handler) aiStatus(w http.ResponseWriter, r *http.Request) {
	st := h.deps.Assistant.Status()
	if st.Enabled && h.deps.Actions != nil {
		_, _ = h.deps.Actions.Config(r.Context(), userFrom(r.Context()))
	}
	writeJSON(w, http.StatusOK, st)
}

func (h *Handler) aiChat(w http.ResponseWriter, r *http.Request) {
	if !h.deps.Assistant.Status().Enabled {
		aiOff(w)
		return
	}
	// Tool calls can take a while: lift the server's 30 s write timeout.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(3 * time.Minute))
	var req syncproto.AIChatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"messages": "must be JSON"}})
		return
	}
	resp, err := h.deps.Assistant.Chat(r.Context(), userFrom(r.Context()), req)
	if errors.Is(err, core.ErrAIUnavailable) {
		h.aiUnavailable(w, err)
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	if resp.Sources == nil {
		resp.Sources = []syncproto.AISource{}
	}
	if resp.Proposals == nil {
		resp.Proposals = []syncproto.AIProposal{}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) actionsStatus(w http.ResponseWriter, r *http.Request) {
	if h.deps.Actions == nil {
		aiOff(w)
		return
	}
	st, err := h.deps.Actions.Status(r.Context(), userFrom(r.Context()))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (h *Handler) actionsConfigure(w http.ResponseWriter, r *http.Request) {
	if h.deps.Actions == nil {
		aiOff(w)
		return
	}
	var req syncproto.ActionsConfigRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"names": "must be a list of names"}})
		return
	}
	st, err := h.deps.Actions.Configure(r.Context(), userFrom(r.Context()), req.Enabled, req.Names)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (h *Handler) actionsScan(w http.ResponseWriter, r *http.Request) {
	if h.deps.Actions == nil {
		aiOff(w)
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Minute))
	var req syncproto.ActionsScanRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
			h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"entry_id": "must be a page id"}})
			return
		}
	}
	res, err := h.deps.Actions.Scan(r.Context(), userFrom(r.Context()), req.EntryID)
	switch {
	case errors.Is(err, core.ErrAIUnavailable):
		h.aiUnavailable(w, err)
	case errors.Is(err, core.ErrScanOff):
		writeJSON(w, http.StatusConflict, syncproto.ErrorResponse{Error: "scan_off", Message: "Automatic scanning is off. Turn it on in Settings, or scan one page."})
	case err != nil:
		h.writeError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, res)
	}
}
