package syncclient

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"diary/desktop/internal/localdb"
	"diary/server/testserver"
)

var ctx = context.Background()

type device struct {
	db  *localdb.DB
	eng *Engine

	mu        sync.Mutex
	changed   []string
	conflicts [][2]string
}

func newDevice(t *testing.T, url string) *device {
	t.Helper()
	db, err := localdb.Open(filepath.Join(t.TempDir(), "diary.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	d := &device{db: db}
	d.eng = New(db, func(context.Context) (Config, bool) { return Config{ServerURL: url}, url != "" })
	d.eng.OnChanged = func(ids []string) { d.mu.Lock(); d.changed = append(d.changed, ids...); d.mu.Unlock() }
	d.eng.OnConflict = func(id, cp string) { d.mu.Lock(); d.conflicts = append(d.conflicts, [2]string{id, cp}); d.mu.Unlock() }
	return d
}

func startServer(t *testing.T) *testserver.Server {
	t.Helper()
	srv, err := testserver.Start(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	return srv
}

func doc(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph",
		"content": []any{map[string]any{"type": "text", "text": text}}}}})
	return b
}

func (d *device) save(t *testing.T, id, title string) {
	t.Helper()
	date := "2026-10-05"
	if _, err := d.db.SaveLocal(ctx, localdb.Draft{ID: id, EntryDate: &date, Title: title, Body: doc(title)}); err != nil {
		t.Fatal(err)
	}
}

func (d *device) sync(t *testing.T) {
	t.Helper()
	if err := d.eng.SyncOnce(ctx); err != nil {
		t.Fatalf("sync: %v", err)
	}
}

func (d *device) titles(t *testing.T) map[string]string {
	t.Helper()
	list, err := d.db.ListRecent(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range list {
		out[e.ID] = e.Title
	}
	return out
}

func TestOfflineEditsReachTheOtherDevice(t *testing.T) {
	srv := startServer(t)
	laptop, desk := newDevice(t, srv.URL), newDevice(t, srv.URL)
	id := uuid.NewString()

	laptop.save(t, id, "Monday")
	laptop.save(t, id, "Monday, later") // coalesced: one request
	laptop.sync(t)
	if n, _ := laptop.db.PendingCount(ctx); n != 0 {
		t.Fatalf("pending after sync = %d", n)
	}
	if e, _ := laptop.db.GetEntry(ctx, id); e.Version != 1 || e.ServerSeq == 0 {
		t.Errorf("laptop copy = v%d seq %d, want v1 confirmed", e.Version, e.ServerSeq)
	}

	desk.sync(t)
	if got := desk.titles(t)[id]; got != "Monday, later" {
		t.Errorf("desk sees %q", got)
	}
	if st := desk.eng.Status(); st.State != "synced" || st.At == "" {
		t.Errorf("status = %+v", st)
	}
}

func TestConcurrentEditsProduceConflictCopy(t *testing.T) {
	srv := startServer(t)
	a, b := newDevice(t, srv.URL), newDevice(t, srv.URL)
	id := uuid.NewString()
	a.save(t, id, "Monday")
	a.sync(t)
	b.sync(t)

	a.save(t, id, "Monday from A")
	a.sync(t)
	b.save(t, id, "Monday from B (offline)") // based on v1, server is now at v2
	b.sync(t)                                // 409 → copy, pushed in the same run

	if len(b.conflicts) != 1 {
		t.Fatalf("conflicts on B = %v, want 1", b.conflicts)
	}
	copyID := b.conflicts[0][1]
	a.sync(t)

	for name, d := range map[string]*device{"A": a, "B": b} {
		titles := d.titles(t)
		if titles[id] != "Monday from A" || titles[copyID] != "Monday from B (offline) (conflict copy)" || len(titles) != 2 {
			t.Errorf("device %s ended with %v", name, titles)
		}
		if n, _ := d.db.PendingCount(ctx); n != 0 {
			t.Errorf("device %s still has %d pending", name, n)
		}
	}
}

func TestDeletePropagates(t *testing.T) {
	srv := startServer(t)
	a, b := newDevice(t, srv.URL), newDevice(t, srv.URL)
	id := uuid.NewString()
	a.save(t, id, "short-lived")
	a.sync(t)
	b.sync(t)
	if err := a.db.DeleteLocal(ctx, id); err != nil {
		t.Fatal(err)
	}
	a.sync(t)
	b.sync(t)
	if e, _ := b.db.GetEntry(ctx, id); e == nil || e.DeletedAt == nil {
		t.Errorf("B's copy = %+v, want a tombstone", e)
	}
	if _, ok := b.titles(t)[id]; ok {
		t.Error("deleted entry still listed on B")
	}
}

func TestCursorAheadResetsAndRepulls(t *testing.T) {
	srv := startServer(t)
	a, b := newDevice(t, srv.URL), newDevice(t, srv.URL)
	id := uuid.NewString()
	a.save(t, id, "kept")
	a.sync(t)

	// B believes it has seen far more than the server has (server restored from a backup).
	_ = b.db.SetState(ctx, localdb.KeyCursor, "9999")
	unsent := uuid.NewString()
	b.save(t, unsent, "written on B")
	b.sync(t)
	titles := b.titles(t)
	if titles[id] != "kept" || titles[unsent] != "written on B" {
		t.Errorf("B after reset = %v", titles)
	}
	if c, _ := b.db.State(ctx, localdb.KeyCursor); c == "9999" {
		t.Error("cursor was not reset")
	}
}

func TestOfflineKeepsChangesQueued(t *testing.T) {
	srv := startServer(t)
	url := srv.URL
	srv.Close() // the server is unreachable
	d := newDevice(t, url)
	d.save(t, uuid.NewString(), "on the train")
	if err := d.eng.SyncOnce(ctx); err == nil {
		t.Fatal("sync to a stopped server succeeded")
	}
	if st := d.eng.Status(); st.State != "offline" || st.Pending != 1 {
		t.Errorf("status = %+v, want offline with 1 pending", st)
	}
}

func TestLiveNoticeTriggersPull(t *testing.T) {
	srv := startServer(t)
	a, b := newDevice(t, srv.URL), newDevice(t, srv.URL)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go b.eng.Run(runCtx)

	time.Sleep(300 * time.Millisecond) // let B's stream connect
	id := uuid.NewString()
	a.save(t, id, "hello from A")
	a.sync(t)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b.titles(t)[id] == "hello from A" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("B did not receive A's entry within 5 s")
}

func TestPagesLinksAndImagesSyncBetweenDevices(t *testing.T) {
	srv := startServer(t)
	a, b := newDevice(t, srv.URL), newDevice(t, srv.URL)
	project, tasks, task := uuid.NewString(), uuid.NewString(), uuid.NewString()

	// A adds an image offline-style (stored locally first), a page that shows
	// it, a database, and a record related to the page.
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("pixels")...)
	hash, err := a.db.PutBlob(ctx, png, "image/png", false)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "image", "attrs": map[string]any{"src": "/v1/blobs/" + hash}}}})
	save := func(d localdb.Draft) {
		t.Helper()
		if _, err := a.db.SaveLocal(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	save(localdb.Draft{ID: project, Title: "Project X", Body: body})
	save(localdb.Draft{ID: tasks, Kind: "database", ParentID: &project, Title: "Tasks",
		Meta: json.RawMessage(`{"schema":{"properties":[{"id":"p_rel","name":"Project","type":"relation"}]}}`)})
	save(localdb.Draft{ID: task, ParentID: &tasks, Title: "Write spec",
		Meta: json.RawMessage(`{"props":{"p_rel":["` + project + `"]}}`)})
	a.sync(t)
	if up, _ := a.db.BlobsToUpload(ctx); len(up) != 0 {
		t.Errorf("image not uploaded: %v", up)
	}

	b.sync(t)
	if ct, _ := b.db.BlobType(ctx, hash); ct != "image/png" {
		t.Errorf("B did not download the image (type %q)", ct)
	}
	got, err := os.ReadFile(b.db.BlobPath(hash))
	if err != nil || string(got) != string(png) {
		t.Errorf("B's image bytes = %q, %v", got, err)
	}
	records, _ := b.db.ListChildren(ctx, tasks)
	if len(records) != 1 || records[0].ID != task || !strings.Contains(string(records[0].Meta), project) {
		t.Errorf("B's records = %+v", records)
	}
	back, _ := b.db.Backlinks(ctx, project)
	if len(back) != 1 || back[0].ID != task {
		t.Errorf("B's backlinks to the project = %+v", back)
	}
	roots, _ := b.db.ListRootPages(ctx)
	if len(roots) != 1 || roots[0].ID != project {
		t.Errorf("B's root pages = %+v", roots)
	}
	if recent, _ := b.db.ListRecent(ctx, 10); len(recent) != 2 {
		t.Errorf("B's recent should skip the record: %d", len(recent))
	}
}
