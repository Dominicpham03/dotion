// Package google reads Google Calendar and Drive for the diary owner, and adds
// the owner's action items to their calendar, using the OAuth 2.0 web-server flow.
package google

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"diary/server/internal/core"
)

// Scopes: read calendars, events and Drive files, add events (action items),
// and learn which account was connected.
const Scopes = "openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly"

// DriveScope is the read-only Drive permission; older connections lack it.
const DriveScope = "https://www.googleapis.com/auth/drive.readonly"

// Client is the Google adapter. The URL fields exist so tests can point it at
// a fake Google.
type Client struct {
	ClientID, ClientSecret string
	AuthEndpoint           string // https://accounts.google.com/o/oauth2/v2/auth
	TokenEndpoint          string // https://oauth2.googleapis.com/token
	RevokeEndpoint         string // https://oauth2.googleapis.com/revoke
	APIBase                string // https://www.googleapis.com/calendar/v3
	DriveBase              string // https://www.googleapis.com/drive/v3
	HTTP                   *http.Client

	mu     sync.Mutex
	tokens map[string]accessToken // refresh token → current access token
}

type accessToken struct {
	value   string
	expires time.Time
}

func New(clientID, clientSecret string) *Client {
	return &Client{
		ClientID: clientID, ClientSecret: clientSecret,
		AuthEndpoint:   "https://accounts.google.com/o/oauth2/v2/auth",
		TokenEndpoint:  "https://oauth2.googleapis.com/token",
		RevokeEndpoint: "https://oauth2.googleapis.com/revoke",
		APIBase:        "https://www.googleapis.com/calendar/v3",
		DriveBase:      "https://www.googleapis.com/drive/v3",
		HTTP:           &http.Client{Timeout: 20 * time.Second},
		tokens:         map[string]accessToken{},
	}
}

// AuthURL is where the user is sent to approve access. access_type=offline
// and prompt=consent make Google return a refresh token every time.
func (c *Client) AuthURL(state, redirectURI string) string {
	q := url.Values{
		"client_id":              {c.ClientID},
		"redirect_uri":           {redirectURI},
		"response_type":          {"code"},
		"scope":                  {Scopes},
		"access_type":            {"offline"},
		"prompt":                 {"consent"},
		"state":                  {state},
		"include_granted_scopes": {"true"},
	}
	return c.AuthEndpoint + "?" + q.Encode()
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

func (c *Client) token(ctx context.Context, form url.Values) (tokenResponse, error) {
	form.Set("client_id", c.ClientID)
	form.Set("client_secret", c.ClientSecret)
	req, err := http.NewRequestWithContext(ctx, "POST", c.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return tokenResponse{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return tokenResponse{}, err
	}
	defer res.Body.Close()
	var tr tokenResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&tr); err != nil {
		return tokenResponse{}, fmt.Errorf("google token endpoint: %w", err)
	}
	if tr.Error == "invalid_grant" {
		return tr, core.ErrGrantRevoked
	}
	if res.StatusCode != http.StatusOK || tr.Error != "" {
		return tr, fmt.Errorf("google token endpoint: %s %s", tr.Error, tr.Description)
	}
	return tr, nil
}

// Exchange trades the authorization code for a refresh token.
func (c *Client) Exchange(ctx context.Context, code, redirectURI string) (core.Grant, error) {
	tr, err := c.token(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirectURI}})
	if err != nil {
		return core.Grant{}, err
	}
	if tr.RefreshToken == "" {
		return core.Grant{}, errors.New("google returned no refresh token")
	}
	c.remember(tr.RefreshToken, tr)
	return core.Grant{RefreshToken: tr.RefreshToken, Email: emailFromIDToken(tr.IDToken), Scopes: tr.Scope}, nil
}

// emailFromIDToken reads the email claim. The token came straight from
// Google over TLS, so its signature needs no separate check here.
func emailFromIDToken(idToken string) string {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.Email
}

func (c *Client) remember(refresh string, tr tokenResponse) {
	c.mu.Lock()
	c.tokens[refresh] = accessToken{value: tr.AccessToken, expires: time.Now().Add(time.Duration(tr.ExpiresIn)*time.Second - time.Minute)}
	c.mu.Unlock()
}

func (c *Client) access(ctx context.Context, refresh string) (string, error) {
	c.mu.Lock()
	t, ok := c.tokens[refresh]
	c.mu.Unlock()
	if ok && time.Now().Before(t.expires) {
		return t.value, nil
	}
	tr, err := c.token(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}})
	if err != nil {
		return "", err
	}
	c.remember(refresh, tr)
	return tr.AccessToken, nil
}

func (c *Client) get(ctx context.Context, access, path string, q url.Values, out any) error {
	return c.getURL(ctx, access, c.APIBase+path+"?"+q.Encode(), out)
}

func (c *Client) getURL(ctx context.Context, access, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return core.ErrGrantRevoked
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("google api %s: %d %s", req.URL.Path, res.StatusCode, body)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

type calendarList struct {
	Items []struct {
		ID              string `json:"id"`
		Summary         string `json:"summary"`
		SummaryOverride string `json:"summaryOverride"`
		BackgroundColor string `json:"backgroundColor"`
		Selected        bool   `json:"selected"`
		Primary         bool   `json:"primary"`
	} `json:"items"`
}

type eventList struct {
	Items []struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		Summary  string `json:"summary"`
		Location string `json:"location"`
		HTMLLink string `json:"htmlLink"`
		Start    struct {
			Date     string `json:"date"`
			DateTime string `json:"dateTime"`
		} `json:"start"`
		End struct {
			Date     string `json:"date"`
			DateTime string `json:"dateTime"`
		} `json:"end"`
	} `json:"items"`
	NextPageToken string `json:"nextPageToken"`
}

// Events returns events between start and end from every calendar the user
// shows in Google Calendar (the primary one at least), sorted by start.
func (c *Client) Events(ctx context.Context, refresh string, start, end time.Time) ([]core.CalendarEvent, error) {
	access, err := c.access(ctx, refresh)
	if err != nil {
		return nil, err
	}
	var cals calendarList
	if err := c.get(ctx, access, "/users/me/calendarList", url.Values{"minAccessRole": {"reader"}}, &cals); err != nil {
		return nil, err
	}
	out := []core.CalendarEvent{}
	for _, cal := range cals.Items {
		if !cal.Selected && !cal.Primary {
			continue
		}
		name := cal.SummaryOverride
		if name == "" {
			name = cal.Summary
		}
		page := ""
		for n := 0; n < 5; n++ { // at most 5 × 250 events per calendar and range
			q := url.Values{
				"timeMin": {start.Format(time.RFC3339)}, "timeMax": {end.Format(time.RFC3339)},
				"singleEvents": {"true"}, "orderBy": {"startTime"}, "maxResults": {"250"},
			}
			if page != "" {
				q.Set("pageToken", page)
			}
			var evs eventList
			if err := c.get(ctx, access, "/calendars/"+url.PathEscape(cal.ID)+"/events", q, &evs); err != nil {
				return nil, err
			}
			for _, e := range evs.Items {
				if e.Status == "cancelled" {
					continue
				}
				ev := core.CalendarEvent{
					ID: cal.ID + "/" + e.ID, Title: e.Summary, Location: e.Location, Link: e.HTMLLink,
					Calendar: name, Color: cal.BackgroundColor,
				}
				if e.Start.Date != "" {
					ev.AllDay, ev.Start, ev.End = true, e.Start.Date, e.End.Date
				} else {
					ev.Start, ev.End = e.Start.DateTime, e.End.DateTime
				}
				if ev.Title == "" {
					ev.Title = "(No title)"
				}
				out = append(out, ev)
			}
			if page = evs.NextPageToken; page == "" {
				break
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return startKey(out[i]) < startKey(out[j]) })
	return out, nil
}

// startKey sorts all-day events first on their day.
func startKey(e core.CalendarEvent) string {
	if e.AllDay {
		return e.Start + "T00:00:00"
	}
	if t, err := time.Parse(time.RFC3339, e.Start); err == nil {
		return t.UTC().Format("2006-01-02T15:04:05")
	}
	return e.Start
}

// CreateEvent adds an all-day event to the primary calendar. The event id is
// derived from ev.Key, so adding the same item twice keeps one event.
func (c *Client) CreateEvent(ctx context.Context, refresh string, ev core.NewEvent) (core.CreatedEvent, error) {
	access, err := c.access(ctx, refresh)
	if err != nil {
		return core.CreatedEvent{}, err
	}
	day, err := time.Parse(time.DateOnly, ev.Date)
	if err != nil {
		return core.CreatedEvent{}, err
	}
	// Event ids allow the characters 0-9 and a-v; a hex digest qualifies.
	id := "dotion" + strings.ReplaceAll(ev.Key, "-", "")
	body, _ := json.Marshal(map[string]any{
		"id":           id,
		"summary":      ev.Title,
		"description":  ev.Description,
		"start":        map[string]string{"date": ev.Date},
		"end":          map[string]string{"date": day.AddDate(0, 0, 1).Format(time.DateOnly)},
		"transparency": "transparent", // an all-day to-do shouldn't block the day
	})
	req, err := http.NewRequestWithContext(ctx, "POST", c.APIBase+"/calendars/primary/events", strings.NewReader(string(body)))
	if err != nil {
		return core.CreatedEvent{}, err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return core.CreatedEvent{}, err
	}
	defer res.Body.Close()
	var out struct {
		ID       string `json:"id"`
		HTMLLink string `json:"htmlLink"`
	}
	switch res.StatusCode {
	case http.StatusOK, http.StatusCreated:
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
			return core.CreatedEvent{}, err
		}
		return core.CreatedEvent{ID: out.ID, Link: out.HTMLLink}, nil
	case http.StatusConflict:
		return core.CreatedEvent{ID: id}, nil // added before
	case http.StatusUnauthorized:
		return core.CreatedEvent{}, core.ErrGrantRevoked
	case http.StatusForbidden:
		return core.CreatedEvent{}, core.ErrNoCalendarWrite
	default:
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return core.CreatedEvent{}, fmt.Errorf("google calendar insert: %d %s", res.StatusCode, msg)
	}
}

// Revoke withdraws the diary's access at Google.
func (c *Client) Revoke(ctx context.Context, refresh string) error {
	req, err := http.NewRequestWithContext(ctx, "POST", c.RevokeEndpoint, strings.NewReader(url.Values{"token": {refresh}}.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	c.mu.Lock()
	delete(c.tokens, refresh)
	c.mu.Unlock()
	return nil
}
