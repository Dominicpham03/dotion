package httpapi

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"diary/server/internal/core"
	"diary/shared/model"
	"diary/shared/prosemirror"
)

// export returns every live entry as a zip of Markdown files, with images in
// assets/, so the diary is never locked into this app.
//
//	2026/2026-10-05 Monday.md     daily entries
//	pages/Title.md                pages (sub-pages flattened)
//	databases/Tasks/Title.md      database records, properties at the top
//	assets/<hash>.png             images
func (h *Handler) export(w http.ResponseWriter, r *http.Request) {
	userID := userFrom(r.Context())
	entries, err := h.deps.Entries.All(r.Context(), userID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	byID := map[string]model.Entry{}
	for _, e := range entries {
		byID[e.ID] = e
	}
	title := func(id string) string { return byID[strings.ToLower(id)].Title }

	name := "diary-" + time.Now().Format("2006-01-02") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)

	zw := zip.NewWriter(w)
	used := map[string]bool{}
	images := map[string]bool{}
	for _, e := range entries {
		if e.Kind == model.KindDatabase {
			continue // a database is exported as its records' folder
		}
		path := exportPath(e, byID)
		if used[path] {
			path = strings.TrimSuffix(path, ".md") + " " + e.ID[:8] + ".md"
		}
		used[path] = true
		up := strings.Repeat("../", strings.Count(path, "/"))
		for _, hsh := range prosemirror.ExtractImages(e.Body) {
			images[hsh] = true
		}
		md := prosemirror.ToMarkdownWith(e.Body, prosemirror.MarkdownOptions{
			ImageSrc: func(src string) string {
				if hsh := prosemirror.BlobHash(src); hsh != "" {
					return up + "assets/" + hsh
				}
				return src
			},
			PageTitle: title,
		})
		f, err := zw.CreateHeader(&zip.FileHeader{Name: path, Method: zip.Deflate, Modified: e.UpdatedAt})
		if err != nil {
			h.deps.Log.Error("export", "err", err)
			return
		}
		t := e.Title
		if t == "" {
			t = "Untitled"
		}
		fmt.Fprintf(f, "# %s\n\n%s%s", t, propertiesBlock(e, byID), md)
	}

	hashes := make([]string, 0, len(images))
	for hsh := range images {
		hashes = append(hashes, hsh)
	}
	sort.Strings(hashes)
	for _, hsh := range hashes {
		_, src, err := h.deps.Blobs.OpenBlob(r.Context(), userID, hsh)
		if err != nil {
			continue // referenced but not stored (e.g. uploaded by another account)
		}
		if f, err := zw.CreateHeader(&zip.FileHeader{Name: "assets/" + hsh, Method: zip.Store}); err == nil {
			_, _ = io.Copy(f, src)
		}
		src.Close()
	}
	if err := zw.Close(); err != nil {
		h.deps.Log.Error("export", "err", err)
	}
}

func exportPath(e model.Entry, byID map[string]model.Entry) string {
	title := safeName(e.Title)
	if e.ParentID != nil {
		if db, ok := byID[*e.ParentID]; ok && db.Kind == model.KindDatabase {
			if title == "" {
				title = "Untitled " + e.ID[:8]
			}
			dbName := safeName(db.Title)
			if dbName == "" {
				dbName = "Untitled database"
			}
			return "databases/" + dbName + "/" + title + ".md"
		}
	}
	if e.EntryDate != nil {
		d := *e.EntryDate
		if title == "" {
			return d[:4] + "/" + d + ".md"
		}
		return d[:4] + "/" + d + " " + title + ".md"
	}
	if title == "" {
		title = "Untitled " + e.ID[:8]
	}
	return "pages/" + title + ".md"
}

// propertiesBlock lists a record's property values by name, as a Markdown list.
func propertiesBlock(e model.Entry, byID map[string]model.Entry) string {
	if e.ParentID == nil {
		return ""
	}
	db, ok := byID[*e.ParentID]
	if !ok {
		return ""
	}
	titleOf := func(id string) (string, bool) {
		t, ok := byID[id]
		return "[[" + t.Title + "]]", ok
	}
	var b strings.Builder
	for _, p := range core.RecordProperties(e, db, titleOf) {
		fmt.Fprintf(&b, "- **%s:** %s\n", p.Name, strings.Join(p.Values, ", "))
	}
	if b.Len() == 0 {
		return ""
	}
	return b.String() + "\n"
}

func safeName(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"/\|?*`, r) || unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.Trim(strings.TrimSpace(s), ".")
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}
