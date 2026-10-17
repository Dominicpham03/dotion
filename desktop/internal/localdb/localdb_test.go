package localdb

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"diary/shared/model"
)

var ctx = context.Background()

func open(t *testing.T) *DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "local dir", "diary.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func doc(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph",
		"content": []any{map[string]any{"type": "text", "text": text}}}}})
	return b
}

func save(t *testing.T, d *DB, id, title string) model.Entry {
	t.Helper()
	e, err := d.SaveLocal(ctx, Draft{ID: id, Title: title, Body: doc(title)})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestOutboxCoalescesAndKeepsBase(t *testing.T) {
	d := open(t)
	id := uuid.NewString()
	save(t, d, id, "one")
	save(t, d, id, "two")
	save(t, d, id, "three")
	rows, err := d.Due(ctx)
	if err != nil || len(rows) != 1 {
		t.Fatalf("due = %d rows, err %v; want 1 coalesced row", len(rows), err)
	}
	r := rows[0]
	if r.Rev != 3 || r.BaseVersion != 0 || r.Op != "put" {
		t.Errorf("row = %+v", r)
	}
	var p struct{ Title string }
	_ = json.Unmarshal(r.Payload, &p)
	if p.Title != "three" {
		t.Errorf("payload title = %q, want the latest", p.Title)
	}
}

func TestEditDuringPushStaysQueued(t *testing.T) {
	d := open(t)
	id := uuid.NewString()
	save(t, d, id, "first")
	rows, _ := d.Due(ctx)
	inFlight := rows[0]

	save(t, d, id, "typed while sending") // rev 2

	if err := d.PushSucceeded(ctx, inFlight, model.Entry{ID: id, Version: 1, ServerSeq: 7}); err != nil {
		t.Fatal(err)
	}
	rows, _ = d.Due(ctx)
	if len(rows) != 1 || rows[0].Rev != 2 || rows[0].BaseVersion != 1 {
		t.Fatalf("after push = %+v, want rev 2 queued on base 1", rows)
	}
	e, _ := d.GetEntry(ctx, id)
	if e.Version != 1 || e.Title != "typed while sending" {
		t.Errorf("local = v%d %q", e.Version, e.Title)
	}

	if err := d.PushSucceeded(ctx, rows[0], model.Entry{ID: id, Version: 2, ServerSeq: 8}); err != nil {
		t.Fatal(err)
	}
	if n, _ := d.PendingCount(ctx); n != 0 {
		t.Errorf("pending = %d, want 0", n)
	}
}

func TestPullSkipsEntriesWithPendingEdits(t *testing.T) {
	d := open(t)
	mine, theirs := uuid.NewString(), uuid.NewString()
	save(t, d, mine, "unsent local text")
	now := time.Now()
	ids, err := d.ApplyPull(ctx, []model.Entry{
		{ID: mine, Title: "server text", Body: doc("server"), Version: 4, ServerSeq: 10, CreatedAt: now, UpdatedAt: now},
		{ID: theirs, Title: "new from server", Body: doc("hi"), Version: 1, ServerSeq: 11, CreatedAt: now, UpdatedAt: now},
	}, 11)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != theirs {
		t.Errorf("applied = %v, want only %s", ids, theirs)
	}
	if e, _ := d.GetEntry(ctx, mine); e.Title != "unsent local text" {
		t.Errorf("pull overwrote unsent text: %q", e.Title)
	}
	if c, _ := d.State(ctx, KeyCursor); c != "11" {
		t.Errorf("cursor = %q, want 11", c)
	}
	hits, _ := d.Search(ctx, "new", 10)
	if len(hits) != 1 {
		t.Errorf("local search found %d, want 1", len(hits))
	}
}

func TestConflictMakesCopy(t *testing.T) {
	d := open(t)
	id := uuid.NewString()
	now := time.Now()
	_, _ = d.ApplyPull(ctx, []model.Entry{{ID: id, Title: "Monday", Body: doc("v7"), Version: 7, ServerSeq: 1, CreatedAt: now, UpdatedAt: now}}, 1)
	save(t, d, id, "Monday")
	rows, _ := d.Due(ctx)
	if rows[0].BaseVersion != 7 {
		t.Fatalf("base = %d, want 7", rows[0].BaseVersion)
	}
	current := model.Entry{ID: id, Title: "Monday (other device)", Body: doc("v8"), Version: 8, ServerSeq: 2, CreatedAt: now, UpdatedAt: now}
	copyID, err := d.PushConflict(ctx, rows[0], current)
	if err != nil || copyID == "" {
		t.Fatalf("copy = %q, err %v", copyID, err)
	}
	orig, _ := d.GetEntry(ctx, id)
	cp, _ := d.GetEntry(ctx, copyID)
	if orig.Version != 8 || orig.Title != "Monday (other device)" {
		t.Errorf("original = %+v", orig)
	}
	if cp == nil || cp.Title != "Monday (conflict copy)" || cp.Version != 0 {
		t.Errorf("copy = %+v", cp)
	}
	rows, _ = d.Due(ctx)
	if len(rows) != 1 || rows[0].EntryID != copyID || rows[0].BaseVersion != 0 {
		t.Errorf("outbox = %+v, want only the copy as a create", rows)
	}
}

func TestDeleteNeverSyncedIsRemoved(t *testing.T) {
	d := open(t)
	id := uuid.NewString()
	save(t, d, id, "draft")
	if err := d.DeleteLocal(ctx, id); err != nil {
		t.Fatal(err)
	}
	if e, _ := d.GetEntry(ctx, id); e != nil {
		t.Errorf("entry still there: %+v", e)
	}
	if n, _ := d.PendingCount(ctx); n != 0 {
		t.Errorf("pending = %d", n)
	}
}
