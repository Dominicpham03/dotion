import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Field, PageTitle, inputClass } from "@/components/ui";
import { relativeTime } from "@/lib/dates";
import { getEditorSize, getPalette, getTheme, setEditorSize, setPalette, setTheme, type EditorSize, type Palette, type ThemeChoice } from "@/lib/theme";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { store } from "@platform";
import { useCalendarStatus, useConnectCalendar } from "@/features/calendar/useCalendar";
import { AiSection, NotificationsSection } from "./AiSettings";

export function SettingsPage() {
  return (
    <div className="flex max-w-xl flex-col gap-8">
      <PageTitle>Settings</PageTitle>
      <Appearance />
      <AiSection />
      <CalendarSection />
      {store.notifications && <NotificationsSection />}
      <GitLabSection />
      {store.app && <AppSync />}
      {store.web && <WebAccount />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{name}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([v, label]) => (
          <label key={v} className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${value === v ? "border-accent bg-accent-soft text-accent" : "border-line"}`}>
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="sr-only" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Appearance() {
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [size, setSize] = useState<EditorSize>(getEditorSize());
  const [palette, setPaletteState] = useState<Palette>(getPalette());
  return (
    <Section title="Appearance">
      <Choice
        name="Colorway"
        value={palette}
        options={[["navy", "Navy"], ["plum", "Plum"]]}
        onChange={(v) => {
          setPaletteState(v);
          setPalette(v);
        }}
      />
      <Choice
        name="Theme"
        value={theme}
        options={[["system", "Match system"], ["light", "Light"], ["dark", "Dark"]]}
        onChange={(v) => {
          setThemeState(v);
          setTheme(v);
        }}
      />
      <Choice
        name="Editor text size"
        value={size}
        options={[["small", "Small"], ["medium", "Medium"], ["large", "Large"]]}
        onChange={(v) => {
          setSize(v);
          setEditorSize(v);
        }}
      />
      <p className="text-xs text-muted">Ctrl+Shift+L switches between light and dark.</p>
    </Section>
  );
}

function AppSync() {
  const appApi = store.app!;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useSyncStatus();
  const { data: s, refetch } = useQuery({ queryKey: ["settings"], queryFn: appApi.getSettings, refetchInterval: 5000 });
  const [confirm, setConfirm] = useState(false);

  if (!s) return null;
  const rows: [string, string][] = [
    ["Server", s.serverUrl || "Not connected"],
    ["Signed in as", s.login || "—"],
    ["Last sync", s.lastSyncAt ? relativeTime(s.lastSyncAt) : "Never"],
    ["Waiting to sync", String(s.pending)],
    ["Data on this device", s.dataPath],
  ];
  return (
    <Section title="Sync">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="break-words tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {status.state === "error" && <p className="text-sm text-danger">{status.message}</p>}
      <div className="flex flex-wrap gap-2">
        {s.serverUrl ? (
          <>
            <Button
              variant="primary"
              onClick={async () => {
                await appApi.syncNow();
                setTimeout(() => void refetch(), 800);
              }}
            >
              Sync now
            </Button>
            {status.state === "error" && <Button onClick={() => navigate("/welcome")}>Sign in again</Button>}
            {confirm ? (
              <>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await appApi.disconnect();
                    setConfirm(false);
                    void qc.invalidateQueries({ queryKey: ["settings"] });
                  }}
                >
                  Disconnect
                </Button>
                <Button onClick={() => setConfirm(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirm(true)}>
                Disconnect…
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" onClick={() => navigate("/welcome")}>
            Connect to a server
          </Button>
        )}
      </div>
      {confirm && <p className="text-xs text-muted">Disconnecting stops syncing. Your entries stay on this device.</p>}
    </Section>
  );
}

function WebAccount() {
  const web = store.web!;
  const navigate = useNavigate();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: web.me });
  return (
    <Section title="Account">
      <p className="text-sm">
        Signed in as <span className="font-medium">{me?.login ?? "…"}</span>
        {me?.authMode === "tailscale" && <span className="text-muted"> through Tailscale</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={web.exportUrl} className="inline-flex h-9 items-center rounded-md bg-accent-strong px-3 text-sm font-medium text-on-accent hover:bg-accent-strong/90">
          Export all entries (Markdown .zip)
        </a>
        {me?.authMode === "password" && (
          <Button
            onClick={async () => {
              await web.logout();
              navigate("/login");
            }}
          >
            Sign out
          </Button>
        )}
      </div>
    </Section>
  );
}

function CalendarSection() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { data: st, isPending } = useCalendarStatus();
  const { connect, waiting, error } = useConnectCalendar();
  const [busy, setBusy] = useState(false);
  const result = params.get("google");

  return (
    <section id="calendar" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Google Calendar &amp; Drive</h2>
      {result === "connected" && <p className="text-sm text-accent">Google is connected.</p>}
      {result === "cancelled" && <p className="text-sm text-muted">Google wasn't connected.</p>}
      {isPending ? (
        <p className="text-sm text-muted">Checking…</p>
      ) : !st || st.offline ? (
        <p className="text-sm text-muted">Connect this app to your Dotion server to use Google Calendar and Drive.</p>
      ) : st.connected ? (
        <>
          <p className="text-sm">
            Connected as <span className="font-medium">{st.email || "your Google account"}</span>. Calendar events show on each day and in the calendar
            {st.drive ? "; Drive files show in Search and under + Insert → Google Drive file" : ""}
            {st.calendarWrite ? ". Your action items are added to your calendar as all-day events." : "."}
          </p>
          {(!st.drive || !st.calendarWrite) && (
            <div className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
              <p>
                This connection was made before {!st.drive ? "Drive support" : "action items"}. Reconnect once so Dotion can
                {!st.drive ? " read your Drive and" : ""} add your action items to your calendar.
              </p>
              <Button variant="primary" className="self-start" disabled={waiting} onClick={() => void connect()}>
                {waiting ? "Waiting for Google… finish in your browser" : "Reconnect Google"}
              </Button>
            </div>
          )}
          <Button
            className="self-start"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await store.calendar.disconnect();
                await qc.invalidateQueries({ queryKey: ["calendar-status"] });
                await qc.invalidateQueries({ queryKey: ["events"] });
              } finally {
                setBusy(false);
              }
            }}
          >
            Disconnect
          </Button>
        </>
      ) : st.configured ? (
        <>
          <p className="text-sm">Show your Google Calendar events next to your entries, and search and import from Google Drive. Dotion reads your calendar and Drive, and adds events only for your action items; it never changes or deletes anything else.</p>
          <Button variant="primary" className="self-start" disabled={waiting} onClick={() => void connect()}>
            {waiting ? "Waiting for Google… finish in your browser" : "Connect Google"}
          </Button>
          {error && <p className="text-sm text-danger">{error}</p>}
        </>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p>To show Google Calendar events, the Dotion server needs its own Google sign-in client. One-time setup:</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>Open Google Cloud Console, create a project, and enable the <span className="text-ink">Google Calendar API</span> and <span className="text-ink">Google Drive API</span>.</li>
            <li>Under APIs &amp; Services → OAuth consent screen, choose External, add yourself as a test user.</li>
            <li>
              Under Credentials, create an <span className="text-ink">OAuth client ID</span> of type Web application, with this authorized redirect URI:
              <code className="mt-1 block break-all rounded bg-paper px-2 py-1 text-ink">{st.redirectUri}</code>
            </li>
            <li>
              Put the client ID and secret in <code className="text-ink">deploy/.env</code> as <code className="text-ink">DIARY_GOOGLE_CLIENT_ID</code> and{" "}
              <code className="text-ink">DIARY_GOOGLE_CLIENT_SECRET</code>, then restart the server.
            </li>
          </ol>
        </div>
      )}
    </section>
  );
}

function GitLabSection() {
  const qc = useQueryClient();
  const { data: st, isPending } = useQuery({ queryKey: ["gitlab-status"], queryFn: () => store.gitlab.status(), retry: false });
  const [url, setUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const run = async (kind: "connect" | "sync" | "disconnect", fn: () => Promise<string>) => {
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      setMessage(await fn());
      await qc.invalidateQueries({ queryKey: ["gitlab-status"] });
      await qc.invalidateQueries({ queryKey: ["pages"] });
      await qc.invalidateQueries({ queryKey: ["children"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="gitlab" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">GitLab</h2>
      {isPending ? (
        <p className="text-sm text-muted">Checking…</p>
      ) : st?.offline ? (
        <p className="text-sm text-muted">Connect this app to your Dotion server to use GitLab.</p>
      ) : st?.connected ? (
        <>
          <p className="text-sm">
            Connected to <span className="font-medium">{st.url}</span> as <span className="font-medium">@{st.username}</span>. Issues and merge
            requests assigned to you live in the{" "}
            <Link to={`/entry/${st.databaseId}`} className="text-accent underline underline-offset-2">
              GitLab database
            </Link>
            . Set an issue to Done to close it in GitLab, or back to Open to reopen it. Syncs every 5 minutes.
          </p>
          <p className="text-xs text-muted">{st.lastSync ? `Last synced ${relativeTime(st.lastSync)}.` : "Not synced yet."}</p>
          {st.lastError && <p className="text-sm text-danger">{st.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() =>
                void run("sync", async () => {
                  const r = await store.gitlab.sync();
                  return `Synced: ${r.created} new, ${r.updated} updated, ${r.pushed} sent to GitLab.`;
                })
              }
            >
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() =>
                void run("disconnect", async () => {
                  await store.gitlab.disconnect();
                  return "GitLab disconnected. The GitLab database stays as it is.";
                })
              }
            >
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run("connect", async () => {
              const s = await store.gitlab.connect(url.trim(), token.trim());
              setToken("");
              return `Connected as @${s.username}. Your issues are in the GitLab database.`;
            });
          }}
        >
          <p className="text-sm">Bring the issues and merge requests assigned to you into a Dotion database, and close issues from Dotion.</p>
          <Field label="GitLab address" htmlFor="gitlab-url" hint="gitlab.com, or your company's GitLab.">
            <input id="gitlab-url" value={url} onChange={(e) => setUrl(e.target.value)} className={inputClass} />
          </Field>
          <Field
            label="Personal access token"
            htmlFor="gitlab-token"
            hint="In GitLab: your avatar → Edit profile → Access tokens → Add new token, with the “api” scope. It's kept on your Dotion server."
          >
            <input
              id="gitlab-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="glpat-…"
              className={inputClass}
            />
          </Field>
          <Button type="submit" variant="primary" className="self-start" disabled={busy !== null || !token.trim()}>
            {busy === "connect" ? "Connecting and syncing…" : "Connect GitLab"}
          </Button>
        </form>
      )}
      {message && <p className="text-sm text-accent">{message}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}
