package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"

	"diary/server/internal/core"
	"diary/shared/syncproto"
)

const (
	OwnerLogin = "owner"
	TokenTTL   = 30 * 24 * time.Hour

	loginWindow   = time.Minute
	loginAttempts = 5
)

// Password signs the single owner in with one password. Tokens are
// base64(payload).base64(HMAC-SHA256(payload)); rotating the secret signs
// out every device.
type Password struct {
	hash   phc
	secret []byte
	now    func() time.Time

	mu       sync.Mutex
	attempts map[string][]time.Time // client IP → recent failures
}

type tokenPayload struct {
	Login     string `json:"login"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func NewPassword(phcHash string, secret []byte) (*Password, error) {
	h, err := parsePHC(phcHash)
	if err != nil {
		return nil, fmt.Errorf("DIARY_PASSWORD_HASH: %w", err)
	}
	return &Password{hash: h, secret: secret, now: time.Now, attempts: map[string][]time.Time{}}, nil
}

// Identify accepts the session cookie (web) or a bearer token (desktop).
func (a *Password) Identify(r *http.Request) (string, error) {
	token := ""
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		token = strings.TrimPrefix(h, "Bearer ")
	} else if c, err := r.Cookie(syncproto.SessionCookie); err == nil {
		token = c.Value
	}
	if token == "" {
		return "", core.ErrUnauthenticated
	}
	p, err := a.verify(token)
	if err != nil {
		return "", core.ErrUnauthenticated
	}
	return p.Login, nil
}

// Login checks the password, rate limited per client IP.
func (a *Password) Login(_ context.Context, password, clientIP string) (string, string, time.Time, error) {
	now := a.now()
	if !a.allow(clientIP, now) {
		return "", "", time.Time{}, core.ErrRateLimited
	}
	if !a.hash.matches(password) {
		a.fail(clientIP, now)
		return "", "", time.Time{}, core.ErrUnauthenticated
	}
	exp := now.Add(TokenTTL)
	token, err := a.sign(tokenPayload{Login: OwnerLogin, IssuedAt: now.Unix(), ExpiresAt: exp.Unix()})
	return OwnerLogin, token, exp, err
}

func (a *Password) allow(ip string, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	recent := a.attempts[ip][:0]
	for _, t := range a.attempts[ip] {
		if now.Sub(t) < loginWindow {
			recent = append(recent, t)
		}
	}
	a.attempts[ip] = recent
	return len(recent) < loginAttempts
}

func (a *Password) fail(ip string, now time.Time) {
	a.mu.Lock()
	a.attempts[ip] = append(a.attempts[ip], now)
	a.mu.Unlock()
}

func (a *Password) sign(p tokenPayload) (string, error) {
	body, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	return enc.EncodeToString(body) + "." + enc.EncodeToString(a.mac(body)), nil
}

func (a *Password) verify(token string) (tokenPayload, error) {
	enc := base64.RawURLEncoding
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return tokenPayload{}, errors.New("malformed token")
	}
	body, err1 := enc.DecodeString(parts[0])
	sig, err2 := enc.DecodeString(parts[1])
	if err1 != nil || err2 != nil || !hmac.Equal(sig, a.mac(body)) {
		return tokenPayload{}, errors.New("bad signature")
	}
	var p tokenPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return tokenPayload{}, err
	}
	if a.now().Unix() >= p.ExpiresAt {
		return tokenPayload{}, errors.New("expired")
	}
	return p, nil
}

func (a *Password) mac(body []byte) []byte {
	m := hmac.New(sha256.New, a.secret)
	m.Write(body)
	return m.Sum(nil)
}

// ---- argon2id PHC strings -------------------------------------------------

type phc struct {
	memory  uint32
	time    uint32
	threads uint8
	salt    []byte
	key     []byte
}

// HashPassword returns an argon2id PHC string with sensible parameters.
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	const memory, iterations, threads = 64 * 1024, 3, 2
	key := argon2.IDKey([]byte(password), salt, iterations, memory, threads, 32)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, memory, iterations, threads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func parsePHC(s string) (phc, error) {
	parts := strings.Split(s, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return phc{}, errors.New("must be an argon2id PHC string (run `diary hash-password`)")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return phc{}, errors.New("unsupported argon2 version")
	}
	var h phc
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &h.memory, &h.time, &h.threads); err != nil {
		return phc{}, errors.New("bad argon2 parameters")
	}
	var err error
	if h.salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil {
		return phc{}, errors.New("bad salt")
	}
	if h.key, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil || len(h.key) == 0 {
		return phc{}, errors.New("bad hash")
	}
	return h, nil
}

func (h phc) matches(password string) bool {
	key := argon2.IDKey([]byte(password), h.salt, h.time, h.memory, h.threads, uint32(len(h.key)))
	return subtle.ConstantTimeCompare(key, h.key) == 1
}
