package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"diary/server/internal/core"
)

func (s *Store) GetIntegration(ctx context.Context, userID, provider string) (core.Integration, error) {
	var in core.Integration
	var created, config string
	err := s.reader.QueryRowContext(ctx,
		`SELECT provider, refresh_token, account_email, config, created_at FROM integrations WHERE user_id = ? AND provider = ?`,
		userID, provider).Scan(&in.Provider, &in.RefreshToken, &in.Email, &config, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Integration{}, core.ErrNotFound
	}
	in.Config = json.RawMessage(config)
	in.CreatedAt = parseTS(created)
	return in, err
}

func (s *Store) PutIntegration(ctx context.Context, userID string, in core.Integration) error {
	config := string(in.Config)
	if config == "" {
		config = "{}"
	}
	_, err := s.writer.ExecContext(ctx, `
		INSERT INTO integrations (user_id, provider, refresh_token, account_email, config, created_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, provider) DO UPDATE SET refresh_token = excluded.refresh_token,
			account_email = excluded.account_email, config = excluded.config`,
		userID, in.Provider, in.RefreshToken, in.Email, config, s.stamp())
	return err
}

func (s *Store) DeleteIntegration(ctx context.Context, userID, provider string) error {
	_, err := s.writer.ExecContext(ctx, `DELETE FROM integrations WHERE user_id = ? AND provider = ?`, userID, provider)
	return err
}

// IntegrationUsers lists the users connected to a provider (for background sync).
func (s *Store) IntegrationUsers(ctx context.Context, provider string) ([]string, error) {
	rows, err := s.reader.QueryContext(ctx, `SELECT user_id FROM integrations WHERE provider = ?`, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
