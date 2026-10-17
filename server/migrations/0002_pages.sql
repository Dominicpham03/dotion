-- Pages, databases, links between entries, and stored images.

-- +goose Up
ALTER TABLE entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';  -- 'page' | 'database'
ALTER TABLE entries ADD COLUMN parent_id TEXT;                      -- parent page, or a record's database
ALTER TABLE entries ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';     -- icon, properties, database schema
CREATE INDEX entries_parent ON entries(user_id, parent_id) WHERE deleted_at IS NULL;

-- Derived from bodies (page links, embedded views) and relation properties on
-- every write, so each page can list what links to it.
CREATE TABLE entry_links (
  user_id  TEXT NOT NULL,
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  PRIMARY KEY (user_id, from_id, to_id)
);
CREATE INDEX entry_links_to ON entry_links(user_id, to_id);

-- Images. The bytes live in <data>/blobs/<hash>; rows record who owns which.
CREATE TABLE blobs (
  user_id       TEXT NOT NULL,
  hash          TEXT NOT NULL,           -- sha256 of the bytes, hex
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, hash)
);

-- +goose Down
DROP TABLE blobs;
DROP TABLE entry_links;
DROP INDEX entries_parent;
ALTER TABLE entries DROP COLUMN meta;
ALTER TABLE entries DROP COLUMN parent_id;
ALTER TABLE entries DROP COLUMN kind;
