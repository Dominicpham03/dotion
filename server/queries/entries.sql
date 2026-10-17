-- name: GetEntry :one
SELECT *
FROM entries
WHERE id = ? AND user_id = ?;

-- name: NextSeq :one
INSERT INTO seq_counters (user_id, last_seq) VALUES (?, 1)
ON CONFLICT (user_id) DO UPDATE SET last_seq = last_seq + 1
RETURNING last_seq;

-- name: ChangesSince :many
SELECT *
FROM entries
WHERE user_id = ? AND server_seq > ?
ORDER BY server_seq
LIMIT ?;

-- PutEntry step 2: load current state
-- name: GetEntryVersion :one
SELECT version, deleted_at FROM entries
WHERE id = ? AND user_id = ?;

-- PutEntry step 5, new entry (base_version = 0)
-- name: InsertEntry :exec
INSERT INTO entries (id, user_id, entry_date, kind, parent_id, title, body, body_text, meta, version, server_seq, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?);

-- PutEntry step 5, existing entry. The version guard is repeated in SQL;
-- 0 rows affected means someone else saved first.
-- name: UpdateEntry :execrows
UPDATE entries
SET entry_date = ?, kind = ?, parent_id = ?, title = ?, body = ?, body_text = ?, meta = ?,
    version = version + 1, server_seq = ?, updated_at = ?, deleted_at = NULL
WHERE id = ? AND user_id = ? AND version = ?;

-- DeleteEntry: tombstone with the content wiped (kind and parent stay, so
-- views can drop the record)
-- name: TombstoneEntry :execrows
UPDATE entries
SET deleted_at = ?, title = '', body = '{"type":"doc","content":[]}', body_text = '', meta = '{}',
    version = version + 1, server_seq = ?, updated_at = ?
WHERE id = ? AND user_id = ? AND version = ?;

-- Calendar / list view
-- name: ListByDate :many
SELECT *
FROM entries
WHERE user_id = sqlc.arg(user_id)
  AND entry_date >= sqlc.arg(from_date)
  AND entry_date <= sqlc.arg(to_date)
  AND deleted_at IS NULL
ORDER BY entry_date, created_at;

-- PutEntry step 1: was this request already handled?
-- name: GetIdempotency :one
SELECT request_hash, status, response FROM idempotency
WHERE user_id = ? AND key = ?;

-- PutEntry step 6: remember the response for retries
-- name: InsertIdempotency :exec
INSERT INTO idempotency (user_id, key, request_hash, status, response, created_at)
VALUES (?, ?, ?, ?, ?, ?);

-- CleanupLoop: drop records older than 7 days
-- name: DeleteOldIdempotency :execrows
DELETE FROM idempotency WHERE created_at < ?;

-- Sync pull: a cursor beyond this means the server was restored from a backup (no row = 0)
-- name: GetLastSeq :one
SELECT last_seq FROM seq_counters WHERE user_id = ?;

-- Sidebar: most recently changed live entries (database records excluded)
-- name: ListRecent :many
SELECT *
FROM entries
WHERE entries.user_id = sqlc.arg(user_id) AND entries.deleted_at IS NULL
  AND (entries.parent_id IS NULL OR entries.parent_id NOT IN (
    SELECT d.id FROM entries d WHERE d.user_id = sqlc.arg(user_id) AND d.kind = 'database'))
ORDER BY updated_at DESC
LIMIT sqlc.arg(row_limit);

-- Export: every live entry
-- name: AllEntries :many
SELECT *
FROM entries
WHERE user_id = ? AND deleted_at IS NULL
ORDER BY entry_date, created_at;

-- Sub-pages of a page, or the records of a database
-- name: ListChildren :many
SELECT *
FROM entries
WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL
ORDER BY created_at;

-- Sidebar tree roots: undated pages and databases with no parent
-- name: ListRootPages :many
SELECT *
FROM entries
WHERE user_id = ? AND parent_id IS NULL AND entry_date IS NULL AND deleted_at IS NULL
ORDER BY title COLLATE NOCASE, created_at;

-- name: DeleteLinksFrom :exec
DELETE FROM entry_links WHERE user_id = ? AND from_id = ?;

-- name: InsertLink :exec
INSERT OR IGNORE INTO entry_links (user_id, from_id, to_id) VALUES (?, ?, ?);

-- Live entries that link to an entry
-- name: Backlinks :many
SELECT *
FROM entries
WHERE entries.user_id = sqlc.arg(user_id) AND entries.deleted_at IS NULL AND entries.id != sqlc.arg(to_id)
  AND entries.id IN (SELECT l.from_id FROM entry_links l WHERE l.user_id = sqlc.arg(user_id) AND l.to_id = sqlc.arg(to_id))
ORDER BY updated_at DESC;

-- name: InsertBlob :exec
INSERT OR IGNORE INTO blobs (user_id, hash, content_type, size, created_at) VALUES (?, ?, ?, ?, ?);

-- name: GetBlob :one
SELECT hash, content_type, size, created_at FROM blobs WHERE user_id = ? AND hash = ?;
