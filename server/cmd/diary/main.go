// Command diary is the diary server: config → pick adapters → start.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"diary/server/internal/adapters/auth"
	"diary/server/internal/adapters/claude"
	"diary/server/internal/adapters/gemini"
	"diary/server/internal/adapters/gitlab"
	"diary/server/internal/adapters/google"
	"diary/server/internal/adapters/memnotifier"
	"diary/server/internal/adapters/ollama"
	"diary/server/internal/adapters/sqlitestore"
	"diary/server/internal/backup"
	"diary/server/internal/config"
	"diary/server/internal/core"
	"diary/server/internal/httpapi"
	"diary/server/internal/webui"
)

const version = "1.0.0"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		os.Exit(hashPassword())
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			os.Exit(healthcheck(cfg.Addr))
		default:
			fmt.Fprintf(os.Stderr, "unknown command %q (commands: healthcheck, hash-password)\n", os.Args[1])
			os.Exit(2)
		}
	}
	if err := run(cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(cfg config.Config) error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return fmt.Errorf("data dir: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := sqlitestore.Open(filepath.Join(cfg.DataDir, "diary.db"))
	if err != nil {
		return err
	}
	defer store.Close()
	if err := store.Migrate(ctx); err != nil {
		return err
	}

	var authn core.Authenticator
	switch cfg.AuthMode {
	case config.AuthPassword:
		pw, err := auth.NewPassword(cfg.PasswordHash, cfg.TokenSecret)
		if err != nil {
			return err
		}
		authn = pw
	default:
		authn = auth.Tailscale{Owner: cfg.OwnerLogin}
	}

	// Both stay nil (features off) without Google credentials.
	var calendar core.CalendarProvider
	var drive core.DriveProvider
	var calendarWriter core.CalendarWriter
	if cfg.GoogleClientID != "" {
		g := google.New(cfg.GoogleClientID, cfg.GoogleClientSecret)
		calendar, drive, calendarWriter = g, g, g
	}

	notifier := memnotifier.New()
	entries := core.NewEntryService(store, notifier)
	gl := core.NewGitLabService(entries, store, store, gitlab.New())
	entries.OnPut = gl.Changed // a status change in Dotion is sent to GitLab

	// The AI assistant and action items stay off without a model: Claude,
	// a local one through Ollama, or Gemini (first one configured wins).
	var model core.ChatModel
	provider := ""
	switch {
	case cfg.AnthropicAPIKey != "":
		model, provider = claude.New(cfg.AnthropicAPIKey, cfg.AnthropicModel, ""), "claude"
	case cfg.OllamaURL != "":
		o := ollama.New(cfg.OllamaURL, cfg.OllamaModel, cfg.OllamaContext)
		if err := o.Ping(ctx); err != nil {
			log.Warn("ollama not ready yet; the assistant will retry on each request", "err", err)
		}
		model, provider = o, "ollama"
	case cfg.GeminiAPIKey != "":
		g, err := gemini.New(ctx, cfg.GeminiAPIKey, cfg.GeminiModel, "")
		if err != nil {
			return fmt.Errorf("gemini: %w", err)
		}
		model, provider = g, "gemini"
	}
	var actions *core.ActionsService
	var assistant *core.AssistantService
	if model != nil {
		actions = core.NewActionsService(entries, model, store, calendarWriter, log)
		assistant = core.NewAssistantService(entries, model, store, calendar, drive, actions)
		assistant.Provider = provider
	}
	handler := httpapi.New(httpapi.Deps{
		Entries:       entries,
		GitLab:        gl,
		Assistant:     assistant,
		Actions:       actions,
		Sync:          core.NewSyncService(store),
		Notifier:      notifier,
		Auth:          authn,
		Users:         store,
		Blobs:         store,
		Calendar:      calendar,
		Drive:         drive,
		Integrations:  store,
		PublicURL:     cfg.PublicURL,
		Ping:          store.Ping,
		AuthMode:      cfg.AuthMode,
		Log:           log,
		MaxEntryBytes: cfg.MaxEntryBytes,
		Version:       version,
		WebUI:         webui.Handler(),
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second, // SSE route lifts this per request
		IdleTimeout:       120 * time.Second,
	}

	go backup.Nightly(ctx, store, cfg.DataDir, cfg.BackupKeep, log)
	go store.CleanupLoop(ctx)
	go gl.Loop(ctx, 5*time.Minute)
	if actions != nil {
		go actions.Loop(ctx, 15*time.Minute)
	}

	// On SIGTERM: close SSE streams first so clients reconnect promptly, then
	// drain in-flight requests; the deferred Close shuts the database cleanly.
	done := make(chan struct{})
	go func() {
		<-ctx.Done()
		notifier.CloseAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		close(done)
	}()

	log.Info("listening", "addr", cfg.Addr, "auth", cfg.AuthMode, "data_dir", cfg.DataDir, "version", version, "google_calendar", calendar != nil, "ai", provider)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server: %w", err)
	}
	<-done
	log.Info("stopped")
	return nil
}
