import { useState } from "react";
import { Link } from "react-router-dom";
import { Banner, Button } from "@/components/ui";
import { timeLabel } from "@/lib/calendar";
import { openExternal } from "@/lib/external";
import { readJSON, writeJSON } from "@/lib/storage";
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

/** The day's events, above the entry. */
export function DayEvents({ day, events, stale }: { day: string; events: CalendarEvent[]; stale?: boolean }) {
  if (!events.length) return null;
  return (
    <section aria-label="Calendar events" className="flex flex-col gap-1 rounded-lg border border-line bg-surface/60 p-3">
      <h2 className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted">
        <span>On your calendar</span>
        {stale && <span className="normal-case tracking-normal">offline · last known</span>}
      </h2>
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
