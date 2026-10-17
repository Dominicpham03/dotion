// Package webui serves the built web UI embedded in the binary.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// dist is filled by `npm run build:web`. A placeholder index.html is checked
// in so `go build` works before the UI exists.
//
//go:embed all:dist
var dist embed.FS

func Handler() http.Handler {
	sub, _ := fs.Sub(dist, "dist")
	files := http.FileServerFS(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if _, err := fs.Stat(sub, p); p == "" || err != nil {
			// SPA fallback: unknown paths get index.html so client-side routes work
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFileFS(w, r, sub, "index.html")
			return
		}
		if strings.HasPrefix(p, "assets/") { // Vite adds content hashes to these names
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		files.ServeHTTP(w, r)
	})
}
