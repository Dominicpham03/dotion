package sqlitestore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"diary/server/internal/adapters/sqlitestore/sqlcgen"
	"diary/server/internal/core"
)

// Images are stored once per content (sha256) in <data>/blobs/ab/<hash>; the
// blobs table records which user stored which, so one user can never read
// another's images even though identical bytes share a file.

func (s *Store) blobPath(hash string) string {
	return filepath.Join(filepath.Dir(s.path), "blobs", hash[:2], hash)
}

func (s *Store) PutBlob(ctx context.Context, userID, contentType string, data []byte) (string, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	path := s.blobPath(hash)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return "", err
		}
		// Write to a temp file and rename, so a crash never leaves half a file
		// under the final name.
		tmp, err := os.CreateTemp(filepath.Dir(path), hash+".*.tmp")
		if err != nil {
			return "", err
		}
		_, werr := tmp.Write(data)
		cerr := tmp.Close()
		if werr != nil || cerr != nil {
			os.Remove(tmp.Name())
			return "", fmt.Errorf("write blob: %w", errors.Join(werr, cerr))
		}
		if err := os.Rename(tmp.Name(), path); err != nil {
			os.Remove(tmp.Name())
			return "", err
		}
	}
	err := sqlcgen.New(s.writer).InsertBlob(ctx, sqlcgen.InsertBlobParams{
		UserID: userID, Hash: hash, ContentType: contentType, Size: int64(len(data)), CreatedAt: s.stamp(),
	})
	return hash, err
}

func (s *Store) OpenBlob(ctx context.Context, userID, hash string) (core.BlobInfo, io.ReadSeekCloser, error) {
	row, err := sqlcgen.New(s.reader).GetBlob(ctx, sqlcgen.GetBlobParams{UserID: userID, Hash: hash})
	if errors.Is(err, sql.ErrNoRows) {
		return core.BlobInfo{}, nil, core.ErrNotFound
	}
	if err != nil {
		return core.BlobInfo{}, nil, err
	}
	f, err := os.Open(s.blobPath(hash))
	if errors.Is(err, os.ErrNotExist) {
		return core.BlobInfo{}, nil, core.ErrNotFound
	}
	if err != nil {
		return core.BlobInfo{}, nil, err
	}
	return core.BlobInfo{Hash: row.Hash, ContentType: row.ContentType, Size: row.Size, CreatedAt: parseTS(row.CreatedAt)}, f, nil
}
