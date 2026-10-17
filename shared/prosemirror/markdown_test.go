package prosemirror

import (
	"encoding/json"
	"testing"
)

func TestToMarkdown(t *testing.T) {
	doc := `{"type":"doc","content":[
		{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Monday"}]},
		{"type":"paragraph","content":[{"type":"text","text":"Long "},{"type":"text","text":"day","marks":[{"type":"bold"}]},
			{"type":"text","text":" see "},{"type":"text","text":"link","marks":[{"type":"link","attrs":{"href":"https://example.com"}}]}]},
		{"type":"bulletList","content":[
			{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"tea"}]}]},
			{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"walk"}]}]}]},
		{"type":"taskList","content":[
			{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"done"}]}]},
			{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"todo"}]}]}]},
		{"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"quote"}]}]}
	]}`
	want := "## Monday\n\nLong **day** see [link](https://example.com)\n\n- tea\n- walk\n\n- [x] done\n- [ ] todo\n\n> quote\n"
	if got := ToMarkdown(json.RawMessage(doc)); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}
