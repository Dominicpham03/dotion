-- +goose Up
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- uuid
  login       TEXT NOT NULL UNIQUE,      -- tailscale login or "owner"
  created_at  TEXT NOT NULL
);

CREATE TABLE entries (
  id          TEXT PRIMARY KEY,          -- uuid, generated on the client
  user_id     TEXT NOT NULL REFERENCES users(id),
  entry_date  TEXT,                      -- 'YYYY-MM-DD' for daily entries, NULL for free notes
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',  -- ProseMirror JSON
  body_text   TEXT NOT NULL DEFAULT '',  -- plain text for search
  version     INTEGER NOT NULL,          -- bumped on every write
  server_seq  INTEGER NOT NULL,          -- per-user change-log position
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                       -- tombstone
);
CREATE UNIQUE INDEX entries_sync ON entries(user_id, server_seq);
CREATE INDEX entries_date        ON entries(user_id, entry_date) WHERE deleted_at IS NULL;

CREATE TABLE seq_counters (              -- source of server_seq
  user_id   TEXT PRIMARY KEY REFERENCES users(id),
  last_seq  INTEGER NOT NULL
);

CREATE TABLE idempotency (
  user_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  BLOB NOT NULL,
  status        INTEGER NOT NULL,
  response      BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Full-text search. External-content table: stores only the index, reads text from entries.
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body_text, content='entries', content_rowid='rowid', tokenize='porter unicode61'
);

-- +goose StatementBegin
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
  INSERT INTO entries_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER entries_au;
DROP TRIGGER entries_ad;
DROP TRIGGER entries_ai;
DROP TABLE entries_fts;
DROP TABLE idempotency;
DROP TABLE seq_counters;
DROP TABLE entries;
DROP TABLE users;
