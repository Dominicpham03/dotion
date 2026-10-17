// Package auth holds the core.Authenticator implementations.
package auth

import (
	"net/http"
	"strings"

	"diary/server/internal/core"
)

// Tailscale trusts the identity header added by the Tailscale sidecar. This
// is only safe because the server listens on 127.0.0.1 inside the sidecar's
// network namespace (config refuses anything else).
type Tailscale struct{ Owner string }

const tailscaleLoginHeader = "Tailscale-User-Login"

func (a Tailscale) Identify(r *http.Request) (string, error) {
	login := strings.TrimSpace(r.Header.Get(tailscaleLoginHeader))
	if login == "" { // e.g. via Funnel, which attaches no identity
		return "", core.ErrUnauthenticated
	}
	if !strings.EqualFold(login, a.Owner) {
		return "", core.ErrForbidden
	}
	return a.Owner, nil
}
