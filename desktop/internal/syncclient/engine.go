// Package syncclient is the desktop sync engine: it pushes the outbox, pulls
// changes, and listens for live notices (FRONTEND.md §8.4).
package syncclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"diary/desktop/internal/api"
	"diary/desktop/internal/localdb"
	"diary/shared/syncproto"
)

// Status is what the sidebar badge and Settings page show.
type Status struct {
	State   string `json:"state"` // synced | syncing | offline | error | disconnected
	At      string `json:"at,omitempty"`
	Pending int    `json:"pending"`
	Message string `json:"message,omitempty"`
}

// Config is where to sync to; ok=false means the app is not connected yet.
type Config struct {
	ServerURL string
	Token     string
}

type Engine struct {
	db     *localdb.DB
	config func(ctx context.Context) (Config, bool)

	OnChanged  func(ids []string)
	OnStatus   func(Status)
	OnConflict func(id, copyID string)
	OnBlobs    func(hashes []string) // images downloaded: views showing them can reload

	trigger   chan struct{}
	reconnect chan struct{}
	pageSize  int
	idleWait  time.Duration

	mu           sync.Mutex
	status       Status
	cancelStream context.CancelFunc
}

func New(db *localdb.DB, config func(ctx context.Context) (Config, bool)) *Engine {
	return &Engine{
		db: db, config: config,
		OnChanged: func([]string) {}, OnStatus: func(Status) {}, OnConflict: func(string, string) {}, OnBlobs: func([]string) {},
		trigger: make(chan struct{}, 1), reconnect: make(chan struct{}, 1),
		pageSize: 500, idleWait: 60 * time.Second,
	}
}

var errAuth = errors.New("sign in again")

// Nudge asks the loop to run soon. It never blocks.
func (e *Engine) Nudge() {
	select {
	case e.trigger <- struct{}{}:
	default:
	}
}

// Reconfigure is called after the server URL or token changes: the live
// stream reconnects with the new settings and a sync runs.
func (e *Engine) Reconfigure() {
	e.mu.Lock()
	if e.cancelStream != nil {
		e.cancelStream()
	}
	e.mu.Unlock()
	select {
	case e.reconnect <- struct{}{}:
	default:
	}
	e.Nudge()
}

func (e *Engine) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status
}

func (e *Engine) setStatus(s Status) {
	e.mu.Lock()
	changed := e.status != s
	e.status = s
	e.mu.Unlock()
	if changed {
		e.OnStatus(s)
	}
}

// Run is the single sync loop: pushes and pulls never race each other.
func (e *Engine) Run(ctx context.Context) {
	go e.listen(ctx)
	failures := 0
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.trigger:
		case <-timer.C:
		}
		wait := e.idleWait
		switch err := e.SyncOnce(ctx); {
		case err == nil, errors.Is(err, errAuth):
			failures = 0
		case ctx.Err() != nil:
			return
		default:
			failures++
			wait = backoff(failures)
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
	}
}

// backoff: 1 s, 2 s, 4 s … at most 60 s.
func backoff(n int) time.Duration {
	if n > 6 {
		return 60 * time.Second
	}
	return time.Duration(1<<(n-1)) * time.Second
}

// SyncOnce pushes every due outbox row, then pulls until caught up.
func (e *Engine) SyncOnce(ctx context.Context) error {
	cfg, ok := e.config(ctx)
	if !ok {
		e.setStatus(Status{State: "disconnected"})
		return nil
	}
	client := api.New(cfg.ServerURL, cfg.Token)
	e.setStatus(Status{State: "syncing", Pending: e.pending(ctx)})

	// Images first, so entries never reach the server before their images.
	err := e.pushBlobs(ctx, client)
	if err == nil {
		err = e.push(ctx, client)
	}
	if err == nil {
		err = e.pull(ctx, client)
	}
	if err == nil {
		err = e.pullBlobs(ctx, client)
	}
	switch {
	case err == nil:
		at := time.Now().UTC().Format(time.RFC3339)
		_ = e.db.SetState(ctx, localdb.KeyLastSyncAt, at)
		e.setStatus(Status{State: "synced", At: at, Pending: e.pending(ctx)})
	case errors.Is(err, errAuth):
		e.setStatus(Status{State: "error", Message: "Sign in again to keep syncing.", Pending: e.pending(ctx)})
	case api.IsNetwork(err):
		e.setStatus(Status{State: "offline", Pending: e.pending(ctx)})
	default:
		e.setStatus(Status{State: "error", Message: err.Error(), Pending: e.pending(ctx)})
	}
	return err
}

func (e *Engine) pending(ctx context.Context) int {
	n, _ := e.db.PendingCount(ctx)
	return n
}

func (e *Engine) push(ctx context.Context, client *api.Client) error {
	for round := 0; round < 3; round++ {
		rows, err := e.db.Due(ctx)
		if err != nil {
			return err
		}
		again := false
		for _, row := range rows {
			retry, err := e.pushOne(ctx, client, row)
			if err != nil {
				return err
			}
			again = again || retry
		}
		if !again {
			return nil
		}
	}
	return nil
}

// pushOne sends one outbox row. retry=true means the row was re-queued and
// is due again right away.
func (e *Engine) pushOne(ctx context.Context, client *api.Client, row localdb.OutboxRow) (retry bool, err error) {
	var sent error
	switch row.Op {
	case "put":
		var req syncproto.PutEntryRequest
		if err := json.Unmarshal(row.Payload, &req); err != nil {
			return false, e.db.PushFailed(ctx, row, "unreadable payload", true, time.Now())
		}
		req.BaseVersion = row.BaseVersion
		entry, err := client.PutEntry(ctx, row.EntryID, row.IdemKey, req)
		if err == nil {
			if err := e.db.PushSucceeded(ctx, row, entry); err != nil {
				return false, err
			}
			e.OnChanged([]string{row.EntryID})
			return false, nil
		}
		sent = err
	case "delete":
		if row.BaseVersion == 0 { // the server never had it
			return false, e.db.PushNotFound(ctx, row)
		}
		entry, err := client.DeleteEntry(ctx, row.EntryID, row.IdemKey, row.BaseVersion)
		if err == nil {
			if err := e.db.PushSucceeded(ctx, row, entry); err != nil {
				return false, err
			}
			return false, nil
		}
		sent = err
	default:
		return false, e.db.PushFailed(ctx, row, "unknown operation "+row.Op, true, time.Now())
	}

	var ae *api.Error
	switch {
	case errors.As(sent, &ae) && ae.Status == 409 && ae.ErrorResponse.Error == syncproto.CodeConflict && ae.Current != nil:
		copyID, err := e.db.PushConflict(ctx, row, *ae.Current)
		if err != nil {
			return false, err
		}
		ids := []string{row.EntryID}
		if copyID != "" {
			ids = append(ids, copyID)
		}
		e.OnChanged(ids)
		if copyID != "" {
			e.OnConflict(row.EntryID, copyID)
		}
		return copyID != "", nil // push the copy in the next round
	case errors.As(sent, &ae) && ae.Status == 404:
		return true, e.db.PushNotFound(ctx, row)
	case errors.As(sent, &ae) && (ae.Status == 401 || ae.Status == 403):
		return false, errAuth
	case errors.As(sent, &ae) && ae.Status < 500:
		return false, e.db.PushFailed(ctx, row, ae.Error(), true, time.Now())
	default:
		_ = e.db.PushFailed(ctx, row, sent.Error(), false, time.Now().Add(backoff(row.Attempts+1)))
		return false, sent
	}
}

func (e *Engine) pull(ctx context.Context, client *api.Client) error {
	raw, err := e.db.State(ctx, localdb.KeyCursor)
	if err != nil {
		return err
	}
	cursor, _ := strconv.ParseInt(raw, 10, 64)
	resets, downloaded := 0, 0
	for {
		page, err := client.Sync(ctx, cursor, e.pageSize)
		var ae *api.Error
		if errors.As(err, &ae) && ae.ErrorResponse.Error == syncproto.CodeCursorAhead && resets == 0 {
			// The server was restored from a backup: pull everything again.
			// Unsent edits stay in the outbox.
			cursor, resets = 0, 1
			continue
		}
		if errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403) {
			return errAuth
		}
		if err != nil {
			return err
		}
		ids, err := e.db.ApplyPull(ctx, page.Changes, page.Cursor)
		if err != nil {
			return err
		}
		if len(ids) > 0 {
			e.OnChanged(ids)
		}
		cursor = page.Cursor
		if !page.HasMore {
			return nil
		}
		downloaded += len(page.Changes)
		e.setStatus(Status{State: "syncing", Message: fmt.Sprintf("%d entries downloaded", downloaded)})
	}
}

// listen holds the live stream open and nudges the loop on every notice. On
// (re)connect it also nudges, since notices may have been missed.
func (e *Engine) listen(ctx context.Context) {
	failures := 0
	for ctx.Err() == nil {
		cfg, ok := e.config(ctx)
		if !ok {
			select {
			case <-ctx.Done():
				return
			case <-e.reconnect:
				continue
			}
		}
		sctx, cancel := context.WithCancel(ctx)
		e.mu.Lock()
		e.cancelStream = cancel
		e.mu.Unlock()
		_ = api.New(cfg.ServerURL, cfg.Token).Events(sctx,
			func() { failures = 0; e.Nudge() },
			func(int64) { e.Nudge() })
		cancel()
		failures++
		select {
		case <-ctx.Done():
			return
		case <-e.reconnect:
		case <-time.After(backoff(failures)):
		}
	}
}

// Flush gives pending changes up to timeout to reach the server (used when
// the window closes). Anything left stays in the outbox for next launch.
func (e *Engine) Flush(ctx context.Context, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if _, ok := e.config(ctx); !ok {
		return
	}
	e.Nudge()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for e.pending(ctx) > 0 {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// pushBlobs uploads images added on this computer.
func (e *Engine) pushBlobs(ctx context.Context, client *api.Client) error {
	hashes, err := e.db.BlobsToUpload(ctx)
	if err != nil {
		return err
	}
	for _, h := range hashes {
		data, err := os.ReadFile(e.db.BlobPath(h))
		if err != nil {
			continue // file gone: nothing to send
		}
		var ae *api.Error
		_, err = client.UploadBlob(ctx, data)
		switch {
		case err == nil:
			if err := e.db.MarkBlobUploaded(ctx, h); err != nil {
				return err
			}
		case errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403):
			return errAuth
		case errors.As(err, &ae) && ae.Status < 500:
			_ = e.db.MarkBlobUploaded(ctx, h) // rejected (e.g. too large): don't retry forever
		default:
			return err
		}
	}
	return nil
}

// pullBlobs downloads images that pulled entries refer to.
func (e *Engine) pullBlobs(ctx context.Context, client *api.Client) error {
	hashes, err := e.db.BlobsWanted(ctx)
	if err != nil {
		return err
	}
	var got []string
	for _, h := range hashes {
		data, ct, err := client.DownloadBlob(ctx, h)
		var ae *api.Error
		switch {
		case err == nil:
			if _, err := e.db.PutBlob(ctx, data, ct, true); err != nil {
				return err
			}
			got = append(got, h)
		case errors.As(err, &ae) && ae.Status == 404:
			_ = e.db.DropWanted(ctx, h)
		case errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403):
			return errAuth
		default:
			return err
		}
	}
	if len(got) > 0 {
		e.OnBlobs(got)
	}
	return nil
}
