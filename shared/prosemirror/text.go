// Package prosemirror derives plain text, links and Markdown from
// ProseMirror JSON documents.
package prosemirror

import (
	"encoding/json"
	"sort"
	"strings"
)

type node struct {
	Type    string         `json:"type"`
	Text    string         `json:"text"`
	Attrs   map[string]any `json:"attrs"`
	Content []node         `json:"content"`
}

// BlobPrefix is the src prefix of images stored by the diary.
const BlobPrefix = "/v1/blobs/"

func parse(body json.RawMessage) (node, bool) {
	var doc node
	return doc, json.Unmarshal(body, &doc) == nil
}

func (n node) attr(key string) string {
	s, _ := n.Attrs[key].(string)
	return s
}

// ExtractText returns the plain text of a ProseMirror document, one line per
// text block. It is the single source of body_text, used for search.
func ExtractText(body json.RawMessage) string {
	doc, ok := parse(body)
	if !ok {
		return ""
	}
	var b strings.Builder
	walk(&b, doc)
	return strings.TrimSpace(b.String())
}

func isInline(t string) bool {
	switch t {
	case "text", "hardBreak", "pageLink":
		return true
	}
	return false
}

func walk(b *strings.Builder, n node) {
	switch n.Type {
	case "text":
		b.WriteString(n.Text)
		return
	case "hardBreak":
		b.WriteByte('\n')
		return
	case "pageLink":
		b.WriteString(n.attr("title"))
		return
	case "linkCard":
		if t := n.attr("title"); t != "" {
			b.WriteString(t + "\n")
		}
		b.WriteString(n.attr("url") + "\n")
		return
	case "image":
		if alt := n.attr("alt"); alt != "" {
			b.WriteString(alt + "\n")
		}
		return
	}
	inline := false
	for _, c := range n.Content {
		if isInline(c.Type) {
			inline = true
		}
		walk(b, c)
	}
	if inline {
		b.WriteByte('\n')
	}
}

// ExtractLinks returns the ids of entries the document points to: page links
// and embedded database views.
func ExtractLinks(body json.RawMessage) []string {
	doc, ok := parse(body)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	visit(doc, func(n node) {
		switch n.Type {
		case "pageLink":
			if id := n.attr("id"); id != "" {
				seen[strings.ToLower(id)] = true
			}
		case "databaseView":
			if id := n.attr("databaseId"); id != "" {
				seen[strings.ToLower(id)] = true
			}
		}
	})
	return sorted(seen)
}

// ExtractImages returns the hashes of diary-stored images in the document.
func ExtractImages(body json.RawMessage) []string {
	doc, ok := parse(body)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	visit(doc, func(n node) {
		if n.Type == "image" {
			if h := BlobHash(n.attr("src")); h != "" {
				seen[h] = true
			}
		}
	})
	return sorted(seen)
}

// BlobHash returns the hash from "/v1/blobs/<hash>", or "".
func BlobHash(src string) string {
	h, ok := strings.CutPrefix(src, BlobPrefix)
	if !ok || len(h) != 64 || strings.Trim(h, "0123456789abcdef") != "" {
		return ""
	}
	return h
}

func visit(n node, fn func(node)) {
	fn(n)
	for _, c := range n.Content {
		visit(c, fn)
	}
}

func sorted(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
