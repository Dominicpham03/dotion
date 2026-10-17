package model

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestMetaLinksAndText(t *testing.T) {
	meta := json.RawMessage(`{"icon":"📁","props":{
		"p_rel":["0192a3c4-7b1e-7c2a-9f00-1a2b3c4d5e6f","not-an-id"],
		"p_tags":["opt_a1","opt_b2"],
		"p_status":"opt_c3",
		"p_due":"2026-10-20",
		"p_notes":"remember the dentist",
		"p_url":"https://example.com/spec",
		"p_n":42,
		"p_done":true}}`)
	if got := MetaLinks(meta); !reflect.DeepEqual(got, []string{"0192a3c4-7b1e-7c2a-9f00-1a2b3c4d5e6f"}) {
		t.Errorf("links = %v", got)
	}
	if got := MetaText(meta); got != "remember the dentist\nhttps://example.com/spec" {
		t.Errorf("text = %q", got)
	}
	if MetaLinks(json.RawMessage(`{}`)) != nil && len(MetaLinks(json.RawMessage(`{}`))) != 0 {
		t.Error("empty meta has links")
	}
}
