// Package secrets keeps the sign-in token in the OS keychain (Windows
// Credential Manager, macOS Keychain, Secret Service on Linux).
package secrets

import (
	"errors"
	"sync"

	"github.com/zalando/go-keyring"
)

const service = "Dotion"

// Store saves one token per server URL.
type Store interface {
	Get(serverURL string) (string, error) // "" if none
	Set(serverURL, token string) error
	Delete(serverURL string) error
}

type Keychain struct{}

func (Keychain) Get(serverURL string) (string, error) {
	t, err := keyring.Get(service, serverURL)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return t, err
}

func (Keychain) Set(serverURL, token string) error { return keyring.Set(service, serverURL, token) }

func (Keychain) Delete(serverURL string) error {
	err := keyring.Delete(service, serverURL)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// Memory is an in-process Store for tests.
type Memory struct {
	mu sync.Mutex
	m  map[string]string
}

func (s *Memory) Get(u string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[u], nil
}

func (s *Memory) Set(u, t string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = map[string]string{}
	}
	s.m[u] = t
	return nil
}

func (s *Memory) Delete(u string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, u)
	return nil
}
