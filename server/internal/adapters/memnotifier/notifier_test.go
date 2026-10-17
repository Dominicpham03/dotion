package memnotifier

import (
	"context"
	"testing"
	"time"
)

func TestSlowSubscriberGetsLatestAndNeverBlocks(t *testing.T) {
	n := New()
	ctx := context.Background()
	ch, cancel := n.Subscribe(ctx, "u1")
	defer cancel()
	other, cancelOther := n.Subscribe(ctx, "u2")
	defer cancelOther()

	done := make(chan struct{})
	go func() {
		for i := int64(1); i <= 1000; i++ {
			_ = n.Publish(ctx, "u1", i)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on a subscriber that never reads")
	}
	if got := <-ch; got != 1000 {
		t.Errorf("got cursor %d, want the latest (1000)", got)
	}
	select {
	case c := <-other:
		t.Errorf("another user's subscriber got %d", c)
	default:
	}
}

func TestCloseAllEndsStreams(t *testing.T) {
	n := New()
	ch, cancel := n.Subscribe(context.Background(), "u1")
	n.CloseAll()
	cancel() // safe after CloseAll
	if _, ok := <-ch; ok {
		t.Error("channel still open after CloseAll")
	}
	late, _ := n.Subscribe(context.Background(), "u1")
	if _, ok := <-late; ok {
		t.Error("subscribe after CloseAll returned an open channel")
	}
}
