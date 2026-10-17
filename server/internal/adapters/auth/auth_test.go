package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

func TestTailscale(t *testing.T) {
	a := Tailscale{Owner: "you@github"}
	cases := map[string]error{"": core.ErrUnauthenticated, "someone@github": core.ErrForbidden, "You@GitHub": nil}
	for header, want := range cases {
		r := httptest.NewRequest("GET", "/v1/me", nil)
		if header != "" {
			r.Header.Set("Tailscale-User-Login", header)
		}
		login, err := a.Identify(r)
		if !errors.Is(err, want) {
			t.Errorf("header %q: err = %v, want %v", header, err, want)
		}
		if want == nil && login != "you@github" {
			t.Errorf("login = %q", login)
		}
	}
}

func TestPasswordLoginAndTokens(t *testing.T) {
	hash, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	a, err := NewPassword(hash, []byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	if _, _, _, err := a.Login(ctx, "wrong", "1.2.3.4"); !errors.Is(err, core.ErrUnauthenticated) {
		t.Errorf("wrong password: %v", err)
	}
	login, token, exp, err := a.Login(ctx, "correct horse", "1.2.3.4")
	if err != nil || login != OwnerLogin || time.Until(exp) < 29*24*time.Hour {
		t.Fatalf("login = %q, exp %v, err %v", login, exp, err)
	}

	r := httptest.NewRequest("GET", "/v1/me", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if got, err := a.Identify(r); err != nil || got != OwnerLogin {
		t.Errorf("bearer: %q, %v", got, err)
	}
	r = httptest.NewRequest("GET", "/v1/me", nil)
	r.AddCookie(&http.Cookie{Name: syncproto.SessionCookie, Value: token})
	if _, err := a.Identify(r); err != nil {
		t.Errorf("cookie: %v", err)
	}
	r = httptest.NewRequest("GET", "/v1/me", nil)
	r.Header.Set("Authorization", "Bearer "+token[:len(token)-2]+"xx")
	if _, err := a.Identify(r); !errors.Is(err, core.ErrUnauthenticated) {
		t.Errorf("tampered token accepted: %v", err)
	}

	// a different secret (rotation) invalidates the token
	b, _ := NewPassword(hash, []byte("another-secret-another-secret-123"))
	r = httptest.NewRequest("GET", "/v1/me", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if _, err := b.Identify(r); err == nil {
		t.Error("token survived secret rotation")
	}

	// expiry
	a.now = func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
	if _, err := a.Identify(r); err == nil {
		t.Error("expired token accepted")
	}
}

func TestPasswordRateLimit(t *testing.T) {
	hash, _ := HashPassword("pw")
	a, _ := NewPassword(hash, []byte("0123456789abcdef0123456789abcdef"))
	now := time.Now()
	a.now = func() time.Time { return now }
	ctx := context.Background()
	for i := 0; i < loginAttempts; i++ {
		_, _, _, _ = a.Login(ctx, "bad", "9.9.9.9")
	}
	if _, _, _, err := a.Login(ctx, "pw", "9.9.9.9"); !errors.Is(err, core.ErrRateLimited) {
		t.Errorf("6th attempt: %v, want rate limited", err)
	}
	if _, _, _, err := a.Login(ctx, "pw", "8.8.8.8"); err != nil {
		t.Errorf("other IP blocked: %v", err)
	}
	now = now.Add(loginWindow + time.Second)
	if _, _, _, err := a.Login(ctx, "pw", "9.9.9.9"); err != nil {
		t.Errorf("after the window: %v", err)
	}
}

func TestParsePHCRejectsJunk(t *testing.T) {
	if _, err := NewPassword("plaintext", nil); err == nil {
		t.Error("accepted a non-PHC hash")
	}
}
