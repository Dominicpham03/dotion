package config

import (
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestFromEnv(t *testing.T) {
	secret := "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // 32 bytes
	cases := []struct {
		name    string
		env     map[string]string
		wantErr string
	}{
		{"tailscale defaults", map[string]string{"DIARY_OWNER_LOGIN": "you@github"}, ""},
		{"tailscale without owner", map[string]string{}, "DIARY_OWNER_LOGIN is required"},
		{"tailscale off loopback", map[string]string{"DIARY_OWNER_LOGIN": "you@github", "DIARY_ADDR": "0.0.0.0:8080"}, "must be on 127.0.0.1"},
		{"password ok", map[string]string{"DIARY_AUTH_MODE": "password", "DIARY_ADDR": "0.0.0.0:8080", "DIARY_PASSWORD_HASH": "$argon2id$x", "DIARY_TOKEN_SECRET": secret}, ""},
		{"password without hash", map[string]string{"DIARY_AUTH_MODE": "password", "DIARY_TOKEN_SECRET": secret}, "DIARY_PASSWORD_HASH is required"},
		{"password short secret", map[string]string{"DIARY_AUTH_MODE": "password", "DIARY_PASSWORD_HASH": "$argon2id$x", "DIARY_TOKEN_SECRET": "c2hvcnQ="}, "at least 32"},
		{"unknown auth mode", map[string]string{"DIARY_AUTH_MODE": "none"}, "DIARY_AUTH_MODE must be"},
		{"bad log level", map[string]string{"DIARY_OWNER_LOGIN": "you@github", "DIARY_LOG_LEVEL": "loud"}, "DIARY_LOG_LEVEL"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := FromEnv(env(c.env))
			switch {
			case c.wantErr == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)):
				t.Fatalf("got %v, want error containing %q", err, c.wantErr)
			}
		})
	}
}
