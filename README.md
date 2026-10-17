# Dotion

Dotion is a self-hosted notes app and diary, in the spirit of Notion. You run one small server on your own machine, and your notes sync to the web app, a Windows desktop app and an Android app. Both apps keep working offline.

- **Daily entries** on a Today page and a calendar, plus free-standing **pages** nested as deep as you like.
- **Rich pages:** headings, checklists, code blocks with syntax highlighting, tables, images and link cards.
- **Links between pages:** type `[[` to link a page. Every page lists the pages that link to it.
- **Databases:** records with typed properties (status, dates, tags, relations), shown as tables, boards or calendars. You can also show a live view of a database inside any page.
- **Integrations (optional):**
  - **Google Calendar and Drive:** your events show next to your notes, and you can import a Google Doc as a page.
  - **GitLab:** the issues assigned to you sync both ways.
  - **Gemini:** an assistant that answers questions about your notes and turns tasks in meeting notes into action items on your calendar.
- **Android reminders** for due dates, calendar events and a daily nudge to write.
- **Your data stays yours:** one SQLite file on your server, with nightly backups and a one-click export to Markdown.

## How it fits together

```
 Web browser ─┐
 Desktop app ─┼──►  Dotion server (Docker)  ──►  diary.db (SQLite) + nightly backups
 Android app ─┘          │
                         └──► Google, GitLab, Gemini (only if you connect them)
```

The server holds your notes and every connection to an outside service. You connect Google, GitLab or Gemini once, on the server, and every device can use it. The desktop and Android apps keep a full copy of your notes, so they work offline and sync whenever they can reach the server.

There are two ways to run the server:

| Mode | Reachable from | Sign-in | Use it when |
|---|---|---|---|
| **Tailscale** (recommended) | Your devices on your [Tailscale](https://tailscale.com) network, over HTTPS | Your Tailscale identity, no password | You want your phone and other computers to sync |
| **Local** | This computer only (`http://localhost:8080`) | A password | You're trying Dotion out, or only use one computer |

## Requirements

- [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows or macOS) to run the server.
- [Git](https://git-scm.com/) to download the code.
- For the Tailscale mode: a free [Tailscale](https://tailscale.com) account, with Tailscale installed on each device you'll use.
- To build the apps yourself (optional):
  - Desktop: Go 1.26+, Node 22+ and the [Wails CLI](https://wails.io).
  - Android: Node 22+, JDK 17 and the Android SDK (Android Studio installs the SDK).

## 1. Download

```sh
git clone https://github.com/Dominicpham03/dotion.git
cd dotion
cp deploy/.env.example deploy/.env      # Windows: copy deploy\.env.example deploy\.env
```

All settings live in `deploy/.env`. It is listed in `.gitignore`, so your keys never end up in Git.

## 2. Start the server

### Option A: Local, this computer only

1. **Make a password hash.** The command asks for a password and prints a hash:

   ```sh
   docker compose -f deploy/docker-compose.yml run --rm diary-local hash-password
   ```

2. **Make a token secret** (32 random bytes):

   ```sh
   openssl rand -base64 32
   ```

   On Windows PowerShell:

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
   ```

3. **Edit `deploy/.env`:**

   ```ini
   TLS_MODE=off
   DIARY_PASSWORD_HASH=<the hash from step 1>
   DIARY_TOKEN_SECRET=<the secret from step 2>
   ```

   If the hash contains `$` characters, wrap it in single quotes: `DIARY_PASSWORD_HASH='$argon2id$...'`.

4. **Start it:**

   ```sh
   docker compose -f deploy/docker-compose.yml --profile off up -d --build
   ```

5. Open **http://localhost:8080** and sign in with your password.

### Option B: Tailscale, on all your devices

1. In the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys), create an **auth key** (Settings → Keys → Generate auth key).
2. **Edit `deploy/.env`:**

   ```ini
   TLS_MODE=tailscale
   TS_AUTHKEY=tskey-auth-...
   DIARY_OWNER_LOGIN=you@github        # your Tailscale login name, exactly as the admin console shows it
   ```

3. **Start it:**

   ```sh
   docker compose -f deploy/docker-compose.yml --profile tailscale up -d --build
   ```

4. On any device signed in to your tailnet, open **`https://dotion.<your-tailnet>.ts.net`**. Your tailnet name is shown in the Tailscale admin console under DNS. There's no password; your Tailscale login signs you in, and only the owner login can open the diary.

If you have `make`, `make up`, `make down` and `make logs` do the same things using `TLS_MODE` from `deploy/.env`.

**Your data** lives in the `diary-data` Docker volume: `diary.db`, plus nightly copies in `backups/` (the last 14 are kept). **Settings → Export** downloads everything as Markdown files, with images and each database as a folder.

## 3. Install the apps (optional)

The web app needs nothing more. The apps add offline use and notifications.

### Windows desktop app

```sh
cd desktop
wails build -nsis          # the installer appears in desktop/build/bin
```

On first launch, enter your server address (`https://dotion.<your-tailnet>.ts.net`, or `http://localhost:8080`), or choose **Use offline for now**. Notes are stored in `%APPDATA%\Dotion\dotion.db`.

### Android app

```sh
cd ui && npm install && npm run build:mobile
cd ../mobile && npm install && npx cap sync android
cd android && ./gradlew assembleDebug        # Windows: gradlew assembleDebug
```

1. The APK is written to `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
2. To install it, either:
   - copy it to your phone and open it, allowing "Install unknown apps" for your file manager when asked; or
   - turn on USB debugging and run `adb install app-debug.apk`.
3. Install the Tailscale app on the phone and sign in.
4. Open Dotion and enter `https://dotion.<your-tailnet>.ts.net`.

**Reminders:** open **Settings → Notifications → Allow notifications**. You can then choose:

- reminders for due dates (action items, GitLab issues, any database record with a due date), at a time you pick;
- a reminder 10 minutes before each calendar event;
- a daily reminder to write.

Reminders are planned on the phone from your synced notes, so they work offline.

## 4. Connect other services (optional)

Each of these is set up once on the server, then works on every device. After changing `deploy/.env`, restart the server by running the same `up -d` command from step 2.

### Google Calendar and Drive

Shows your calendar events on each day, lets you search Google Drive and import a Google Doc as a page, and adds your [action items](#gemini) to your calendar.

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Calendar API** and the **Google Drive API**.
2. Under **APIs & Services → OAuth consent screen**, choose **External** and add yourself as a test user.
3. Under **Credentials**, create an **OAuth client ID** of type **Web application**. Add the redirect URI that Dotion shows under **Settings → Google Calendar & Drive**: `https://dotion.<your-tailnet>.ts.net/v1/integrations/google/callback`, or `http://localhost:8080/v1/integrations/google/callback` in Local mode.
4. **Edit `deploy/.env`:**

   ```ini
   DIARY_GOOGLE_CLIENT_ID=...
   DIARY_GOOGLE_CLIENT_SECRET=...
   DIARY_PUBLIC_URL=https://dotion.<your-tailnet>.ts.net
   ```

5. Restart the server, then choose **Settings → Google Calendar & Drive → Connect Google**.

While the consent screen is in *Testing*, Google ends the connection after 7 days. For a lasting connection, set it to *In production*. Google then shows an "unverified app" warning when you sign in; for your own app, choose **Advanced → Go to (your app)**.

### GitLab

The issues and merge requests assigned to you appear in a **GitLab** database, synced every 5 minutes. Setting an issue to **Done** in Dotion closes it in GitLab, and **Open** reopens it.

1. In GitLab, go to your avatar → **Edit profile → Access tokens** and create a token with the **api** scope.
2. In Dotion, open **Settings → GitLab** and enter your GitLab address (gitlab.com, or your own) and the token.

### Gemini

With a Gemini API key, Dotion adds two features:

- **Ask Gemini**: open it from the sidebar or with Ctrl+J.
  - Ask about anything you wrote. Gemini searches your notes, databases, Calendar and Drive, and links the pages it used.
  - It can draft a page for you to create. It never edits or deletes anything.
- **Action items**:
  - Gemini reads your meeting notes and journal entries for tasks that are **yours** and **have a due date**, such as "Sam to send the budget by Friday" or "I'll book the venue next week".
  - Each task becomes a record in an **Action items** database (To do / Done, due date, a link back to the note) and an all-day event on your Google Calendar.
  - Notes are read once you've stopped editing them; the server checks every 15 minutes. To read a page right away, use **⋯ → Find my action items** on it.

Setup:

1. In [Google AI Studio](https://aistudio.google.com), choose **Get API key → Create API key**.
2. **Edit `deploy/.env`:**

   ```ini
   DIARY_GEMINI_API_KEY=...
   # DIARY_GEMINI_MODEL=gemini-3.8-flash      (the default)
   ```

3. Restart the server.
4. In **Settings → Gemini**, add the names you go by in notes (for example "Sam, SK"), so Gemini knows which tasks are yours.
5. If you connected Google before setting this up, choose **Reconnect Google** once, so Dotion may add events to your calendar.

**Privacy:** the notes Gemini reads are sent to Google to answer. On Gemini's free tier, Google may use them to improve its products. Turning on billing for the key's Google Cloud project stops that. You can turn off automatic scanning in **Settings → Gemini**.

## Configuration reference

All of these go in `deploy/.env`.

| Variable | Needed for | Meaning |
|---|---|---|
| `TLS_MODE` | always | `tailscale` or `off` (Local mode) |
| `TS_AUTHKEY` | Tailscale mode | Tailscale auth key for the server |
| `DIARY_OWNER_LOGIN` | Tailscale mode | The Tailscale login allowed to open the diary |
| `DIARY_PASSWORD_HASH` | Local mode | Output of `hash-password` |
| `DIARY_TOKEN_SECRET` | Local mode | Base64 of 32+ random bytes, used to sign sign-in tokens |
| `DIARY_PUBLIC_URL` | Google | The address you open Dotion at; used to build the Google redirect URI |
| `DIARY_GOOGLE_CLIENT_ID`, `DIARY_GOOGLE_CLIENT_SECRET` | Google | The OAuth client from Google Cloud Console |
| `DIARY_GEMINI_API_KEY` | Gemini | Key from Google AI Studio |
| `DIARY_GEMINI_MODEL` | — | Gemini model (default `gemini-3.8-flash`) |
| `DIARY_BACKUP_KEEP` | — | Nightly backups to keep (default 14) |
| `DIARY_LOG_LEVEL` | — | `debug`, `info` (default), `warn` or `error` |

## Updating

```sh
git pull
docker compose -f deploy/docker-compose.yml --profile <tailscale|off> up -d --build
```

Database changes are applied automatically when the server starts. Rebuild the desktop and Android apps the same way you built them.

## Troubleshooting

- **The server won't start:** run `docker compose -f deploy/docker-compose.yml --profile <mode> logs`. The first lines name any missing or invalid setting.
- **"This account can't open this diary"** (Tailscale mode): `DIARY_OWNER_LOGIN` doesn't match your Tailscale login exactly.
- **The phone can't reach the server:** check that Tailscale is connected on the phone, and that the address starts with `https://`.
- **Google says "redirect_uri_mismatch":** the redirect URI in Google Cloud Console must match the one shown in **Settings → Google Calendar & Drive** exactly.
- **Gemini doesn't show up:** `DIARY_GEMINI_API_KEY` isn't set, or the server wasn't restarted. On the apps, the assistant also needs a connection to the server.

## Development

| Task | Command |
|---|---|
| Server on 127.0.0.1:8080 | `make dev` (or `cd server`, set `DIARY_DATA_DIR=../.data` and `DIARY_OWNER_LOGIN=dev@local`, then `go run ./cmd/diary`) |
| Web UI with hot reload | `cd ui && npm install && npm run dev:web` (proxies `/v1` to the server) |
| Desktop with hot reload | `cd desktop && wails dev` |
| All tests | `go test ./shared/... ./server/... ./desktop/...` and `cd ui && npm test` |
| Type-check all UI builds | `cd ui && npm run lint` |
| Regenerate SQL code | `cd server && sqlc generate` |
| Regenerate the app icons | `python mobile/icon/make_icons.py` (needs Pillow) |

A dev server in Tailscale mode expects a `Tailscale-User-Login` header. From a plain browser, use password mode or the desktop app instead.

The design notes are in [PLAN.md](PLAN.md), [BACKEND.md](BACKEND.md) and [FRONTEND.md](FRONTEND.md). They were written when the project was called "Diary", so the server binary, Docker services and environment variables still use `diary`.

```
shared/    types shared by the server and the desktop app (entries, sync protocol, text extraction)
server/    Go server: rules, SQLite store, HTTP API, live updates, sign-in, backups, integrations
desktop/   Windows app (Wails): local SQLite copy and sync engine
mobile/    Android app (Capacitor) around the same UI
ui/        React app, built for the web, desktop and Android
deploy/    Docker Compose and Tailscale configuration
```
