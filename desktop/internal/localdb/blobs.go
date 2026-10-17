package localdb

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"

	"diary/shared/prosemirror"
)

// Images live in <dir>/blobs/<hash>, named by the sha256 of their bytes (the
// same hash the server uses), so "/v1/blobs/<hash>" means the same image on
// every device.

func (d *DB) BlobPath(hash string) string { return filepath.Join(d.dir, "blobs", hash) }

// PutBlob stores image bytes. uploaded=false queues them for the server.
func (d *DB) PutBlob(ctx context.Context, data []byte, contentType string, uploaded bool) (string, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	path := d.BlobPath(hash)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return "", err
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, data, 0o600); err != nil {
			return "", err
		}
		if err := os.Rename(tmp, path); err != nil {
			return "", err
		}
	}
	up := 0
	if uploaded {
		up = 1
	}
	_, err := d.db.ExecContext(ctx, `INSERT INTO blobs (hash, content_type, size, uploaded) VALUES (?, ?, ?, ?)
		ON CONFLICT (hash) DO UPDATE SET uploaded = max(uploaded, excluded.uploaded)`, hash, contentType, len(data), up)
	if err == nil {
		_, err = d.db.ExecContext(ctx, "DELETE FROM blob_wanted WHERE hash = ?", hash)
	}
	return hash, err
}

// BlobType returns the stored content type, or "" if the image is not here.
func (d *DB) BlobType(ctx context.Context, hash string) (string, error) {
	var ct string
	err := d.db.QueryRowContext(ctx, "SELECT content_type FROM blobs WHERE hash = ?", hash).Scan(&ct)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return ct, err
}

// BlobsToUpload lists images added on this computer that the server lacks.
func (d *DB) BlobsToUpload(ctx context.Context) ([]string, error) {
	return d.hashes(ctx, "SELECT hash FROM blobs WHERE uploaded = 0")
}

// BlobsWanted lists images referenced by entries but not downloaded yet.
func (d *DB) BlobsWanted(ctx context.Context) ([]string, error) {
	return d.hashes(ctx, "SELECT hash FROM blob_wanted")
}

func (d *DB) MarkBlobUploaded(ctx context.Context, hash string) error {
	_, err := d.db.ExecContext(ctx, "UPDATE blobs SET uploaded = 1 WHERE hash = ?", hash)
	return err
}

// DropWanted gives up on an image the server doesn't have.
func (d *DB) DropWanted(ctx context.Context, hash string) error {
	_, err := d.db.ExecContext(ctx, "DELETE FROM blob_wanted WHERE hash = ?", hash)
	return err
}

func (d *DB) hashes(ctx context.Context, q string) ([]string, error) {
	rows, err := d.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		if prosemirror.BlobHash(prosemirror.BlobPrefix+h) != "" {
			out = append(out, h)
		}
	}
	return out, rows.Err()
}
