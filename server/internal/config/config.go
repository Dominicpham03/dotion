// Package config parses and validates the server's environment variables.
package config

import (
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
)

const (
	AuthTailscale = "tailscale"
	AuthPassword  = "password"
)

type Config struct {
	Addr          string
	DataDir       string
	DB            string
	Notify        string
	AuthMode      string
	OwnerLogin    string
	PasswordHash  string
	TokenSecret   []byte
	BackupKeep    int
	LogLevel      slog.Level
	MaxEntryBytes int64

	// Google Calendar (optional): an OAuth client from Google Cloud Console.
	GoogleClientID     string
	GoogleClientSecret string
	// PublicURL is the address people open the diary at, e.g.
	// https://diary.tailnet.ts.net. It builds the Google redirect URI; if unset,
	// the request's own host is used.
	PublicURL string

	// Gemini (optional): turns on the AI assistant and action items.
	GeminiAPIKey string
	GeminiModel  string
}

// Load reads the configuration from the process environment.
func Load() (Config, error) { return FromEnv(os.Getenv) }

// FromEnv builds a Config from a lookup function, so tests need no real env.
func FromEnv(get func(string) string) (Config, error) {
	or := func(key, def string) string {
		if v := get(key); v != "" {
			return v
		}
		return def
	}

	cfg := Config{
		Addr:         or("DIARY_ADDR", "127.0.0.1:8080"),
		DataDir:      or("DIARY_DATA_DIR", "/data"),
		DB:           or("DIARY_DB", "sqlite"),
		Notify:       or("DIARY_NOTIFY", "memory"),
		AuthMode:     or("DIARY_AUTH_MODE", AuthTailscale),
		OwnerLogin:   get("DIARY_OWNER_LOGIN"),
		PasswordHash: get("DIARY_PASSWORD_HASH"),

		GoogleClientID:     get("DIARY_GOOGLE_CLIENT_ID"),
		GoogleClientSecret: get("DIARY_GOOGLE_CLIENT_SECRET"),
		PublicURL:          strings.TrimRight(get("DIARY_PUBLIC_URL"), "/"),

		GeminiAPIKey: strings.TrimSpace(get("DIARY_GEMINI_API_KEY")),
		GeminiModel:  strings.TrimSpace(get("DIARY_GEMINI_MODEL")),
	}
	if (cfg.GoogleClientID == "") != (cfg.GoogleClientSecret == "") {
		return Config{}, fmt.Errorf("set both DIARY_GOOGLE_CLIENT_ID and DIARY_GOOGLE_CLIENT_SECRET, or neither")
	}
	if cfg.PublicURL != "" && !strings.HasPrefix(cfg.PublicURL, "https://") && !strings.HasPrefix(cfg.PublicURL, "http://localhost") {
		return Config{}, fmt.Errorf("DIARY_PUBLIC_URL must start with https:// (or be http://localhost:PORT)")
	}

	var err error
	if cfg.BackupKeep, err = strconv.Atoi(or("DIARY_BACKUP_KEEP", "14")); err != nil || cfg.BackupKeep < 0 {
		return Config{}, fmt.Errorf("DIARY_BACKUP_KEEP must be a non-negative number")
	}
	if cfg.MaxEntryBytes, err = strconv.ParseInt(or("DIARY_MAX_ENTRY_BYTES", "2097152"), 10, 64); err != nil || cfg.MaxEntryBytes <= 0 {
		return Config{}, fmt.Errorf("DIARY_MAX_ENTRY_BYTES must be a positive number")
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(or("DIARY_LOG_LEVEL", "info"))); err != nil {
		return Config{}, fmt.Errorf("DIARY_LOG_LEVEL must be debug, info, warn or error")
	}

	if cfg.DB != "sqlite" {
		return Config{}, fmt.Errorf("DIARY_DB=%s is not supported yet (only sqlite)", cfg.DB)
	}
	if cfg.Notify != "memory" {
		return Config{}, fmt.Errorf("DIARY_NOTIFY=%s is not supported yet (only memory)", cfg.Notify)
	}
	host, _, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		return Config{}, fmt.Errorf("DIARY_ADDR must be host:port: %w", err)
	}

	switch cfg.AuthMode {
	case AuthTailscale:
		if cfg.OwnerLogin == "" {
			return Config{}, fmt.Errorf("DIARY_OWNER_LOGIN is required when DIARY_AUTH_MODE=tailscale")
		}
		// Identity headers are only trustworthy if nothing but the Tailscale
		// sidecar can reach the server.
		if !isLoopback(host) {
			return Config{}, fmt.Errorf("DIARY_ADDR must be on 127.0.0.1 when DIARY_AUTH_MODE=tailscale (got %s)", cfg.Addr)
		}
	case AuthPassword:
		if cfg.PasswordHash == "" {
			return Config{}, fmt.Errorf("DIARY_PASSWORD_HASH is required when DIARY_AUTH_MODE=password")
		}
		secret := get("DIARY_TOKEN_SECRET")
		if secret == "" {
			return Config{}, fmt.Errorf("DIARY_TOKEN_SECRET is required when DIARY_AUTH_MODE=password")
		}
		if cfg.TokenSecret, err = base64.StdEncoding.DecodeString(secret); err != nil || len(cfg.TokenSecret) < 32 {
			return Config{}, fmt.Errorf("DIARY_TOKEN_SECRET must be base64 of at least 32 random bytes")
		}
	default:
		return Config{}, fmt.Errorf("DIARY_AUTH_MODE must be tailscale or password (got %s)", cfg.AuthMode)
	}
	return cfg, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
