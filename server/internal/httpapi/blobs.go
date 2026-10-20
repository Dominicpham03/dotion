package httpapi

import (
	"io"
	"net/http"

	"diary/server/internal/core"
	"diary/shared/prosemirror"
	"diary/shared/syncproto"
)

// MaxBlobBytes is the largest file accepted (images and attachments alike).
const MaxBlobBytes = 50 << 20

// Raster image formats the editor renders inline. Any other file is stored as
// a download attachment (see getBlob). SVG is deliberately absent: served
// inline it can carry script, so it is treated as a plain attachment.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// putBlob stores the raw request body and returns its URL. Images are rendered
// inline in the editor; any other file becomes a downloadable attachment.
func (h *Handler) putBlob(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBlobBytes))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	if len(data) == 0 {
		h.writeError(w, r, &core.ValidationError{Fields: map[string]string{"body": "is empty"}})
		return
	}
	ct := http.DetectContentType(data) // sniffed, never trusted from the client
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
	if !imageTypes[info.ContentType] {
		hd.Set("Content-Disposition", "attachment") // non-images download rather than render inline
	}
	http.ServeContent(w, r, "", info.CreatedAt, f)
}
