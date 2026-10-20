import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Banner, Button } from "@/components/ui";
import { timeLabel } from "@/lib/calendar";
import { openExternal } from "@/lib/external";
import { readJSON, writeJSON } from "@/lib/storage";
import { store } from "@platform";
import type { CalendarEvent } from "@/platform/types";
import { useCalendarStatus, useConnectCalendar } from "./useCalendar";

const DISMISSED = "calendar-prompt-dismissed";

/** Asks to connect Google Calendar until connected or dismissed. */
export function ConnectCalendarPrompt() {
  const status = useCalendarStatus();
  const { connect, waiting, error } = useConnectCalendar();
  const [dismissed, setDismissed] = useState(() => readJSON(DISMISSED, false));
  const st = status.data;
  if (dismissed || !st || st.connected || st.offline) return null;

  return (
    <Banner
      actions={
        <>
          {st.configured ? (
            <Button variant="primary" disabled={waiting} onClick={() => void connect()}>
              {waiting ? "Waiting for Google…" : "Connect Google Calendar"}
            </Button>
          ) : (
            <Link to="/settings#calendar" className="inline-flex h-9 items-center rounded-md bg-accent-strong px-3 text-sm font-medium text-on-accent hover:bg-accent-strong/90">
              Set up
            </Link>
          )}
          <Button
            onClick={() => {
              writeJSON(DISMISSED, true);
              setDismissed(true);
            }}
          >
            Not now
          </Button>
        </>
      }
    >
      <p className="font-medium">See your Google Calendar next to your notes</p>
      <p className="text-muted">
        {waiting
          ? "Finish signing in with Google in your browser, then come back here."
          : "Events show on each day and in the calendar. Dotion only reads your calendar; it never changes it."}
      </p>
      {error && <p className="text-danger">{error}</p>}
    </Banner>
  );
}

/** True when the web user may add events to their calendar. */
export function useCanAddEvents() {
  const status = useCalendarStatus();
  return store.platform === "web" && !!status.data?.calendarWrite && typeof store.calendar.addEvent === "function";
}

/** Quick form to add a task or event to the general calendar. Leaving the time
 *  blank makes an all-day task; setting a start time makes a timed event. An
 *  optional end date turns either into a multi-day span. */
export function AddEventForm({ day, autoFocus, onDone }: { day: string; autoFocus?: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(day);
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError("");
    try {
      const d = date || day;
      const ed = endDate && endDate >= d ? endDate : ""; // ignore an end date before the start
      let input: { title: string; date?: string; endDate?: string; start?: string; end?: string };
      if (startTime) {
        // Timed event; spans to the end date when one is given.
        const start = new Date(`${d}T${startTime}`);
        let end = endTime ? new Date(`${ed || d}T${endTime}`) : new Date(start.getTime() + 60 * 60 * 1000);
        if (!(end > start)) end = new Date(start.getTime() + 60 * 60 * 1000);
        input = { title: t, start: start.toISOString(), end: end.toISOString() };
      } else {
        // All-day, single day or a multi-day range.
        input = { title: t, date: d, ...(ed ? { endDate: ed } : {}) };
      }
      await store.calendar.addEvent!(input);
      setTitle("");
      setEndDate("");
      setStartTime("");
      setEndTime("");
      await qc.invalidateQueries({ queryKey: ["events"] });
      onDone?.();
    } catch (err) {
      setError((err as Error).message || "Couldn't add it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const field = "h-8 rounded border border-line bg-surface px-2 text-sm";
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 py-1">
      <input autoFocus={autoFocus} aria-label="Task or event title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task or event…" className={`${field} min-w-0 flex-1`} />
      <input type="date" aria-label="Start date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
      <span className="text-xs text-muted">–</span>
      <input type="date" aria-label="End date (optional)" title="End date (optional, for a multi-day event)" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} className={field} />
      <input type="time" aria-label="Start time (optional)" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={field} />
      <span className="text-xs text-muted">to</span>
      <input type="time" aria-label="End time (optional)" value={endTime} disabled={!startTime} onChange={(e) => setEndTime(e.target.value)} className={`${field} disabled:opacity-40`} />
      <Button variant="primary" type="submit" disabled={busy || !title.trim()}>
        {busy ? "Adding…" : "Add"}
      </Button>
      {error && <span className="w-full text-xs text-danger">{error}</span>}
    </form>
  );
}

/** The day's events, above the entry, with a quick "add a task" form. */
export function DayEvents({ day, events, stale }: { day: string; events: CalendarEvent[]; stale?: boolean }) {
  const canAdd = useCanAddEvents();
  const [adding, setAdding] = useState(false);

  if (!events.length && !canAdd) return null;

  return (
    <section aria-label="Calendar events" className="flex flex-col gap-1 rounded-lg border border-line bg-surface/60 p-3">
      <h2 className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted">
        <span>On your calendar</span>
        <span className="flex items-center gap-2">
          {stale && <span className="normal-case tracking-normal">offline · last known</span>}
          {canAdd && (
            <button type="button" onClick={() => setAdding((a) => !a)} className="normal-case tracking-normal text-accent hover:underline" aria-expanded={adding}>
              {adding ? "Cancel" : "+ Add task"}
            </button>
          )}
        </span>
      </h2>
      {adding && canAdd && <AddEventForm day={day} autoFocus onDone={() => setAdding(false)} />}
      <ul className="flex flex-col">
        {events.map((e) => (
          <li key={e.id} className="flex items-baseline gap-3 py-0.5 text-sm">
            <span className="w-28 shrink-0 text-xs text-muted tabular-nums">{timeLabel(e, day)}</span>
            <span className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: e.color || "rgb(var(--accent))" }} aria-hidden />
            <span className="min-w-0 flex-1">
              {e.link ? (
                <a
                  href={e.link}
                  onClick={(ev) => {
                    ev.preventDefault();
                    openExternal(e.link!);
                  }}
                  className="hover:text-accent hover:underline"
                >
                  {e.title}
                </a>
              ) : (
                e.title
              )}
              {e.location && <span className="text-muted"> · {e.location}</span>}
            </span>
            <span className="hidden shrink-0 text-xs text-muted sm:inline">{e.calendar}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
