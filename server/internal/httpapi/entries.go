package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"diary/server/internal/core"
	"diary/shared/model"
	"diary/shared/syncproto"
)

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	resp := syncproto.HealthResponse{Status: "ok", DB: "ok", Version: h.deps.Version}
	if h.deps.Ping != nil {
		if err := h.deps.Ping(r.Context()); err != nil {
			resp.Status, resp.DB = "error", "error"
			writeJSON(w, http.StatusServiceUnavailable, resp)
			return
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) notFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, syncproto.ErrorResponse{Error: syncproto.CodeNotFound, Message: "No such API route."})
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, syncproto.MeResponse{Login: loginFrom(r.Context()), AuthMode: h.deps.AuthMode})
}

func (h *Handler) getEntry(w http.ResponseWriter, r *http.Request) {
	e, err := h.deps.Entries.Get(r.Context(), userFrom(r.Context()), r.PathValue("id"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (h *Handler) putEntry(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, h.deps.MaxEntryBytes))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	var req syncproto.PutEntryRequest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"body": "must be valid JSON: " + err.Error()}})
		return
	}
	e, err := h.deps.Entries.Put(r.Context(), userFrom(r.Context()), r.PathValue("id"),
		r.Header.Get(syncproto.HeaderIdempotencyKey), req, raw)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (h *Handler) deleteEntry(w http.ResponseWriter, r *http.Request) {
	base, err := strconv.Atoi(r.URL.Query().Get("base_version"))
	if err != nil {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"base_version": "query parameter is required"}})
		return
	}
	e, err := h.deps.Entries.Delete(r.Context(), userFrom(r.Context()), r.PathValue("id"),
		r.Header.Get(syncproto.HeaderIdempotencyKey), base)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (h *Handler) listEntries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var (
		entries []model.Entry
		err     error
	)
	switch {
	case q.Get("recent") != "":
		n, _ := strconv.Atoi(q.Get("recent"))
		entries, err = h.deps.Entries.Recent(r.Context(), userFrom(r.Context()), n)
	case q.Get("parent") != "":
		entries, err = h.deps.Entries.Children(r.Context(), userFrom(r.Context()), q.Get("parent"))
	case q.Get("pages") != "":
		entries, err = h.deps.Entries.RootPages(r.Context(), userFrom(r.Context()))
	default:
		entries, err = h.deps.Entries.ListRange(r.Context(), userFrom(r.Context()), q.Get("from"), q.Get("to"))
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncproto.EntriesResponse{Entries: entries})
}

func (h *Handler) search(w http.ResponseWriter, r *http.Request) {
	hits, err := h.deps.Entries.Search(r.Context(), userFrom(r.Context()), r.URL.Query().Get("q"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncproto.SearchResponse{Hits: hits})
}

func (h *Handler) sync(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	since, err := strconv.ParseInt(q.Get("since"), 10, 64)
	if err != nil {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"since": "query parameter is required"}})
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	page, err := h.deps.Sync.Changes(r.Context(), userFrom(r.Context()), since, limit)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncproto.SyncResponse{Changes: page.Changes, Cursor: page.Cursor, HasMore: page.HasMore})
}

func (h *Handler) backlinks(w http.ResponseWriter, r *http.Request) {
	entries, err := h.deps.Entries.Backlinks(r.Context(), userFrom(r.Context()), r.PathValue("id"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncproto.EntriesResponse{Entries: entries})
}
