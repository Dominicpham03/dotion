-- Connections to external services (Google Calendar). The refresh token is
-- what lets the server read events without asking again.

-- +goose Up
CREATE TABLE integrations (
  user_id        TEXT NOT NULL REFERENCES users(id),
  provider       TEXT NOT NULL,          -- 'google'
  refresh_token  TEXT NOT NULL,
  account_email  TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- +goose Down
DROP TABLE integrations;
