import { PanelRightOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/ui";
import { Link, useNavigate } from "react-router-dom";
import { addMonths, isDate, monthGrid, monthOf, monthTitle, todayLocal, weekdayNames } from "@/lib/dates";
import { formatValue, groupRecords, isEmpty, valueOf } from "@/lib/db";
import type { Entry, PropertyDef, PropValue, ViewDef } from "@/platform/types";
import { OptionChip, PropertyCell } from "./PropertyCell";
import { PropIcon } from "./propIcons";
import type { DatabaseApi } from "./useDatabase";

export type ViewProps = {
  api: DatabaseApi;
  view: ViewDef;
  records: Entry[]; // already filtered and sorted
  createOption: (prop: PropertyDef, name: string) => string;
  newRecordProps: Record<string, PropValue>;
};

const recordLink = (r: Entry) => `/entry/${r.id}`;

// ---- table ------------------------------------------------------------------

export function TableView({ api, view, records, createOption, newRecordProps }: ViewProps) {
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const props = api.schema.properties.filter((p) => !view.hidden?.includes(p.id));
  const head = "border-b border-line px-3 py-2.5 text-left text-xs font-medium text-muted";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface/40">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead className="bg-ink/[0.03]">
            <tr>
              <th className={`${head} min-w-64`}>
                <span className="flex items-center gap-1.5">
                  <PropIcon type="title" /> Name
                </span>
              </th>
              {props.map((p) => (
                <th key={p.id} className={`${head} min-w-40 border-l ${p.type === "checkbox" ? "min-w-24 text-center" : ""}`}>
                  <span className={`flex items-center gap-1.5 ${p.type === "checkbox" ? "justify-center" : ""}`}>
                    <PropIcon type={p.type} /> {p.name}
                  </span>
                </th>
              ))}
              <th className={`${head} w-12`} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className="group border-b border-line/60 transition-colors last:border-b-0 hover:bg-ink/[0.025]">
                <td className="py-1 pl-1.5 pr-1">
                  <span className="flex items-center gap-1">
                    <TitleInput rec={r} api={api} />
                    <Link
                      to={recordLink(r)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs text-muted opacity-0 shadow-sm transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
                    >
                      <PanelRightOpen size={13} /> Open
                    </Link>
                  </span>
                </td>
                {props.map((p) => (
                  <td key={p.id} className={`border-l border-line/60 px-1.5 py-1 align-middle ${p.type === "checkbox" ? "text-center" : ""}`}>
                    <PropertyCell
                      prop={p}
                      value={valueOf(r, p.id)}
                      onChange={(v) => api.updateRecord(r, p.id, v)}
                      onCreateOption={createOption}
                      label={`${p.name} of ${r.title || "Untitled"}`}
                    />
                  </td>
                ))}
                <td className="px-1.5 text-right">
                  {confirmFor === r.id ? (
                    <span className="flex justify-end gap-1">
                      <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10" onClick={() => void api.deleteRecord(r)}>
                        Delete
                      </button>
                      <button type="button" className="rounded-md px-2 py-1 text-xs hover:bg-ink/[0.06]" onClick={() => setConfirmFor(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <IconButton
                      size="sm"
                      label={`Delete ${r.title || "Untitled"}`}
                      onClick={() => setConfirmFor(r.id)}
                      className="opacity-0 hover:!text-danger focus:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {records.length === 0 && <p className="border-b border-line/60 px-4 py-6 text-center text-sm text-muted">No records match this view yet.</p>}
      <button
        type="button"
        onClick={() => {
          const id = api.createRecord(newRecordProps);
          requestAnimationFrame(() => document.getElementById(`title-${id}`)?.focus());
        }}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted transition-colors hover:bg-ink/[0.04] hover:text-ink"
      >
        <Plus size={15} /> New record
      </button>
    </div>
  );
}

function TitleInput({ rec, api }: { rec: Entry; api: DatabaseApi }) {
  const [text, setText] = useState(rec.title);
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : rec.title;
  return (
    <input
      id={`title-${rec.id}`}
      aria-label="Name"
      value={shown}
      placeholder="Untitled"
      onFocus={() => {
        setText(rec.title);
        setFocused(true);
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (text !== rec.title) api.renameRecord(rec, text);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 font-medium placeholder:font-normal placeholder:text-muted/60 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent-strong/60"
    />
  );
}

// ---- board ------------------------------------------------------------------

export function BoardView({ api, view, records, newRecordProps }: ViewProps) {
  const navigate = useNavigate();
  const group = api.schema.properties.find((p) => p.id === view.groupBy && (p.type === "select" || p.type === "status"));
  const [over, setOver] = useState<string | null>(null);
  if (!group) {
    return <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">Choose a Select or Status property to group by in View settings.</p>;
  }
  const cards = api.schema.properties.filter((p) => p.id !== group.id && !view.hidden?.includes(p.id));
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {groupRecords(records, group).map(({ option, records: list }) => {
        const key = option?.id ?? "none";
        return (
          <section
            key={key}
            aria-label={option?.name ?? "No value"}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(key);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const rec = records.find((r) => r.id === e.dataTransfer.getData("text/x-record"));
              if (rec && valueOf(rec, group.id) !== (option?.id ?? null)) api.updateRecord(rec, group.id, option?.id ?? null);
            }}
            className={`flex w-72 shrink-0 flex-col gap-2 rounded-xl p-2.5 transition-colors ${over === key ? "bg-accent-soft" : "bg-ink/[0.03]"}`}
          >
            <h3 className="flex items-center justify-between px-1 text-xs font-medium text-muted">
              {option ? <OptionChip option={option} /> : <span>No {group.name}</span>}
              <span className="tabular-nums">{list.length}</span>
            </h3>
            {list.map((r) => (
              <article
                key={r.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/x-record", r.id)}
                className="cursor-grab rounded-lg border border-line bg-surface p-3 shadow-sm transition-all hover:border-accent-strong/40 hover:shadow-md active:cursor-grabbing"
              >
                <Link to={recordLink(r)} className="block font-medium hover:text-accent">
                  {r.meta.icon ? `${r.meta.icon} ` : ""}
                  {r.title || "Untitled"}
                </Link>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted">
                  {cards.map((p) => {
                    const v = valueOf(r, p.id);
                    if (isEmpty(v)) return null;
                    if (p.type === "multi_select" && Array.isArray(v))
                      return v.map((id) => {
                        const o = p.options?.find((x) => x.id === id);
                        return o ? <OptionChip key={id} option={o} /> : null;
                      });
                    if (p.type === "select" || p.type === "status") {
                      const o = p.options?.find((x) => x.id === v);
                      return o ? <OptionChip key={p.id} option={o} /> : null;
                    }
                    if (p.type === "relation") return null;
                    return (
                      <span key={p.id} title={p.name}>
                        {p.type === "checkbox" ? `✓ ${p.name}` : formatValue(p, v)}
                      </span>
                    );
                  })}
                </div>
              </article>
            ))}
            <button
              type="button"
              onClick={() => navigate(recordLink({ id: api.createRecord({ ...newRecordProps, [group.id]: option?.id ?? null }) } as Entry))}
              className="rounded px-2 py-1 text-left text-sm text-muted hover:bg-accent-soft hover:text-ink"
            >
              + New
            </button>
          </section>
        );
      })}
    </div>
  );
}

// ---- calendar ---------------------------------------------------------------

export function CalendarView({ api, view, records, newRecordProps }: ViewProps) {
  const navigate = useNavigate();
  const today = todayLocal();
  const [month, setMonth] = useState(monthOf(today));
  const dateProp = api.schema.properties.find((p) => p.id === view.dateProperty && p.type === "date");
  if (!dateProp) {
    return <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">Choose a Date property in View settings to see records on a calendar.</p>;
  }
  const byDay = new Map<string, Entry[]>();
  for (const r of records) {
    const d = valueOf(r, dateProp.id);
    if (typeof d === "string" && isDate(d)) byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const undated = records.filter((r) => isEmpty(valueOf(r, dateProp.id)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{monthTitle(month)}</h3>
        <div className="flex gap-1 text-sm">
          <button type="button" aria-label="Previous month" className="rounded px-2 py-1 hover:bg-accent-soft" onClick={() => setMonth(addMonths(month, -1))}>
            ←
          </button>
          <button type="button" className="rounded px-2 py-1 hover:bg-accent-soft" onClick={() => setMonth(monthOf(today))}>
            Today
          </button>
          <button type="button" aria-label="Next month" className="rounded px-2 py-1 hover:bg-accent-soft" onClick={() => setMonth(addMonths(month, 1))}>
            →
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] table-fixed border-collapse text-sm">
          <thead>
            <tr>
              {weekdayNames().map((d) => (
                <th key={d} className="pb-1 text-xs font-medium uppercase tracking-wider text-muted">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthGrid(month).map((week, i) => (
              <tr key={i}>
                {week.map((day, j) => (
                  <td key={j} className={`group h-24 border border-line/60 p-1 align-top ${day ? "bg-surface" : "bg-paper"}`}>
                    {day && (
                      <div className="flex h-full flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className={`text-xs tabular-nums ${day === today ? "rounded-full bg-accent-strong px-1.5 text-on-accent" : "text-muted"}`}>
                            {Number(day.slice(8))}
                          </span>
                          <button
                            type="button"
                            aria-label={`New record on ${day}`}
                            onClick={() => navigate(recordLink({ id: api.createRecord({ ...newRecordProps, [dateProp.id]: day }) } as Entry))}
                            className="rounded px-1 text-xs text-muted opacity-0 hover:bg-accent-soft focus:opacity-100 group-hover:opacity-100"
                          >
                            +
                          </button>
                        </div>
                        {(byDay.get(day) ?? []).map((r) => (
                          <Link key={r.id} to={recordLink(r)} className="truncate rounded bg-accent-soft px-1 py-0.5 text-xs hover:bg-accent-soft/70">
                            {r.title || "Untitled"}
                          </Link>
                        ))}
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {undated.length > 0 && (
        <p className="text-xs text-muted">
          {undated.length} {undated.length === 1 ? "record has" : "records have"} no {dateProp.name}.
        </p>
      )}
    </div>
  );
}
