package conflict

import "testing"

func TestCopyTitle(t *testing.T) {
	cases := map[string]string{
		"Monday":                 "Monday (conflict copy)",
		"  Monday ":              "Monday (conflict copy)",
		"":                       "Untitled (conflict copy)",
		"Monday (conflict copy)": "Monday (conflict copy)",
	}
	for in, want := range cases {
		if got := CopyTitle(in); got != want {
			t.Errorf("CopyTitle(%q) = %q, want %q", in, got, want)
		}
	}
}
