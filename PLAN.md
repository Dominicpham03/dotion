# Personal Diary: Project Plan

_Last updated: 2026-10-05_

A self-hosted personal diary that syncs across your own devices. It ships as a native desktop app and a web UI, both served by one small Go server running in Docker and reached privately over Tailscale.

v1 is small: one person, one server process, SQLite. Every part that could need to grow sits behind an interface, so live typing, sharing and scale can be added later without rewriting the core.

---

## 1. Goals

**v1 (build now)**
- Write diary entries on the desktop app (offline-first) and in a browser.
- Changes sync between devices automatically; the other device updates within a second or two of a save.
- Works fully offline on desktop; catches up on reconnect.
- Never lose text: concurrent edits produce a conflict copy instead of overwriting.
- Private by default: reachable only over your tailnet with real HTTPS.
- Easy to run: `docker compose up`, one data file to back up.

**Non-goals for v1** (planned later, see §10)
- Live as-you-type collaboration (Google Docs style)
- End-to-end encryption
- Sharing entries with other people / multiple accounts
- Mobile app
- Postgres, Redis, multiple server instances

---

## 2. Architecture

```
┌─ Desktop app (Wails, native install) ─┐            ┌─ docker compose ─────────────────────────┐
│ React + TipTap UI                     │   HTTPS    │ tailscale ──► diary (Go, single process) │
│   ↕ generated TS bindings             ├──tailnet──►│ (TLS +        · REST API  /v1/...        │
│ Go: SQLite · outbox · sync loop       │            │  identity)    · SSE       /v1/events     │
└───────────────────────────────────────┘            │               · Web UI    (go:embed)     │
┌─ Browser ─────────────────────────────┐            │               · SQLite on a volume       │
│ Same React app, HTTP adapter          ├──tailnet──►│                                          │
└───────────────────────────────────────┘            └──────────────────────────────────────────┘
```

**How a save travels**
1. Desktop: UI calls `SaveEntry()` → Go writes the entry plus an outbox row to local SQLite in one transaction.
2. Sync loop sends `PUT /v1/entries/:id` with `base_version` and an `Idempotency-Key`.
3. Server checks the version, bumps it, stamps a new `server_seq`, commits.
4. Server's in-memory notifier pushes `changed {cursor}` over SSE to your other open clients.
5. Those clients call `GET /v1/sync?since=<cursor>` and apply the delta.

The live channel only carries "something changed". The data always comes from `/v1/sync`, so a missed notice costs nothing.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Server | Go 1.23+, `net/http` (stdlib router) | Single binary, stateless handlers |
| Server DB | SQLite (WAL) via `modernc.org/sqlite` | Pure Go, no cgo |
| SQL / migrations | `sqlc` + `goose` | Portable SQL so Postgres can be added later |
| Desktop shell | Wails v2 | Go backend + system WebView2 |
| Desktop DB | SQLite (same driver) | Local store, outbox, sync cursor |
| UI | Vite + React + TypeScript | One codebase, two build targets |
| Editor | TipTap | Body stored as ProseMirror JSON (converts cleanly to Yjs later) |
| UI data | TanStack Query (web) | Desktop reads through Wails bindings |
| Styling | Tailwind | |
| HTTPS | Tailscale sidecar (`tailscale serve`) | Alternative modes in §7 |
| Search | SQLite FTS5 | Inside the `Store` adapter |

---

## 4. Repo layout

```
diary/
├── go.work
├── shared/                  # Go module used by server AND desktop
│   ├── model/               # Entry, Change, SyncResponse
│   ├── syncproto/           # request/response types, error codes
│   └── conflict/            # conflict-copy rules
├── server/
│   ├── cmd/diary/main.go    # config → pick adapters → start
│   ├── internal/core/       # use cases + ports (interfaces)
│   ├── internal/adapters/
│   │   ├── sqlitestore/
│   │   ├── memnotifier/
│   │   └── auth/            # tailscale identity, password
│   ├── internal/httpapi/    # handlers, SSE, middleware
│   ├── internal/webui/dist/ # embedded UI build output (go:embed)
│   ├── migrations/
│   └── Dockerfile
├── desktop/                 # Wails app (Go side: localdb, outbox, syncclient)
├── ui/                      # React app
│   └── src/platform/        # types.ts, wails.ts, http.ts
├── deploy/
│   ├── docker-compose.yml
│   ├── tailscale/serve.json
│   └── Caddyfile            # optional modes
└── PLAN.md
```

---

## 5. Data model

### Server (SQLite)

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- uuid
  login       TEXT NOT NULL UNIQUE,      -- tailscale login or "owner"
  created_at  TEXT NOT NULL
);

CREATE TABLE entries (
  id          TEXT PRIMARY KEY,          -- uuid, generated on the client
  user_id     TEXT NOT NULL REFERENCES users(id),
  entry_date  TEXT,                      -- 'YYYY-MM-DD' for daily entries, NULL for free notes
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',  -- ProseMirror JSON
  body_text   TEXT NOT NULL DEFAULT '',  -- plain text for search
  version     INTEGER NOT NULL,          -- bumped on every write
  server_seq  INTEGER NOT NULL,          -- per-user change-log position
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                       -- tombstone
);
CREATE INDEX entries_sync ON entries(user_id, server_seq);
CREATE INDEX entries_date ON entries(user_id, entry_date);

CREATE TABLE seq_counters (               -- source of server_seq
  user_id   TEXT PRIMARY KEY,
  last_seq  INTEGER NOT NULL
);

CREATE TABLE idempotency (
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  response    BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE VIRTUAL TABLE entries_fts USING fts5(title, body_text, content='entries', content_rowid='rowid');
```

### Desktop (local SQLite)

```sql
-- entries: same columns as the server, plus:
--   dirty INTEGER NOT NULL DEFAULT 0
CREATE TABLE outbox (                   -- one pending change per entry (coalesced)
  entry_id      TEXT PRIMARY KEY,
  op            TEXT NOT NULL,           -- 'put' | 'delete'
  payload       TEXT NOT NULL,
  base_version  INTEGER NOT NULL,        -- server version the edits started from
  rev           INTEGER NOT NULL,        -- bumped on every local edit
  idem_key      TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_try_at   TEXT,
  last_error    TEXT
);
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- 'cursor', 'server_url'
```

---

## 6. API (v1)

| Method & path | Purpose |
|---|---|
| `GET /v1/health` | Liveness |
| `GET /v1/me` | Current user (from Tailscale identity or session) |
| `POST /v1/auth/login` | Password mode only |
| `GET /v1/sync?since=<cursor>&limit=500` | `{changes:[...], cursor, has_more}` including tombstones |
| `PUT /v1/entries/{id}` | Create or update. Body has `base_version` (0 for new). Header `Idempotency-Key`. `200` with entry, or `409` with `{server: entry}` |
| `DELETE /v1/entries/{id}?base_version=n` | Sets `deleted_at` (tombstone) |
| `GET /v1/entries?from=&to=` | Calendar / list view for web |
| `GET /v1/search?q=` | FTS5 search |
| `GET /v1/events` | SSE stream: `event: changed` / `data: {"cursor":1843}` |
| `GET /*` | Embedded web UI |

**Conflict rule:** if `base_version` ≠ server version → `409`. The client keeps the server version and saves its own edit as a new entry titled `"<title> (conflict copy)"`. Nothing is ever overwritten silently.

---

## 7. Connection (HTTPS) modes

Selected with `TLS_MODE` in `.env`; each mode is a compose profile. The Go server always listens on plain HTTP inside the compose network.

| Mode | Reach | Setup |
|---|---|---|
| `tailscale` (default) | Your tailnet only, real cert at `diary.<tailnet>.ts.net` | `TS_AUTHKEY` once; Tailscale on each device |
| `off` | This machine only | Binds `127.0.0.1` only; refuses other addresses |
| `acme` | Public internet | Caddy + domain (later) |
| `internal` | LAN | Caddy internal CA (later) |

**Auth modes** (`AUTH_MODE`):
- `tailscale`: trust `Tailscale-User-Login` header **only** from the sidecar; map to the owner user.
- `password`: one owner password (argon2id hash in env), signed HttpOnly cookie.

---

## 8. Interfaces that keep it open to scale

```go
type Store interface {
    GetEntry(ctx, userID, id string) (Entry, error)
    PutEntry(ctx, userID string, e Entry, baseVersion int, idemKey string) (Entry, error) // ErrConflict
    DeleteEntry(ctx, userID, id string, baseVersion int) error
    ChangesSince(ctx, userID string, cursor int64, limit int) ([]Entry, int64, bool, error)
    ListByDate(ctx, userID, from, to string) ([]Entry, error)
    Search(ctx, userID, q string) ([]Entry, error)
}
type Notifier interface {
    Publish(ctx, userID string, cursor int64) error
    Subscribe(ctx, userID string) (<-chan int64, func())
}
type Authenticator interface {
    Identify(r *http.Request) (userID string, err error)
}
```

| Port | v1 adapter | Later |
|---|---|---|
| `Store` | `sqlitestore` | `pgstore` |
| `Notifier` | `memnotifier` | `redisnotifier` (becomes `Relay` for live typing) |
| `Authenticator` | tailscale / password | multi-user sessions in Redis |
| `Blobs` (attachments) | not in v1 | local disk → S3/MinIO |

A shared **contract test suite** runs against every `Store` adapter, covering version checks, cursors, tombstones and idempotency.

**Decided now because they are hard to change later**
- `user_id` on every row, even with one user.
- Client-generated UUIDs.
- Server-assigned `server_seq` cursor; never order by timestamps.
- Tombstones instead of hard deletes.
- Idempotency keys on every write.
- Versioned API (`/v1`).
- Body stored as ProseMirror JSON, which converts mechanically to Yjs when live typing arrives.
- No global state in handlers.

---

## 9. Milestones

### M0 · Repo and tooling
- [ ] `go.work` with `shared`, `server`, `desktop` modules
- [ ] Makefile: `make dev`, `make test`, `make build`, `make up`
- [ ] `sqlc` + `goose` setup, `golangci-lint`

### M1 · Server core
- [ ] Config loading (env) and adapter wiring in `main.go`
- [ ] Migrations for §5
- [ ] `sqlitestore`: put/get/delete with version check, `server_seq`, tombstones, idempotency
- [ ] `/v1/sync`, `/v1/entries`, `/v1/search`, `/v1/health`
- [ ] Store contract tests

### M2 · Live notices, auth, Docker
- [ ] `memnotifier` + `/v1/events` SSE with heartbeat
- [ ] Auth: tailscale header mode, password mode
- [ ] Multi-stage Dockerfile (UI build → Go build → distroless)
- [ ] `docker-compose.yml` with `tailscale` and `off` profiles, data volume

### M3 · Web UI
- [ ] Vite + React + TS + Tailwind scaffold
- [ ] `NoteStore` interface + `http.ts` adapter
- [ ] TipTap editor with autosave (debounced)
- [ ] Today view, calendar/list, search
- [ ] Conflict-copy banner
- [ ] Embed build into the server with `go:embed`

### M4 · Desktop app
- [ ] Wails project wired to `ui/` with `VITE_TARGET=desktop`
- [ ] Local SQLite, outbox, sync loop with backoff
- [ ] SSE listener → pull → emit `entries:changed` to UI
- [ ] First-run screen: server URL + sign-in
- [ ] Windows build (`.exe` installer)

### M5 · Hardening
- [ ] Nightly SQLite backup (`VACUUM INTO`), optional Litestream
- [ ] Export all entries to Markdown
- [ ] CSP headers, render-time sanitization of entry content
- [ ] Login rate limiting (password mode)
- [ ] Structured logging, `/v1/health` used by compose healthcheck

---

## 10. Later (designed for, not built)

| Stage | Feature | What changes |
|---|---|---|
| L1 | **Live as-you-type sync (Google Docs style)** | Bodies move to Yjs documents; TipTap Collaboration extension; WebSocket room per open entry; Go relays opaque Yjs updates and stores an update log + snapshots. One-time conversion of existing ProseMirror JSON to Yjs. Conflict copies are no longer needed. |
| L2 | End-to-end encryption | Clients encrypt bodies/updates with a passphrase-derived key; server stores ciphertext; search moves to the client. Fits naturally with the L1 relay. |
| L3 | Sharing | `doc_members(doc_id, user_id, role)`, accounts, share links, presence/cursors. |
| L4 | Scale | `DB=postgres`, Redis for rooms/sessions/cache, Caddy load balancing, multiple server instances, S3 for attachments. |

---

## 11. Open decisions

| Decision | Recommended default | Status |
|---|---|---|
| End-to-end encryption timing | Later (L2), but before storing years of entries | Open |
| Sharing ever needed? | Assume yes; keep `user_id` everywhere, add `doc_members` in L3 | Open |
| Attachments / images in v1 | No; text only | Open |
| Mobile | Web UI on phone over Tailscale until a real need appears | Open |

---

## 12. Reference

- [BACKEND.md](BACKEND.md): Go server in depth (storage, sync rules, SSE, auth, Docker, backups, tests)
- [FRONTEND.md](FRONTEND.md): React UI, web client, desktop sync engine, editor, conflicts, builds
- Interactive architecture map: https://claude.ai/artifact/8rVUDLeVyb4SAZyGLKfWgD _(shows the earlier larger design with Postgres, Redis and two API instances; that is now stage L4)_
