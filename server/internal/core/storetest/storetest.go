// Package storetest is the contract every core.Store adapter must pass.
// Run it from each adapter's tests: storetest.Run(t, open).
package storetest

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"diary/server/internal/core"
	"diary/shared/model"
	"diary/shared/prosemirror"
)

// Run executes every contract case against a fresh, empty, migrated store.
func Run(t *testing.T, open func(t *testing.T) core.Store) {
	cases := []struct {
		name string
		fn   func(t *testing.T, s core.Store)
	}{
		{"CreateReturnsVersion1", testCreate},
		{"UpdateAndConflict", testUpdateAndConflict},
		{"ServerSeqStrictlyIncreases", testSeqIncreases},
		{"ChangesSinceLatestStateAndPaging", testChangesSince},
		{"CursorAhead", testCursorAhead},
		{"DeleteMakesTombstone", testDelete},
		{"Idempotency", testIdempotency},
		{"UsersAreIsolated", testIsolation},
		{"Search", testSearch},
		{"ListByDateAndRecent", testLists},
		{"PagesChildrenAndBacklinks", testPagesAndLinks},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { c.fn(t, open(t)) })
	}
}

var ctx = context.Background()

func user(t *testing.T, s core.Store, login string) string {
	t.Helper()
	id, err := s.EnsureUser(ctx, login)
	if err != nil {
		t.Fatalf("EnsureUser: %v", err)
	}
	return id
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

func doc(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": text}}},
	}})
	return b
}

func put(t *testing.T, s core.Store, userID, id string, base int, title, text string) model.Entry {
	t.Helper()
	e, err := s.PutEntry(ctx, userID, putInput(id, base, title, text))
	if err != nil {
		t.Fatalf("PutEntry(%s base %d): %v", title, base, err)
	}
	return e
}

func putInput(id string, base int, title, text string) core.PutInput {
	return core.PutInput{
		ID: id, IdemKey: newID(), BaseVersion: base, Title: title,
		Body: doc(text), BodyText: text,
		RequestHash: sha256.Sum256([]byte(fmt.Sprint(id, base, title, text))),
	}
}

func del(t *testing.T, s core.Store, userID, id string, base int) model.Entry {
	t.Helper()
	e, err := s.DeleteEntry(ctx, userID, core.DeleteInput{ID: id, IdemKey: newID(), BaseVersion: base})
	if err != nil {
		t.Fatalf("DeleteEntry: %v", err)
	}
	return e
}

func testCreate(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	id := newID()
	date := "2026-10-05"
	in := putInput(id, 0, "Monday", "long day")
	in.EntryDate = &date
	e, err := s.PutEntry(ctx, u, in)
	if err != nil {
		t.Fatal(err)
	}
	if e.ID != id || e.Version != 1 || e.ServerSeq < 1 || e.Title != "Monday" {
		t.Errorf("created entry = %+v", e)
	}
	if e.EntryDate == nil || *e.EntryDate != date {
		t.Errorf("entry_date = %v, want %s", e.EntryDate, date)
	}
	if e.CreatedAt.IsZero() || e.UpdatedAt.IsZero() || e.DeletedAt != nil {
		t.Errorf("timestamps: %+v", e)
	}
	got, err := s.GetEntry(ctx, u, id)
	if err != nil || got.Version != 1 || string(got.Body) != string(in.Body) {
		t.Errorf("GetEntry = %+v, %v", got, err)
	}

	// base > 0 for an unknown entry is not found
	if _, err := s.PutEntry(ctx, u, putInput(newID(), 3, "x", "x")); !errors.Is(err, core.ErrNotFound) {
		t.Errorf("unknown entry with base 3: err = %v, want ErrNotFound", err)
	}
	if _, err := s.GetEntry(ctx, u, newID()); !errors.Is(err, core.ErrNotFound) {
		t.Errorf("GetEntry unknown: err = %v, want ErrNotFound", err)
	}
}

func testUpdateAndConflict(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	id := newID()
	put(t, s, u, id, 0, "v1", "one")
	v2 := put(t, s, u, id, 1, "v2", "two")
	if v2.Version != 2 || v2.Title != "v2" {
		t.Fatalf("update = %+v", v2)
	}

	_, err := s.PutEntry(ctx, u, putInput(id, 1, "stale", "stale"))
	var ce *core.ConflictError
	if !errors.As(err, &ce) || !errors.Is(err, core.ErrConflict) {
		t.Fatalf("stale base: err = %v, want ConflictError", err)
	}
	if ce.Current.Version != 2 || ce.Current.Title != "v2" {
		t.Errorf("conflict current = %+v, want version 2", ce.Current)
	}
	// creating with base 0 over an existing entry is also a conflict
	if _, err := s.PutEntry(ctx, u, putInput(id, 0, "again", "again")); !errors.Is(err, core.ErrConflict) {
		t.Errorf("base 0 on existing: err = %v, want conflict", err)
	}
}

func testSeqIncreases(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	a, b := newID(), newID()
	var last int64
	steps := []func() model.Entry{
		func() model.Entry { return put(t, s, u, a, 0, "a", "a") },
		func() model.Entry { return put(t, s, u, b, 0, "b", "b") },
		func() model.Entry { return put(t, s, u, a, 1, "a2", "a2") },
		func() model.Entry { return del(t, s, u, b, 1) },
	}
	for i, step := range steps {
		e := step()
		if e.ServerSeq <= last {
			t.Fatalf("write %d: server_seq %d not above %d", i, e.ServerSeq, last)
		}
		last = e.ServerSeq
	}
}

func testChangesSince(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	a, b, c := newID(), newID(), newID()
	put(t, s, u, a, 0, "a", "a")
	put(t, s, u, b, 0, "b", "b")
	put(t, s, u, c, 0, "c", "c")
	for v := 1; v <= 4; v++ { // edit a four more times: it must appear once, at its latest state
		put(t, s, u, a, v, fmt.Sprintf("a%d", v+1), "a")
	}

	all, err := s.ChangesSince(ctx, u, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Changes) != 3 || all.HasMore {
		t.Fatalf("got %d changes (has_more %v), want 3", len(all.Changes), all.HasMore)
	}
	ids := []string{all.Changes[0].ID, all.Changes[1].ID, all.Changes[2].ID}
	if ids[0] != b || ids[1] != c || ids[2] != a {
		t.Errorf("order = %v, want b, c, a (by latest server_seq)", ids)
	}
	if all.Changes[2].Title != "a5" || all.Changes[2].Version != 5 {
		t.Errorf("a = %+v, want latest state v5", all.Changes[2])
	}
	if all.Cursor != all.Changes[2].ServerSeq {
		t.Errorf("cursor = %d, want last server_seq %d", all.Cursor, all.Changes[2].ServerSeq)
	}

	// paging two at a time
	p1, err := s.ChangesSince(ctx, u, 0, 2)
	if err != nil || len(p1.Changes) != 2 || !p1.HasMore {
		t.Fatalf("page 1 = %d changes, has_more %v, err %v", len(p1.Changes), p1.HasMore, err)
	}
	p2, err := s.ChangesSince(ctx, u, p1.Cursor, 2)
	if err != nil || len(p2.Changes) != 1 || p2.HasMore || p2.Changes[0].ID != a {
		t.Fatalf("page 2 = %+v, err %v", p2, err)
	}

	// nothing new: cursor stays put
	p3, err := s.ChangesSince(ctx, u, all.Cursor, 2)
	if err != nil || len(p3.Changes) != 0 || p3.Cursor != all.Cursor {
		t.Errorf("caught up = %+v, err %v", p3, err)
	}
}

func testCursorAhead(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	e := put(t, s, u, newID(), 0, "a", "a")
	if _, err := s.ChangesSince(ctx, u, e.ServerSeq+10, 10); !errors.Is(err, core.ErrCursorAhead) {
		t.Errorf("err = %v, want ErrCursorAhead", err)
	}
	other := user(t, s, "fresh@test") // no writes yet: only 0 is valid
	if _, err := s.ChangesSince(ctx, other, 0, 10); err != nil {
		t.Errorf("fresh user cursor 0: %v", err)
	}
}

func testDelete(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	id := newID()
	put(t, s, u, id, 0, "secret", "private words")
	ts := del(t, s, u, id, 1)
	if ts.DeletedAt == nil || ts.Version != 2 || ts.Title != "" || prosemirror.ExtractText(ts.Body) != "" {
		t.Errorf("tombstone = %+v", ts)
	}
	ch, err := s.ChangesSince(ctx, u, 0, 10)
	if err != nil || len(ch.Changes) != 1 || ch.Changes[0].DeletedAt == nil {
		t.Errorf("tombstone in changes = %+v, err %v", ch, err)
	}
	if _, err := s.DeleteEntry(ctx, u, core.DeleteInput{ID: id, IdemKey: newID(), BaseVersion: 1}); !errors.Is(err, core.ErrConflict) {
		t.Errorf("delete with stale base: err = %v, want conflict", err)
	}
	if _, err := s.DeleteEntry(ctx, u, core.DeleteInput{ID: newID(), IdemKey: newID(), BaseVersion: 1}); !errors.Is(err, core.ErrNotFound) {
		t.Errorf("delete unknown: err = %v, want not found", err)
	}
	// a write based on the tombstone's version restores the entry
	back := put(t, s, u, id, 2, "restored", "back")
	if back.DeletedAt != nil || back.Version != 3 {
		t.Errorf("undelete = %+v", back)
	}
}

func testIdempotency(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	in := putInput(newID(), 0, "once", "once")
	first, err := s.PutEntry(ctx, u, in)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.PutEntry(ctx, u, in)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if retry.Version != first.Version || retry.ServerSeq != first.ServerSeq {
		t.Errorf("retry = v%d seq %d, want the original v%d seq %d", retry.Version, retry.ServerSeq, first.Version, first.ServerSeq)
	}
	changed := in
	changed.Title = "different"
	changed.RequestHash = sha256.Sum256([]byte("different"))
	if _, err := s.PutEntry(ctx, u, changed); !errors.Is(err, core.ErrIdempotencyMismatch) {
		t.Errorf("same key, different body: err = %v, want ErrIdempotencyMismatch", err)
	}
}

func testIsolation(t *testing.T, s core.Store) {
	a, b := user(t, s, "a@test"), user(t, s, "b@test")
	id := newID()
	put(t, s, a, id, 0, "mine", "only a can see this")

	if _, err := s.GetEntry(ctx, b, id); !errors.Is(err, core.ErrNotFound) {
		t.Errorf("b reads a's entry: err = %v, want not found", err)
	}
	if _, err := s.PutEntry(ctx, b, putInput(id, 1, "hijack", "x")); err == nil {
		t.Error("b updated a's entry")
	}
	if _, err := s.PutEntry(ctx, b, putInput(id, 0, "hijack", "x")); err == nil {
		t.Error("b created over a's id")
	}
	if _, err := s.DeleteEntry(ctx, b, core.DeleteInput{ID: id, IdemKey: newID(), BaseVersion: 1}); err == nil {
		t.Error("b deleted a's entry")
	}
	if ch, _ := s.ChangesSince(ctx, b, 0, 10); len(ch.Changes) != 0 {
		t.Errorf("b sees %d of a's changes", len(ch.Changes))
	}
	if hits, _ := s.Search(ctx, b, "only", 10); len(hits) != 0 {
		t.Errorf("b finds %d of a's entries", len(hits))
	}
	got, err := s.GetEntry(ctx, a, id)
	if err != nil || got.Title != "mine" || got.Version != 1 {
		t.Errorf("a's entry changed: %+v, %v", got, err)
	}
}

func testSearch(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	river := put(t, s, u, newID(), 0, "Sunday", "walked along the river")
	put(t, s, u, newID(), 0, "Lighthouse trip", "windy")
	gone := put(t, s, u, newID(), 0, "Old", "river of regrets")
	del(t, s, u, gone.ID, 1)

	hits, err := s.Search(ctx, u, "river", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].ID != river.ID {
		t.Fatalf("search river = %+v, want only the live entry", hits)
	}
	if hits[0].Snippet == "" {
		t.Error("empty snippet")
	}
	if h, _ := s.Search(ctx, u, "lighthou", 10); len(h) != 1 {
		t.Errorf("title prefix search found %d, want 1", len(h))
	}
	if h, _ := s.Search(ctx, u, "walking", 10); len(h) != 1 {
		t.Errorf("stemmed search found %d, want 1", len(h))
	}
	if _, err := s.Search(ctx, u, `"unbalanced -quote OR (`, 10); err != nil {
		t.Errorf("odd characters: %v", err)
	}
}

func testLists(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	mk := func(date string) model.Entry {
		in := putInput(newID(), 0, date, date)
		in.EntryDate = &date
		e, err := s.PutEntry(ctx, u, in)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	mk("2026-09-30")
	oct1 := mk("2026-10-01")
	oct31 := mk("2026-10-31")
	gone := mk("2026-10-15")
	del(t, s, u, gone.ID, 1)
	mk("2026-11-01")

	got, err := s.ListByDate(ctx, u, "2026-10-01", "2026-10-31")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != oct1.ID || got[1].ID != oct31.ID {
		t.Errorf("October = %d entries, want oct1 and oct31", len(got))
	}
	recent, err := s.ListRecent(ctx, u, 3)
	if err != nil || len(recent) != 3 {
		t.Errorf("recent = %d, err %v, want 3", len(recent), err)
	}
	all, err := s.AllEntries(ctx, u)
	if err != nil || len(all) != 4 {
		t.Errorf("all = %d, err %v, want 4 live entries", len(all), err)
	}
}

func testPagesAndLinks(t *testing.T, s core.Store) {
	u := user(t, s, "a@test")
	project, tasks, task, note := newID(), newID(), newID(), newID()

	// a root page and a database under it
	put(t, s, u, project, 0, "Project X", "overview")
	db := putInput(tasks, 0, "Tasks", "")
	db.Kind = model.KindDatabase
	db.ParentID = &project
	db.Meta = json.RawMessage(`{"schema":{"properties":[]}}`)
	if e, err := s.PutEntry(ctx, u, db); err != nil || e.Kind != model.KindDatabase || *e.ParentID != project {
		t.Fatalf("database = %+v, %v", e, err)
	}

	// a record in the database, related to the project page
	rec := putInput(task, 0, "Write spec", "")
	rec.ParentID = &tasks
	rec.Meta = json.RawMessage(`{"props":{"p_rel":["` + project + `"]}}`)
	rec.Links = []string{project}
	if e, err := s.PutEntry(ctx, u, rec); err != nil || string(e.Meta) != string(rec.Meta) {
		t.Fatalf("record = %+v, %v", e, err)
	}

	// a free page linking to the project
	link := putInput(note, 0, "Meeting notes", "see project")
	link.Links = []string{project}
	if _, err := s.PutEntry(ctx, u, link); err != nil {
		t.Fatal(err)
	}

	roots, err := s.ListRootPages(ctx, u)
	if err != nil || len(roots) != 2 || roots[0].Title != "Meeting notes" || roots[1].Title != "Project X" {
		t.Errorf("roots = %v, err %v", titles(roots), err)
	}
	children, _ := s.ListChildren(ctx, u, project)
	if len(children) != 1 || children[0].ID != tasks {
		t.Errorf("children of project = %v", titles(children))
	}
	records, _ := s.ListChildren(ctx, u, tasks)
	if len(records) != 1 || records[0].ID != task {
		t.Errorf("records = %v", titles(records))
	}
	if recent, _ := s.ListRecent(ctx, u, 10); len(recent) != 3 {
		t.Errorf("recent should skip database records, got %v", titles(recent))
	}

	back, _ := s.Backlinks(ctx, u, project)
	if len(back) != 2 {
		t.Fatalf("backlinks of project = %v, want the record and the notes", titles(back))
	}

	// editing the link away removes the backlink; deleting the record does too
	unlink := putInput(note, 1, "Meeting notes", "no links now")
	if _, err := s.PutEntry(ctx, u, unlink); err != nil {
		t.Fatal(err)
	}
	del(t, s, u, task, 1)
	if back, _ := s.Backlinks(ctx, u, project); len(back) != 0 {
		t.Errorf("backlinks after unlink and delete = %v", titles(back))
	}
	if records, _ := s.ListChildren(ctx, u, tasks); len(records) != 0 {
		t.Errorf("deleted record still listed")
	}
	other := user(t, s, "b@test")
	if back, _ := s.Backlinks(ctx, other, project); len(back) != 0 {
		t.Error("another user sees backlinks")
	}
}

func titles(list []model.Entry) []string {
	out := make([]string, len(list))
	for i, e := range list {
		out[i] = e.Title
	}
	return out
}
