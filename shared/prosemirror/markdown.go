package prosemirror

import (
	"encoding/json"
	"strconv"
	"strings"
)

type mdNode struct {
	Type    string         `json:"type"`
	Text    string         `json:"text"`
	Attrs   map[string]any `json:"attrs"`
	Marks   []mdMark       `json:"marks"`
	Content []mdNode       `json:"content"`
}

type mdMark struct {
	Type  string         `json:"type"`
	Attrs map[string]any `json:"attrs"`
}

func (n mdNode) attr(key string) string {
	s, _ := n.Attrs[key].(string)
	return s
}

// MarkdownOptions customise the conversion.
type MarkdownOptions struct {
	// ImageSrc rewrites image sources, e.g. to files inside an export zip.
	ImageSrc func(src string) string
	// PageTitle resolves a page link's id to its current title ("" keeps the stored one).
	PageTitle func(id string) string
}

// ToMarkdown converts a ProseMirror document (TipTap StarterKit, task lists,
// tables, images, links) to Markdown. Unknown nodes keep their text.
func ToMarkdown(body json.RawMessage) string { return ToMarkdownWith(body, MarkdownOptions{}) }

func ToMarkdownWith(body json.RawMessage, opts MarkdownOptions) string {
	var doc mdNode
	if err := json.Unmarshal(body, &doc); err != nil {
		return ""
	}
	c := conv{opts}
	var b strings.Builder
	c.blocks(&b, doc.Content, "")
	return strings.TrimRight(b.String(), "\n") + "\n"
}

type conv struct{ opts MarkdownOptions }

func (c conv) blocks(b *strings.Builder, nodes []mdNode, indent string) {
	for i, n := range nodes {
		if i > 0 {
			b.WriteString(indent + "\n")
		}
		c.block(b, n, indent)
	}
}

func (c conv) block(b *strings.Builder, n mdNode, indent string) {
	switch n.Type {
	case "heading":
		level := 1
		if l, ok := n.Attrs["level"].(float64); ok && l >= 1 && l <= 6 {
			level = int(l)
		}
		b.WriteString(indent + strings.Repeat("#", level) + " " + c.inline(n.Content) + "\n")
	case "paragraph":
		b.WriteString(indent + c.inline(n.Content) + "\n")
	case "blockquote":
		var inner strings.Builder
		c.blocks(&inner, n.Content, "")
		for _, line := range strings.Split(strings.TrimRight(inner.String(), "\n"), "\n") {
			b.WriteString(indent + "> " + line + "\n")
		}
	case "codeBlock":
		b.WriteString(indent + "```" + n.attr("language") + "\n")
		for _, line := range strings.Split(plain(n.Content), "\n") {
			b.WriteString(indent + line + "\n")
		}
		b.WriteString(indent + "```\n")
	case "horizontalRule":
		b.WriteString(indent + "---\n")
	case "bulletList", "orderedList", "taskList":
		for i, item := range n.Content {
			marker := "- "
			switch {
			case n.Type == "orderedList":
				marker = strconv.Itoa(i+1) + ". "
			case n.Type == "taskList":
				if checked, _ := item.Attrs["checked"].(bool); checked {
					marker = "- [x] "
				} else {
					marker = "- [ ] "
				}
			}
			c.listItem(b, item, indent, marker)
		}
	case "table":
		c.table(b, n, indent)
	case "image":
		src := n.attr("src")
		if c.opts.ImageSrc != nil {
			src = c.opts.ImageSrc(src)
		}
		b.WriteString(indent + "![" + n.attr("alt") + "](" + src + ")\n")
	case "linkCard":
		title := n.attr("title")
		if title == "" {
			title = n.attr("url")
		}
		b.WriteString(indent + "[" + title + "](" + n.attr("url") + ")\n")
	case "databaseView":
		b.WriteString(indent + "*(Database view: " + n.attr("title") + ")*\n")
	default:
		if len(n.Content) > 0 {
			b.WriteString(indent + c.inline(n.Content) + "\n")
		}
	}
}

func (c conv) listItem(b *strings.Builder, item mdNode, indent, marker string) {
	pad := strings.Repeat(" ", len(marker))
	for i, child := range item.Content {
		if i == 0 && child.Type == "paragraph" {
			b.WriteString(indent + marker + c.inline(child.Content) + "\n")
			continue
		}
		if i == 0 {
			b.WriteString(indent + marker + "\n")
		}
		c.block(b, child, indent+pad)
	}
	if len(item.Content) == 0 {
		b.WriteString(indent + marker + "\n")
	}
}

// table writes a GitHub-flavoured Markdown table; the first row is the header.
func (c conv) table(b *strings.Builder, n mdNode, indent string) {
	for r, row := range n.Content {
		cells := make([]string, 0, len(row.Content))
		for _, cell := range row.Content {
			var parts []string
			for _, p := range cell.Content {
				parts = append(parts, c.inline(p.Content))
			}
			text := strings.ReplaceAll(strings.Join(parts, " "), "|", `\|`)
			cells = append(cells, strings.ReplaceAll(text, "\n", " "))
		}
		b.WriteString(indent + "| " + strings.Join(cells, " | ") + " |\n")
		if r == 0 {
			b.WriteString(indent + "|" + strings.Repeat(" --- |", len(cells)) + "\n")
		}
	}
}

func (c conv) inline(nodes []mdNode) string {
	var b strings.Builder
	for _, n := range nodes {
		switch n.Type {
		case "text":
			b.WriteString(applyMarks(n.Text, n.Marks))
		case "hardBreak":
			b.WriteString("  \n")
		case "pageLink":
			title := n.attr("title")
			if c.opts.PageTitle != nil {
				if t := c.opts.PageTitle(n.attr("id")); t != "" {
					title = t
				}
			}
			b.WriteString("[[" + title + "]]")
		default:
			b.WriteString(c.inline(n.Content))
		}
	}
	return b.String()
}

func plain(nodes []mdNode) string {
	var b strings.Builder
	for _, n := range nodes {
		if n.Type == "text" {
			b.WriteString(n.Text)
		} else if n.Type == "hardBreak" {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func applyMarks(text string, marks []mdMark) string {
	for _, m := range marks {
		switch m.Type {
		case "bold":
			text = "**" + text + "**"
		case "italic":
			text = "*" + text + "*"
		case "strike":
			text = "~~" + text + "~~"
		case "code":
			text = "`" + text + "`"
		case "link":
			if href, ok := m.Attrs["href"].(string); ok {
				text = "[" + text + "](" + href + ")"
			}
		}
	}
	return text
}
