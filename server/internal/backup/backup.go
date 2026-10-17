// Package backup takes the nightly VACUUM INTO copy and prunes old ones.
package backup

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Backuper writes a consistent copy of the database to a file.
type Backuper interface {
	Backup(ctx context.Context, dst string) error
}

const prefix = "diary-20" // dated nightly files; diary-pre-NNNN.db (pre-migration) are kept

// Nightly runs Once at 03:00 local time every day until ctx ends.
func Nightly(ctx context.Context, b Backuper, dataDir string, keep int, log *slog.Logger) {
	for {
		wait := time.Until(nextRun(time.Now()))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if path, err := Once(ctx, b, dataDir, keep, time.Now()); err != nil {
			log.Error("backup failed", "err", err)
		} else {
			log.Info("backup written", "path", path)
		}
	}
}

// Once writes backups/diary-YYYY-MM-DD.db and deletes all but the newest keep.
func Once(ctx context.Context, b Backuper, dataDir string, keep int, now time.Time) (string, error) {
	dir := filepath.Join(dataDir, "backups")
	path := filepath.Join(dir, "diary-"+now.Format("2006-01-02")+".db")
	if err := b.Backup(ctx, path); err != nil {
		return "", err
	}
	return path, prune(dir, keep)
}

func prune(dir string, keep int) error {
	files, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var nightly []string
	for _, f := range files {
		if strings.HasPrefix(f.Name(), prefix) && strings.HasSuffix(f.Name(), ".db") {
			nightly = append(nightly, f.Name())
		}
	}
	sort.Strings(nightly) // dated names sort oldest first
	for len(nightly) > keep {
		if err := os.Remove(filepath.Join(dir, nightly[0])); err != nil {
			return err
		}
		nightly = nightly[1:]
	}
	return nil
}

func nextRun(now time.Time) time.Time {
	next := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, now.Location())
	if !next.After(now) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}
