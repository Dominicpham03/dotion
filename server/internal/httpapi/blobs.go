package httpapi

import (
	"io"
	"net/http"

	"diary/server/internal/core"
	"diary/shared/prosemirror"
	"diary/shared/syncproto"
)

// MaxBlobBytes is the largest image accepted.
const MaxBlobBytes = 10 << 20

// Raster formats only: SVG can carry script, so it is never accepted.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// putBlob stores the raw request body as an image and returns its URL.
func (h *Handler) putBlob(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBlobBytes))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	ct := http.DetectContentType(data) // sniffed, never trusted from the client
	if !imageTypes[ct] {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"body": "must be a PNG, JPEG, GIF or WebP image"}})
		return
	}
	hash, err := h.deps.Blobs.PutBlob(r.Context(), userFrom(r.Context()), ct, data)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncproto.BlobResponse{Hash: hash, URL: prosemirror.BlobPrefix + hash})
}

func (h *Handler) getBlob(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	if prosemirror.BlobHash(prosemirror.BlobPrefix+hash) == "" {
		h.writeError(w, r, core.ErrNotFound)
		return
	}
	info, f, err := h.deps.Blobs.OpenBlob(r.Context(), userFrom(r.Context()), hash)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	defer f.Close()
	hd := w.Header()
	hd.Set("Content-Type", info.ContentType)
	hd.Set("Cache-Control", "private, max-age=31536000, immutable") // content-addressed: never changes
	hd.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeContent(w, r, "", info.CreatedAt, f)
}
