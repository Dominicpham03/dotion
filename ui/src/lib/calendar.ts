// Calendar event helpers: ranges in the viewer's time zone, grouping by day.
import type { CalendarEvent } from "@/platform/types";
import { addDays, parseLocalDate, toLocalDate } from "./dates";

/** ISO instant for local midnight at the start of date, with the local offset. */
export function localMidnight(date: string): string {
  const d = parseLocalDate(date);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${date}T00:00:00${sign}${hh}:${mm}`;
}

/** The query range for the days from..to (inclusive). */
export function rangeFor(from: string, to: string): { start: string; end: string } {
  return { start: localMidnight(from), end: localMidnight(addDays(to, 1)) };
}

/** Local days an event covers. End is exclusive; a timed event ending at
 *  midnight does not spill into the next day. */
export function daysOf(e: CalendarEvent): string[] {
  let first: string;
  let last: string;
  if (e.allDay) {
    first = e.start;
    last = addDays(e.end || e.start, -1);
  } else {
    const s = new Date(e.start);
    const en = new Date(e.end || e.start);
    first = toLocalDate(s);
    const endMinus = new Date(Math.max(s.getTime(), en.getTime() - 1));
    last = toLocalDate(endMinus);
  }
  if (last < first) last = first;
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

export function eventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const m = new Map<string, CalendarEvent[]>();
  for (const e of events) for (const d of daysOf(e)) m.set(d, [...(m.get(d) ?? []), e]);
  return m;
}

/** "09:00–09:15", "All day", or "from 22:00" on the first of several days. */
export function timeLabel(e: CalendarEvent, day: string): string {
  if (e.allDay) return "All day";
  const fmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const s = new Date(e.start);
  const en = new Date(e.end || e.start);
  const startsToday = toLocalDate(s) === day;
  const endsToday = toLocalDate(new Date(en.getTime() - 1)) === day;
  if (startsToday && endsToday) return `${fmt(s)}–${fmt(en)}`;
  if (startsToday) return `from ${fmt(s)}`;
  if (endsToday) return `until ${fmt(en)}`;
  return "All day";
}
