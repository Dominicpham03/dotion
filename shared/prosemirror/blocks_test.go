package prosemirror

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

var richDoc = json.RawMessage(`{"type":"doc","content":[
	{"type":"paragraph","content":[{"type":"text","text":"See "},
		{"type":"pageLink","attrs":{"id":"0192A3C4-7B1E-7C2A-9F00-1A2B3C4D5E6F","title":"Project X"}},
		{"type":"text","text":" for details"}]},
	{"type":"codeBlock","attrs":{"language":"go"},"content":[{"type":"text","text":"func main() {}\n// done"}]},
	{"type":"table","content":[
		{"type":"tableRow","content":[
			{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Name"}]}]},
			{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Score"}]}]}]},
		{"type":"tableRow","content":[
			{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"Ada"}]}]},
			{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"a|b"}]}]}]}]},
	{"type":"image","attrs":{"src":"/v1/blobs/` + hash + `","alt":"whiteboard"}},
	{"type":"image","attrs":{"src":"https://elsewhere.example/x.png"}},
	{"type":"linkCard","attrs":{"url":"https://go.dev/doc","title":"Go docs"}},
	{"type":"databaseView","attrs":{"databaseId":"11111111-2222-7333-8444-555555555555","title":"Tasks"}}
]}`)

func TestExtractFromRichDoc(t *testing.T) {
	if got := ExtractLinks(richDoc); !reflect.DeepEqual(got, []string{
		"0192a3c4-7b1e-7c2a-9f00-1a2b3c4d5e6f", "11111111-2222-7333-8444-555555555555",
	}) {
		t.Errorf("links = %v", got)
	}
	if got := ExtractImages(richDoc); !reflect.DeepEqual(got, []string{hash}) {
		t.Errorf("images = %v", got)
	}
	text := ExtractText(richDoc)
	for _, want := range []string{"See Project X for details", "func main()", "Ada", "whiteboard", "Go docs", "https://go.dev/doc"} {
		if !strings.Contains(text, want) {
			t.Errorf("text missing %q:\n%s", want, text)
		}
	}
}

func TestMarkdownRichBlocks(t *testing.T) {
	md := ToMarkdownWith(richDoc, MarkdownOptions{
		ImageSrc:  func(src string) string { return strings.Replace(src, BlobPrefix, "assets/", 1) },
		PageTitle: func(string) string { return "Project X (renamed)" },
	})
	for _, want := range []string{
		"See [[Project X (renamed)]] for details",
		"```go\nfunc main() {}\n// done\n```",
		"| Name | Score |\n| --- | --- |\n| Ada | a\\|b |",
		"![whiteboard](assets/" + hash + ")",
		"[Go docs](https://go.dev/doc)",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown missing %q:\n%s", want, md)
		}
	}
}

func TestBlobHash(t *testing.T) {
	if BlobHash("/v1/blobs/"+hash) != hash || BlobHash("/v1/blobs/../etc") != "" || BlobHash("https://x/"+hash) != "" {
		t.Error("BlobHash accepted or rejected the wrong input")
	}
}
