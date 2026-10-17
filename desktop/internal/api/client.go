// Package api is the desktop app's typed HTTP client for the /v1 API.
package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"diary/shared/model"
	"diary/shared/syncproto"
)

// Error is an answer from the server with a non-2xx status.
type Error struct {
	Status int
	syncproto.ErrorResponse
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("server answered %d %s", e.Status, e.ErrorResponse.Error)
}

// IsNetwork reports whether err means the server could not be reached (or
// failed on its side), so the request should be retried later.
func IsNetwork(err error) bool {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr.Status >= 500
	}
	return err != nil && !errors.Is(err, context.Canceled)
}

type Client struct {
	BaseURL string // https://diary.<tailnet>.ts.net
	Token   string // password mode only
	HTTP    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any, idemKey string, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return err
	}
	c.headers(req)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idemKey != "" {
		req.Header.Set(syncproto.HeaderIdempotencyKey, idemKey)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		e := &Error{Status: res.StatusCode}
		_ = json.Unmarshal(data, &e.ErrorResponse)
		return e
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (c *Client) headers(req *http.Request) {
	req.Header.Set(syncproto.HeaderClient, "1")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
}

func (c *Client) Health(ctx context.Context) error {
	return c.do(ctx, "GET", "/v1/health", nil, "", nil)
}

func (c *Client) Me(ctx context.Context) (syncproto.MeResponse, error) {
	var me syncproto.MeResponse
	err := c.do(ctx, "GET", "/v1/me", nil, "", &me)
	return me, err
}

func (c *Client) Login(ctx context.Context, password string) (syncproto.LoginResponse, error) {
	var out syncproto.LoginResponse
	err := c.do(ctx, "POST", "/v1/auth/login", syncproto.LoginRequest{Password: password}, "", &out)
	return out, err
}

func (c *Client) PutEntry(ctx context.Context, id, idemKey string, req syncproto.PutEntryRequest) (model.Entry, error) {
	var e model.Entry
	err := c.do(ctx, "PUT", "/v1/entries/"+url.PathEscape(id), req, idemKey, &e)
	return e, err
}

func (c *Client) DeleteEntry(ctx context.Context, id, idemKey string, baseVersion int) (model.Entry, error) {
	var e model.Entry
	err := c.do(ctx, "DELETE", "/v1/entries/"+url.PathEscape(id)+"?base_version="+strconv.Itoa(baseVersion), nil, idemKey, &e)
	return e, err
}

func (c *Client) Sync(ctx context.Context, since int64, limit int) (syncproto.SyncResponse, error) {
	var out syncproto.SyncResponse
	err := c.do(ctx, "GET", fmt.Sprintf("/v1/sync?since=%d&limit=%d", since, limit), nil, "", &out)
	return out, err
}

// Events holds GET /v1/events open and calls onChanged for every "changed"
// notice until the stream ends or ctx is cancelled. onOpen runs once the
// stream is established.
func (c *Client) Events(ctx context.Context, onOpen func(), onChanged func(cursor int64)) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.BaseURL+"/v1/events", nil)
	if err != nil {
		return err
	}
	c.headers(req)
	req.Header.Set("Accept", "text/event-stream")
	stream := &http.Client{} // no timeout: the stream stays open
	res, err := stream.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return &Error{Status: res.StatusCode}
	}
	onOpen()
	sc := bufio.NewScanner(res.Body)
	event := ""
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			event = ""
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:") && event == "changed":
			var ev syncproto.ChangedEvent
			if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &ev) == nil {
				onChanged(ev.Cursor)
			}
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return io.EOF
}

// UploadBlob sends image bytes; the server answers with their hash.
func (c *Client) UploadBlob(ctx context.Context, data []byte) (syncproto.BlobResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/v1/blobs", bytes.NewReader(data))
	if err != nil {
		return syncproto.BlobResponse{}, err
	}
	c.headers(req)
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return syncproto.BlobResponse{}, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		e := &Error{Status: res.StatusCode}
		_ = json.Unmarshal(body, &e.ErrorResponse)
		return syncproto.BlobResponse{}, e
	}
	var out syncproto.BlobResponse
	return out, json.Unmarshal(body, &out)
}

// DownloadBlob fetches image bytes and their content type.
func (c *Client) DownloadBlob(ctx context.Context, hash string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.BaseURL+"/v1/blobs/"+url.PathEscape(hash), nil)
	if err != nil {
		return nil, "", err
	}
	c.headers(req)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", &Error{Status: res.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 11<<20))
	return data, res.Header.Get("Content-Type"), err
}

func (c *Client) GoogleStatus(ctx context.Context) (syncproto.GoogleStatus, error) {
	var out syncproto.GoogleStatus
	err := c.do(ctx, "GET", "/v1/integrations/google", nil, "", &out)
	return out, err
}

// GoogleStart returns the Google sign-in URL to open in a browser.
func (c *Client) GoogleStart(ctx context.Context) (string, error) {
	var out struct {
		URL string `json:"url"`
	}
	err := c.do(ctx, "POST", "/v1/integrations/google/start", map[string]string{"client": "app"}, "", &out)
	return out.URL, err
}

func (c *Client) GoogleDisconnect(ctx context.Context) error {
	return c.do(ctx, "DELETE", "/v1/integrations/google", nil, "", nil)
}

func (c *Client) CalendarEvents(ctx context.Context, start, end string) (syncproto.EventsResponse, error) {
	var out syncproto.EventsResponse
	err := c.do(ctx, "GET", "/v1/calendar/events?start="+url.QueryEscape(start)+"&end="+url.QueryEscape(end), nil, "", &out)
	return out, err
}

func (c *Client) DriveSearch(ctx context.Context, query, page string) (syncproto.DriveFilesResponse, error) {
	q := url.Values{"q": {query}}
	if page != "" {
		q.Set("page", page)
	}
	var out syncproto.DriveFilesResponse
	err := c.do(ctx, "GET", "/v1/drive/files?"+q.Encode(), nil, "", &out)
	return out, err
}

func (c *Client) DriveMarkdown(ctx context.Context, id string) (syncproto.DriveMarkdownResponse, error) {
	var out syncproto.DriveMarkdownResponse
	err := c.do(ctx, "GET", "/v1/drive/files/"+url.PathEscape(id)+"/markdown", nil, "", &out)
	return out, err
}

func (c *Client) GitLabStatus(ctx context.Context) (syncproto.GitLabStatus, error) {
	var out syncproto.GitLabStatus
	err := c.do(ctx, "GET", "/v1/integrations/gitlab", nil, "", &out)
	return out, err
}

func (c *Client) GitLabConnect(ctx context.Context, baseURL, token string) (syncproto.GitLabStatus, error) {
	var out syncproto.GitLabStatus
	err := c.do(ctx, "POST", "/v1/integrations/gitlab", syncproto.GitLabConnectRequest{URL: baseURL, Token: token}, "", &out)
	return out, err
}

func (c *Client) GitLabSync(ctx context.Context) (syncproto.GitLabSyncResponse, error) {
	var out syncproto.GitLabSyncResponse
	err := c.do(ctx, "POST", "/v1/integrations/gitlab/sync", struct{}{}, "", &out)
	return out, err
}

func (c *Client) GitLabDisconnect(ctx context.Context) error {
	return c.do(ctx, "DELETE", "/v1/integrations/gitlab", nil, "", nil)
}

// slow is a copy without the 30 s client timeout, for AI calls that run
// model tool loops; the caller's context sets the limit.
func (c *Client) slow() *Client {
	cp := *c
	cp.HTTP = &http.Client{Transport: c.HTTP.Transport}
	return &cp
}

func (c *Client) AIStatus(ctx context.Context) (syncproto.AIStatus, error) {
	var out syncproto.AIStatus
	err := c.do(ctx, "GET", "/v1/ai", nil, "", &out)
	return out, err
}

func (c *Client) AIChat(ctx context.Context, req syncproto.AIChatRequest) (syncproto.AIChatResponse, error) {
	var out syncproto.AIChatResponse
	err := c.slow().do(ctx, "POST", "/v1/ai/chat", req, "", &out)
	return out, err
}

func (c *Client) ActionsStatus(ctx context.Context) (syncproto.ActionsStatus, error) {
	var out syncproto.ActionsStatus
	err := c.do(ctx, "GET", "/v1/ai/actions", nil, "", &out)
	return out, err
}

func (c *Client) ActionsConfigure(ctx context.Context, req syncproto.ActionsConfigRequest) (syncproto.ActionsStatus, error) {
	var out syncproto.ActionsStatus
	err := c.do(ctx, "PUT", "/v1/ai/actions", req, "", &out)
	return out, err
}

func (c *Client) ActionsScan(ctx context.Context, entryID string) (syncproto.ActionsScanResponse, error) {
	var out syncproto.ActionsScanResponse
	err := c.slow().do(ctx, "POST", "/v1/ai/actions/scan", syncproto.ActionsScanRequest{EntryID: entryID}, "", &out)
	return out, err
}
