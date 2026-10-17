package httpapi

import (
	"fmt"
	"net/http"
	"time"
)

// events streams "the cursor moved" notices. It never sends entry content;
// clients respond by calling /v1/sync, so a missed notice costs nothing.
func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
	userID := userFrom(r.Context())
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{}) // no write timeout on this stream

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	updates, cancel := h.deps.Notifier.Subscribe(r.Context(), userID)
	defer cancel()

	fmt.Fprint(w, "retry: 3000\n\n")
	if err := rc.Flush(); err != nil {
		return
	}

	ping := time.NewTicker(h.deps.PingInterval) // keeps proxies from closing idle streams
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case c, ok := <-updates:
			if !ok {
				return
			}
			fmt.Fprintf(w, "id: %d\nevent: changed\ndata: {\"cursor\":%d}\n\n", c, c)
			if rc.Flush() != nil {
				return
			}
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			if rc.Flush() != nil {
				return
			}
		}
	}
}
