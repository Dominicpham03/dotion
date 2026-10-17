// Local-date helpers. entry_date is the user's calendar date, never UTC: a
// late-night entry in UTC+10 must not land on the wrong day.

export function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayLocal(): string {
  return toLocalDate(new Date());
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDate(s: string | undefined): s is string {
  if (!s || !DATE_RE.test(s)) return false;
  return toLocalDate(parseLocalDate(s)) === s;
}

/** Parses "YYYY-MM-DD" as local midnight (Date's own parser would use UTC). */
export function parseLocalDate(s: string): Date {
  const [, y, m, d] = DATE_RE.exec(s) ?? [];
  return new Date(Number(y), Number(m) - 1, Number(d));
}

export function addDays(date: string, n: number): string {
  const d = parseLocalDate(date);
  d.setDate(d.getDate() + n);
  return toLocalDate(d);
}

/** "Monday, 5 October": the default title of a daily entry. */
export function dayTitle(date: string): string {
  const d = parseLocalDate(date);
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const month = d.toLocaleDateString(undefined, { month: "long" });
  return `${weekday}, ${d.getDate()} ${month}`;
}

/** "Monday, 5 October 2026" */
export function longDate(date: string): string {
  return `${dayTitle(date)} ${parseLocalDate(date).getFullYear()}`;
}

export function shortDate(date: string): string {
  return parseLocalDate(date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "2026-10" for a date */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function isMonth(s: string | undefined): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return toLocalDate(d).slice(0, 7);
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  return { from: toLocalDate(new Date(y, m - 1, 1)), to: toLocalDate(new Date(y, m, 0)) };
}

export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Weeks of a month, Monday first; days outside the month are null. */
export function monthGrid(month: string): (string | null)[][] {
  const { from, to } = monthRange(month);
  const first = parseLocalDate(from);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const days: (string | null)[] = Array(lead).fill(null);
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  while (days.length % 7) days.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

export function weekdayNames(): string[] {
  const monday = new Date(2024, 0, 1); // a Monday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString(undefined, { weekday: "short" });
  });
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function relativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const s = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
