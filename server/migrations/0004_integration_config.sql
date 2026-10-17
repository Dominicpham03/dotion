-- Per-connection settings: granted Google scopes; the GitLab address,
-- username, database id and last sync time.

-- +goose Up
ALTER TABLE integrations ADD COLUMN config TEXT NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE integrations DROP COLUMN config;
