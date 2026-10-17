// Package gitlab talks to the GitLab REST API (gitlab.com or self-hosted)
// with a personal access token.
package gitlab

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"diary/server/internal/core"
)

type Client struct{ HTTP *http.Client }

func New() *Client { return &Client{HTTP: &http.Client{Timeout: 30 * time.Second}} }

func (c *Client) do(ctx context.Context, method, base, token, path string, out any) (http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+"/api/v4"+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("PRIVATE-TOKEN", token)
	req.Header.Set("Accept", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return nil, core.ErrGrantRevoked
	case res.StatusCode >= 300:
		return nil, fmt.Errorf("gitlab %s %s: %d %s", method, path, res.StatusCode, strings.TrimSpace(string(body[:min(len(body), 300)])))
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return nil, fmt.Errorf("gitlab %s: %w", path, err)
		}
	}
	return res.Header, nil
}

// User returns the token owner's username.
func (c *Client) User(ctx context.Context, base, token string) (string, error) {
	var u struct {
		Username string `json:"username"`
	}
	_, err := c.do(ctx, "GET", base, token, "/user", &u)
	return u.Username, err
}

type apiItem struct {
	ID          int64    `json:"id"`
	IID         int64    `json:"iid"`
	ProjectID   int64    `json:"project_id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	State       string   `json:"state"`
	WebURL      string   `json:"web_url"`
	DueDate     string   `json:"due_date"`
	Labels      []string `json:"labels"`
	UpdatedAt   string   `json:"updated_at"`
	References  struct {
		Full string `json:"full"`
	} `json:"references"`
}

func (c *Client) list(ctx context.Context, base, token, kind, path string, since time.Time) ([]core.GitLabItem, error) {
	var out []core.GitLabItem
	for page := 1; page <= 20; page++ { // at most 2,000 per kind and sync
		q := url.Values{
			"scope": {"assigned_to_me"}, "state": {"all"}, "per_page": {"100"}, "page": {strconv.Itoa(page)},
			"updated_after": {since.UTC().Format(time.RFC3339)}, "order_by": {"updated_at"}, "sort": {"asc"},
		}
		var items []apiItem
		hdr, err := c.do(ctx, "GET", base, token, path+"?"+q.Encode(), &items)
		if err != nil {
			return nil, err
		}
		for _, it := range items {
			project := it.References.Full
			if i := strings.LastIndexAny(project, "#!"); i > 0 {
				project = project[:i]
			}
			out = append(out, core.GitLabItem{
				Kind: kind, GlobalID: it.ID, ProjectID: it.ProjectID, IID: it.IID, Title: it.Title,
				Description: it.Description, State: it.State, URL: it.WebURL, Due: it.DueDate,
				Labels: it.Labels, Ref: it.References.Full, Project: project, UpdatedAt: it.UpdatedAt,
			})
		}
		if hdr.Get("X-Next-Page") == "" {
			break
		}
	}
	return out, nil
}

func (c *Client) Issues(ctx context.Context, base, token string, since time.Time) ([]core.GitLabItem, error) {
	return c.list(ctx, base, token, "issue", "/issues", since)
}

func (c *Client) MergeRequests(ctx context.Context, base, token string, since time.Time) ([]core.GitLabItem, error) {
	return c.list(ctx, base, token, "mr", "/merge_requests", since)
}

// SetIssueState closes or reopens an issue.
func (c *Client) SetIssueState(ctx context.Context, base, token string, projectID, iid int64, closed bool) error {
	event := "reopen"
	if closed {
		event = "close"
	}
	_, err := c.do(ctx, "PUT", base, token, fmt.Sprintf("/projects/%d/issues/%d?state_event=%s", projectID, iid, event), nil)
	return err
}
