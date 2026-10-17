// Plans the Android reminders from what is on the device: no network needed.
// Pure functions, so tests can check them without the notification plugin.
import type { CalendarEvent, Entry, PropertyDef, ReminderSettings } from "@/platform/types";

export const DEFAULT_REMINDERS: ReminderSettings = { daily: null, due: true, dueTime: "09:00", events: true };

export interface PlannedReminder {
  id: number; // stable per item, so rescheduling replaces rather than duplicates
  title: string;
  body: string;
  at?: Date; // one-off
  daily?: { hour: number; minute: number }; // repeating
  route: string; // where tapping it opens, e.g. "/entry/<id>"
}

const MAX_REMINDERS = 60; // Android caps pending alarms per app
const DONE = /\b(done|complete|completed|closed|merged|cancel+ed|finished|resolved)\b/i;

/** A positive 31-bit id from a string (FNV-1a). 1–9 are kept for fixed reminders. */
export function reminderId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 2_000_000_000) + 10;
}

function parseTime(t: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

function at(date: string, time: { hour: number; minute: number }): Date {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(y, mo - 1, d, time.hour, time.minute);
}

/** The record's due date and whether it is finished, from its database schema. */
export function dueInfo(record: Entry, props: PropertyDef[]): { due: string | null; done: boolean } {
  const values = record.meta.props ?? {};
  const dates = props.filter((p) => p.type === "date" && typeof values[p.id] === "string" && /^\d{4}-\d{2}-\d{2}/.test(values[p.id] as string));
  // Prefer a property called Due / Deadline; else the first date.
  const dueProp = dates.find((p) => /due|deadline/i.test(p.name)) ?? dates[0];
  let done = false;
  for (const p of props) {
    const v = values[p.id];
    if (p.type === "checkbox" && v === true && /done|complete|finished/i.test(p.name)) done = true;
    if ((p.type === "status" || p.type === "select") && typeof v === "string") {
      const name = p.options?.find((o) => o.id === v)?.name ?? "";
      if (DONE.test(name)) done = true;
    }
  }
  return { due: dueProp ? (values[dueProp.id] as string).slice(0, 10) : null, done };
}

/**
 * Reminders for the next two weeks:
 * - the daily nudge to write (if on);
 * - records with a due date that aren't done, at settings.dueTime on that day
 *   (or in 1 minute if that time already passed today);
 * - timed calendar events, 10 minutes before they start.
 */
export function planReminders(entries: Entry[], events: CalendarEvent[], settings: ReminderSettings, now = new Date()): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const daily = settings.daily ? parseTime(settings.daily) : null;
  if (daily) out.push({ id: 1, title: "Time to write", body: "Add today's entry in Dotion.", daily, route: "/" });

  const horizon = new Date(now.getTime() + 14 * 86_400_000);
  const dueTime = parseTime(settings.dueTime) ?? { hour: 9, minute: 0 };
  const todayKey = localDate(now);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const timed: PlannedReminder[] = [];

  if (settings.due) {
    for (const r of entries) {
      const db = r.parentId ? byId.get(r.parentId) : undefined;
      if (r.deletedAt || !db || db.kind !== "database") continue;
      const { due, done } = dueInfo(r, db.meta.schema?.properties ?? []);
      if (!due || done || due < todayKey) continue;
      let when = at(due, dueTime);
      if (when <= now) {
        if (due !== todayKey) continue;
        when = new Date(now.getTime() + 60_000); // due today and the usual time passed
      }
      if (when > horizon) continue;
      timed.push({
        id: reminderId(`due:${r.id}:${due}`),
        title: due === todayKey ? `Due today: ${r.title || "Untitled"}` : `Due: ${r.title || "Untitled"}`,
        body: `${db.meta.icon ? db.meta.icon + " " : ""}${db.title || "Database"}`,
        at: when,
        route: `/entry/${r.id}`,
      });
    }
  }

  if (settings.events) {
    for (const e of events) {
      if (e.allDay) continue;
      const start = new Date(e.start);
      const when = new Date(start.getTime() - 10 * 60_000);
      if (isNaN(start.getTime()) || when <= now || when > horizon) continue;
      timed.push({
        id: reminderId(`event:${e.id}:${e.start}`),
        title: e.title || "Event",
        body: `In 10 minutes, ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${e.location ? ` · ${e.location}` : ""}`,
        at: when,
        route: `/day/${localDate(start)}`,
      });
    }
  }

  timed.sort((a, b) => a.at!.getTime() - b.at!.getTime());
  return [...out, ...timed.slice(0, MAX_REMINDERS - out.length)];
}

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
