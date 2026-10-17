package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fileBackuper struct{}

func (fileBackuper) Backup(_ context.Context, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	return os.WriteFile(dst, []byte("db"), 0o600)
}

func TestOnceKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	start := time.Date(2026, 10, 1, 3, 0, 0, 0, time.Local)
	if err := os.MkdirAll(filepath.Join(dir, "backups"), 0o700); err != nil {
		t.Fatal(err)
	}
	pre := filepath.Join(dir, "backups", "diary-pre-0002.db")
	_ = os.WriteFile(pre, []byte("x"), 0o600)
	for i := 0; i < 5; i++ {
		if _, err := Once(context.Background(), fileBackuper{}, dir, 3, start.AddDate(0, 0, i)); err != nil {
			t.Fatal(err)
		}
	}
	files, _ := os.ReadDir(filepath.Join(dir, "backups"))
	var names []string
	for _, f := range files {
		names = append(names, f.Name())
	}
	want := []string{"diary-2026-10-03.db", "diary-2026-10-04.db", "diary-2026-10-05.db", "diary-pre-0002.db"}
	if len(names) != len(want) {
		t.Fatalf("files = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("files = %v, want %v", names, want)
		}
	}
}

func TestNextRun(t *testing.T) {
	loc := time.Local
	if got := nextRun(time.Date(2026, 10, 5, 2, 0, 0, 0, loc)); got.Day() != 5 || got.Hour() != 3 {
		t.Errorf("before 3am: %v", got)
	}
	if got := nextRun(time.Date(2026, 10, 5, 3, 0, 0, 0, loc)); got.Day() != 6 {
		t.Errorf("at 3am: %v", got)
	}
}
