// Package conflict holds the conflict-copy rules shared by both clients.
package conflict

import "strings"

const copySuffix = " (conflict copy)"

// CopyTitle returns the title for a conflict copy of an entry.
func CopyTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "Untitled"
	}
	if strings.HasSuffix(title, copySuffix) {
		return title
	}
	return title + copySuffix
}

// IsCopy reports whether a title marks a conflict copy.
func IsCopy(title string) bool { return strings.HasSuffix(title, copySuffix) }
