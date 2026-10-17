package google

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

const googleDocMime = "application/vnd.google-apps.document"

type driveList struct {
	Files []struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		MimeType     string `json:"mimeType"`
		ModifiedTime string `json:"modifiedTime"`
		WebViewLink  string `json:"webViewLink"`
		IconLink     string `json:"iconLink"`
		Owners       []struct {
			DisplayName string `json:"displayName"`
		} `json:"owners"`
	} `json:"files"`
	NextPageToken string `json:"nextPageToken"`
}

// DriveSearch lists files: by name or content when query is set, else the
// most recently modified. Trashed files are left out.
func (c *Client) DriveSearch(ctx context.Context, refresh, query, pageToken string) ([]syncproto.DriveFile, string, error) {
	access, err := c.access(ctx, refresh)
	if err != nil {
		return nil, "", err
	}
	q := "trashed = false"
	if query = strings.TrimSpace(query); query != "" {
		esc := strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(query)
		q += fmt.Sprintf(" and (name contains '%s' or fullText contains '%s')", esc, esc)
	}
	params := url.Values{
		"q":                         {q},
		"pageSize":                  {"25"},
		"fields":                    {"files(id,name,mimeType,modifiedTime,webViewLink,iconLink,owners(displayName)),nextPageToken"},
		"supportsAllDrives":         {"true"},
		"includeItemsFromAllDrives": {"true"},
	}
	if query == "" {
		params.Set("orderBy", "modifiedTime desc")
	}
	if pageToken != "" {
		params.Set("pageToken", pageToken)
	}
	var list driveList
	if err := c.getURL(ctx, access, c.DriveBase+"/files?"+params.Encode(), &list); err != nil {
		return nil, "", err
	}
	files := make([]syncproto.DriveFile, 0, len(list.Files))
	for _, f := range list.Files {
		df := syncproto.DriveFile{
			ID: f.ID, Name: f.Name, MimeType: f.MimeType, Modified: f.ModifiedTime,
			Link: f.WebViewLink, IconLink: f.IconLink, CanImport: f.MimeType == googleDocMime,
		}
		if len(f.Owners) > 0 {
			df.Owner = f.Owners[0].DisplayName
		}
		files = append(files, df)
	}
	return files, list.NextPageToken, nil
}

// DriveMarkdown exports a Google Doc as Markdown, for importing as a page.
func (c *Client) DriveMarkdown(ctx context.Context, refresh, fileID string) (string, string, error) {
	access, err := c.access(ctx, refresh)
	if err != nil {
		return "", "", err
	}
	var meta struct {
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
	}
	base := c.DriveBase + "/files/" + url.PathEscape(fileID)
	if err := c.getURL(ctx, access, base+"?fields=name,mimeType&supportsAllDrives=true", &meta); err != nil {
		return "", "", err
	}
	if meta.MimeType != googleDocMime {
		return "", "", &core.ValidationError{Fields: map[string]string{"id": "only Google Docs can be imported as pages"}}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/export?mimeType="+url.QueryEscape("text/markdown"), nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return "", "", core.ErrGrantRevoked
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 5<<20))
	if err != nil {
		return "", "", err
	}
	if res.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("google drive export: %d %s", res.StatusCode, body)
	}
	return meta.Name, string(body), nil
}
