package prosemirror

import (
	"encoding/json"
	"testing"
)

func TestExtractText(t *testing.T) {
	doc := `{"type":"doc","content":[
		{"type":"heading","content":[{"type":"text","text":"Monday"}]},
		{"type":"paragraph"},
		{"type":"paragraph","content":[{"type":"text","text":"Long "},{"type":"text","text":"day","marks":[{"type":"bold"}]}]},
		{"type":"bulletList","content":[{"type":"listItem","content":[
			{"type":"paragraph","content":[{"type":"text","text":"tea"}]}]}]}
	]}`
	want := "Monday\nLong day\ntea"
	if got := ExtractText(json.RawMessage(doc)); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := ExtractText(json.RawMessage(`not json`)); got != "" {
		t.Errorf("invalid JSON: got %q, want empty", got)
	}
}
