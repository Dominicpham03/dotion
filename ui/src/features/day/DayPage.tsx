import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { addDays, dayTitle, isDate, longDate, todayLocal } from "@/lib/dates";
import { uuidv7 } from "@/lib/uuid";
import { store } from "@platform";
import { EntryEditor } from "@/features/entry/EntryEditor";
import { ConnectCalendarPrompt, DayEvents } from "@/features/calendar/CalendarParts";
import { useEvents } from "@/features/calendar/useCalendar";

/** Today, or any day from the calendar. The entry is created on the first
 *  keystroke, so empty days never produce empty entries. */
export function DayPage() {
  const params = useParams();
  const date = params.date ?? todayLocal();
  const navigate = useNavigate();
  const newIds = useRef(new Map<string, string>()); // a stable id per unsaved day
  const events = useEvents(isDate(date) ? date : todayLocal(), isDate(date) ? date : todayLocal());

  const { data: entry, isPending, isError, error } = useQuery({
    queryKey: ["entry-date", date],
    queryFn: () => store.getEntryForDate(date),
    enabled: isDate(date),
  });

  // Ctrl+[ / Ctrl+] move between days.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== "[" && e.key !== "]")) return;
      e.preventDefault();
      navigate(`/day/${addDays(date, e.key === "[" ? -1 : 1)}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [date, navigate]);

  if (!isDate(date)) return <Navigate to="/today" replace />;

  if (!newIds.current.has(date)) newIds.current.set(date, uuidv7());
  const id = entry?.id ?? newIds.current.get(date)!;
  const today = todayLocal();

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center justify-between gap-2 text-sm text-muted" aria-label="Days">
        <Link to={`/day/${addDays(date, -1)}`} className="rounded px-2 py-1 hover:bg-accent-soft hover:text-ink" title="Previous day (Ctrl+[)">
          ← {dayTitle(addDays(date, -1))}
        </Link>
        <span className="hidden text-center sm:block">{date === today ? "Today" : longDate(date)}</span>
        {date < today ? (
          <Link to={`/day/${addDays(date, 1)}`} className="rounded px-2 py-1 hover:bg-accent-soft hover:text-ink" title="Next day (Ctrl+])">
            {dayTitle(addDays(date, 1))} →
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <ConnectCalendarPrompt />
      <DayEvents day={date} events={events.byDay.get(date) ?? []} stale={events.stale} />

      {isError ? (
        <p className="text-danger">Couldn't load this day: {(error as Error).message}</p>
      ) : isPending ? (
        <div className="h-64 animate-pulse rounded-lg bg-accent-soft/40" aria-label="Loading" />
      ) : (
        <EntryEditor key={id} entry={entry ?? null} id={id} entryDate={date} defaultTitle={dayTitle(date)} />
      )}
    </div>
  );
}
