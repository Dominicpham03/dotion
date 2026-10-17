// Package memnotifier is the in-process core.Notifier: Go channels, one
// buffered slot per subscriber, latest cursor wins.
package memnotifier

import (
	"context"
	"sync"
)

type Notifier struct {
	mu     sync.Mutex
	subs   map[string]map[*sub]struct{} // userID → subscribers
	closed bool
}

type sub struct{ ch chan int64 }

func New() *Notifier { return &Notifier{subs: map[string]map[*sub]struct{}{}} }

func (n *Notifier) Subscribe(_ context.Context, userID string) (<-chan int64, func()) {
	s := &sub{ch: make(chan int64, 1)}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		close(s.ch)
		return s.ch, func() {}
	}
	if n.subs[userID] == nil {
		n.subs[userID] = map[*sub]struct{}{}
	}
	n.subs[userID][s] = struct{}{}
	return s.ch, func() {
		n.mu.Lock()
		delete(n.subs[userID], s)
		n.mu.Unlock()
	}
}

// Publish never blocks: a slow subscriber's stale cursor is replaced, because
// only the latest one matters.
func (n *Notifier) Publish(_ context.Context, userID string, cursor int64) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	for s := range n.subs[userID] {
		select {
		case s.ch <- cursor:
		default:
			select {
			case <-s.ch:
			default:
			}
			s.ch <- cursor
		}
	}
	return nil
}

// CloseAll ends every stream, so clients reconnect promptly to the next
// server process.
func (n *Notifier) CloseAll() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.closed = true
	for _, set := range n.subs {
		for s := range set {
			close(s.ch)
		}
	}
	n.subs = map[string]map[*sub]struct{}{}
}
