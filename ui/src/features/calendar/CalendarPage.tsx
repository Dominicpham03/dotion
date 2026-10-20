import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { IconButton, PageTitle } from "@/components/ui";
import { addMonths, isMonth, monthGrid, monthOf, monthRange, monthTitle, todayLocal, weekdayNames } from "@/lib/dates";
import { store } from "@platform";
import { AddEventForm, ConnectCalendarPrompt, useCanAddEvents } from "./CalendarParts";
import { useEvents } from "./useCalendar";
import { useDueDates, type DueItem } from "./useDueDates";
import type { EntrySummary } from "@/platform/types";

/** Month grid. Days with entries get a dot whose size reflects word count,
 *  which shows the rhythm of writing across the month. */
export function CalendarPage() {
  const { month: param } = useParams();
  const today = todayLocal();
  const month = param ?? monthOf(today);
  const { from, to } = isMonth(month) ? monthRange(month) : { from: "", to: "" };

  const { data = [], isPending } = useQuery({
    queryKey: ["range", from, to],
    queryFn: () => store.listRange(from, to),
    enabled: isMonth(month),
  });
  const events = useEvents(from || today, to || today);
  const dues = useDueDates(from || today, to || today);
  const canAdd = useCanAddEvents();
  const [addDay, setAddDay] = useState<string | null>(null);

  if (!isMonth(month)) return <Navigate to="/calendar" replace />;

  const byDate = new Map<string, EntrySummary[]>();
  for (const e of data) if (e.entryDate) byDate.set(e.entryDate, [...(byDate.get(e.entryDate) ?? []), e]);
  const maxWords = Math.max(200, ...data.map((e) => e.words));
  const totalWords = data.reduce((n, e) => n + e.words, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>{monthTitle(month)}</PageTitle>
        <div className="flex items-center gap-1 text-sm">
          <Link className="rounded px-3 py-1.5 hover:bg-accent-soft" to={`/calendar/${addMonths(month, -1)}`} aria-label="Previous month">
            ←
          </Link>
          <Link className="rounded px-3 py-1.5 hover:bg-accent-soft" to={`/calendar/${monthOf(today)}`}>
            This month
          </Link>
          <Link className="rounded px-3 py-1.5 hover:bg-accent-soft" to={`/calendar/${addMonths(month, 1)}`} aria-label="Next month">
            →
          </Link>
        </div>
      </div>

      <ConnectCalendarPrompt />

      <p className="text-sm text-muted tabular-nums">
        {isPending ? "Loading…" : `${byDate.size} ${byDate.size === 1 ? "day" : "days"} written · ${totalWords.toLocaleString()} words`}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] table-fixed border-collapse">
          <thead>
            <tr>
              {weekdayNames().map((d) => (
                <th key={d} className="pb-2 text-xs font-medium uppercase tracking-wider text-muted">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthGrid(month).map((week, i) => (
              <tr key={i}>
                {week.map((day, j) => {
                  if (!day) return <td key={j} className="h-20 border border-line/60 bg-paper" />;
                  const entries = byDate.get(day) ?? [];
                  const dueItems = dues.get(day) ?? [];
                  const words = entries.reduce((n, e) => n + e.words, 0);
                  const size = entries.length ? 6 + Math.round(12 * Math.sqrt(Math.min(1, words / maxWords))) : 0;
                  const parts = [
                    entries.length ? `${entries.map((e) => e.title || "Untitled").join(", ")} (${words} words)` : "",
                    dueItems.length ? `due: ${dueItems.map((d) => d.title || "Untitled").join(", ")}` : "",
                  ].filter(Boolean);
                  const label = parts.length ? `${day}: ${parts.join(" · ")}` : `${day}: no entry`;
                  return (
                    <td key={j} className="group relative h-20 border border-line/60 bg-surface p-0 align-top">
                      <Link
                        to={`/day/${day}`}
                        title={label}
                        aria-label={label}
                        className={`flex h-full flex-col justify-between p-2 hover:bg-accent-soft/50 ${day > today ? "text-muted/60" : ""}`}
                      >
                        <span
                          className={`text-sm tabular-nums ${day === today ? "inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent-strong text-on-accent" : ""}`}
                        >
                          {Number(day.slice(8))}
                        </span>
                        <DueChips items={dueItems} />
                        <EventChips events={events.byDay.get(day) ?? []} />
                        {size > 0 && <span className="self-center rounded-full bg-accent" style={{ width: size, height: size }} aria-hidden />}
                      </Link>
                      {canAdd && (
                        <button
                          type="button"
                          aria-label={`Add to ${day}`}
                          title="Add to this day"
                          onClick={() => setAddDay(day)}
                          className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded bg-surface text-muted shadow-sm hover:bg-accent-soft hover:text-accent group-hover:flex"
                        >
                          <Plus size={14} />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addDay && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-ink/30 p-4 pt-24" onClick={() => setAddDay(null)}>
          <div className="w-full max-w-xl rounded-lg border border-line bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Add to {addDay}</h2>
              <IconButton size="sm" label="Close" onClick={() => setAddDay(null)}>
                <X size={16} />
              </IconButton>
            </div>
            <AddEventForm day={addDay} autoFocus onDone={() => setAddDay(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

function DueChips({ items }: { items: DueItem[] }) {
  if (!items.length) return null;
  return (
    <span className="flex flex-col gap-0.5" aria-label={`${items.length} ${items.length === 1 ? "due item" : "due items"}`}>
      {items.slice(0, 2).map((d) => (
        <span key={`${d.databaseId}:${d.id}`} className="flex items-center gap-1 truncate text-[11px] leading-tight text-accent">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong" aria-hidden />
          <span className="truncate">{d.title || "Untitled"}</span>
        </span>
      ))}
      {items.length > 2 && <span className="text-[11px] text-muted">+{items.length - 2} more</span>}
    </span>
  );
}

function EventChips({ events }: { events: { id: string; title: string; color?: string }[] }) {
  if (!events.length) return null;
  return (
    <span className="flex flex-col gap-0.5" aria-label={`${events.length} calendar ${events.length === 1 ? "event" : "events"}`}>
      {events.slice(0, 2).map((e) => (
        <span key={e.id} className="flex items-center gap-1 truncate text-[11px] leading-tight text-muted">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.color || "rgb(var(--accent))" }} aria-hidden />
          <span className="truncate">{e.title}</span>
        </span>
      ))}
      {events.length > 2 && <span className="text-[11px] text-muted">+{events.length - 2} more</span>}
    </span>
  );
}
