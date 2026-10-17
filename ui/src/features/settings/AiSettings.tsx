import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, inputClass } from "@/components/ui";
import { useAiStatus } from "@/features/ai/AskPanel";
import { openAsk } from "@/features/ai/askBus";
import { relativeTime } from "@/lib/dates";
import { store } from "@platform";
import type { NotificationPermission, ReminderSettings } from "@/platform/types";

function Card({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function GeminiSection() {
  const qc = useQueryClient();
  const { data: ai, isPending } = useAiStatus();
  const actions = useQuery({ queryKey: ["ai-actions"], queryFn: () => store.ai.actionsStatus(), enabled: !!ai?.enabled, retry: false });
  const [names, setNames] = useState("");
  const [busy, setBusy] = useState<"save" | "scan" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (actions.data) setNames(actions.data.names.join(", "));
  }, [actions.data]);

  const run = async (kind: "save" | "scan", fn: () => Promise<string>) => {
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      setMessage(await fn());
      await qc.invalidateQueries({ queryKey: ["ai-actions"] });
      await qc.invalidateQueries({ queryKey: ["pages"] });
      await qc.invalidateQueries({ queryKey: ["children"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = (enabled: boolean) =>
    run("save", async () => {
      await store.ai.configureActions(enabled, names.split(",").map((n) => n.trim()).filter(Boolean));
      return "Saved.";
    });

  if (isPending) {
    return (
      <Card id="gemini" title="Gemini">
        <p className="text-sm text-muted">Checking…</p>
      </Card>
    );
  }
  if (!ai?.enabled) {
    return (
      <Card id="gemini" title="Gemini">
        <div className="flex flex-col gap-2 text-sm">
          <p>Ask questions about your notes and get your action items on your calendar, with Google's Gemini. One-time setup on the server:</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>
              In Google AI Studio (aistudio.google.com), choose <span className="text-ink">Get API key → Create API key</span>. Turn on billing for the key's
              project if you can: on the free tier Google may use what you send to improve its products.
            </li>
            <li>
              Put it in <code className="text-ink">deploy/.env</code> as <code className="text-ink">DIARY_GEMINI_API_KEY</code> and restart the server.
            </li>
          </ol>
          {store.platform !== "web" && <p className="text-xs text-muted">Already set up? This app may just be offline from the server.</p>}
        </div>
      </Card>
    );
  }
  const st = actions.data;
  return (
    <Card id="gemini" title="Gemini">
      <p className="text-sm">
        Gemini ({ai.model}) answers questions about your notes. Open it from the sidebar or with <kbd className="font-sans">Ctrl+J</kbd>. Pages it reads are sent to
        Google to answer; it never changes your notes.
      </p>
      <Button variant="outline" className="self-start" onClick={() => openAsk()}>
        Ask Gemini
      </Button>

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">Action items</h3>
        {!st ? (
          <p className="text-sm text-muted">{actions.isError ? "Couldn't load the settings." : "Checking…"}</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Gemini reads your meeting notes and journal entries for tasks that are yours and have a due date, and files each in the{" "}
              <Link to={`/entry/${st.databaseId}`} className="text-accent underline underline-offset-2">
                Action items
              </Link>{" "}
              database{st.calendarWrite ? " and your Google Calendar" : ""}.
              {st.calendarConnected && !st.calendarWrite && (
                <>
                  {" "}
                  To add them to Google Calendar too,{" "}
                  <a href="#calendar" className="text-accent underline underline-offset-2">
                    reconnect Google
                  </a>
                  .
                </>
              )}
            </p>
            <Toggle
              checked={st.enabled}
              onChange={(v) => void save(v)}
              label="Scan new and edited notes automatically"
              hint="Every 15 minutes, notes you stopped editing are read once. Or use Find my action items in a page's ⋯ menu."
            />
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void save(st.enabled);
              }}
            >
              <label htmlFor="ai-names" className="text-sm font-medium">
                Names you go by in notes
              </label>
              <div className="flex gap-2">
                <input id="ai-names" value={names} onChange={(e) => setNames(e.target.value)} placeholder="Sam, Samantha, SK" className={inputClass} />
                <Button type="submit" variant="outline" disabled={busy !== null}>
                  Save
                </Button>
              </div>
              <span className="text-xs text-muted">Separated by commas. Tasks for these names (and "I"/"me") are yours; tasks for anyone else are skipped.</span>
            </form>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={busy !== null || !st.enabled}
                onClick={() =>
                  void run("scan", async () => {
                    const r = await store.ai.scanActions();
                    return r.scanned === 0
                      ? "No changed notes to read right now."
                      : `Read ${r.scanned} note${r.scanned === 1 ? "" : "s"}: ${r.created.length} new action item${r.created.length === 1 ? "" : "s"}.`;
                  })
                }
              >
                {busy === "scan" ? "Reading notes…" : "Scan now"}
              </Button>
              <span className="text-xs text-muted">{st.lastScan ? `Last scan ${relativeTime(st.lastScan)}.` : "Not scanned yet."}</span>
            </div>
            {st.lastError && <p className="text-sm text-danger">Last scan: {st.lastError}</p>}
          </>
        )}
        {message && <p className="text-sm text-accent">{message}</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Card>
  );
}

export function NotificationsSection() {
  const n = store.notifications!;
  const [perm, setPerm] = useState<NotificationPermission | null>(null);
  const [s, setS] = useState<ReminderSettings>(n.getSettings());
  const [message, setMessage] = useState("");

  useEffect(() => {
    void n.permission().then(setPerm).catch(() => setPerm("denied"));
  }, [n]);

  const update = async (next: ReminderSettings) => {
    setS(next);
    await n.setSettings(next);
    setMessage(`Saved. ${scheduled(await n.reschedule())}.`);
  };

  return (
    <Card id="notifications" title="Notifications">
      {perm === null ? (
        <p className="text-sm text-muted">Checking…</p>
      ) : perm !== "granted" ? (
        <div className="flex flex-col gap-2 text-sm">
          <p>Get a reminder when an action item or task is due, before calendar events, and (if you like) a daily nudge to write.</p>
          {perm === "denied" ? (
            <p className="text-muted">
              Notifications are blocked for Dotion. Turn them on in Android Settings → Apps → Dotion → Notifications, then come back here.
            </p>
          ) : null}
          <Button
            variant="primary"
            className="self-start"
            onClick={async () => {
              const r = await n.request();
              setPerm(r);
              if (r === "granted") setMessage(`Notifications are on. ${scheduled(await n.reschedule())}.`);
            }}
          >
            <BellRing size={15} /> Allow notifications
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Toggle checked={s.due} onChange={(v) => void update({ ...s, due: v })} label="Due dates" hint="Action items, GitLab issues and any database record with a due date that isn't done." />
          {s.due && (
            <label className="flex items-center gap-2 pl-7 text-sm">
              Remind me at
              <input type="time" value={s.dueTime} onChange={(e) => e.target.value && void update({ ...s, dueTime: e.target.value })} className="rounded border border-line bg-paper px-2 py-1" />
              on the day
            </label>
          )}
          <Toggle checked={s.events} onChange={(v) => void update({ ...s, events: v })} label="Calendar events" hint="10 minutes before each Google Calendar event." />
          <Toggle checked={s.daily !== null} onChange={(v) => void update({ ...s, daily: v ? "20:00" : null })} label="Daily reminder to write" />
          {s.daily !== null && (
            <label className="flex items-center gap-2 pl-7 text-sm">
              At
              <input type="time" value={s.daily} onChange={(e) => e.target.value && void update({ ...s, daily: e.target.value })} className="rounded border border-line bg-paper px-2 py-1" />
            </label>
          )}
          <Button variant="outline" className="self-start" onClick={() => void n.test()}>
            Send a test notification
          </Button>
          <p className="text-xs text-muted">Reminders are planned on this phone from your synced notes, so they work offline.</p>
        </div>
      )}
      {message && <p className="text-sm text-accent">{message}</p>}
    </Card>
  );
}

const scheduled = (n: number) => (n === 1 ? "1 reminder scheduled" : `${n} reminders scheduled`);
