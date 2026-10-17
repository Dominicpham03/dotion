import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FILTER_OPS, hasOptions, newOptionId, newProperty, OPTION_COLORS, PROP_TYPES } from "@/lib/db";
import { store } from "@platform";
import type { DatabaseSchema, FilterOp, PropertyDef, PropType, ViewDef, ViewFilter } from "@/platform/types";
import { OptionChip } from "./PropertyCell";

type Update = (fn: (s: DatabaseSchema) => DatabaseSchema) => void;

const select = "h-8 rounded border border-line bg-paper px-1.5 text-sm";
const textInput = "h-8 min-w-0 rounded border border-line bg-paper px-2 text-sm";

const mapProp = (id: string, fn: (p: PropertyDef) => PropertyDef) => (s: DatabaseSchema): DatabaseSchema => ({
  ...s,
  properties: s.properties.map((p) => (p.id === id ? fn(p) : p)),
});

const mapView = (id: string, fn: (v: ViewDef) => ViewDef) => (s: DatabaseSchema): DatabaseSchema => ({
  ...s,
  views: s.views.map((v) => (v.id === id ? fn(v) : v)),
});

// ---- properties ---------------------------------------------------------------

export function PropertiesPanel({ schema, view, update, databaseId }: { schema: DatabaseSchema; view: ViewDef; update: Update; databaseId: string }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PropType>("text");
  const [open, setOpen] = useState<string | null>(null);
  const { data: pages = [] } = useQuery({ queryKey: ["pages"], queryFn: () => store.listPages() });
  const databases = pages.filter((p) => p.kind === "database");

  return (
    <div className="flex w-[22rem] max-w-[90vw] flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {schema.properties.map((p) => {
          const hidden = view.hidden?.includes(p.id) ?? false;
          return (
            <li key={p.id} className="rounded border border-line/70 p-1.5">
              <div className="flex items-center gap-1">
                <input
                  aria-label="Property name"
                  value={p.name}
                  onChange={(e) => update(mapProp(p.id, (x) => ({ ...x, name: e.target.value })))}
                  className={`${textInput} flex-1`}
                />
                <span className="w-24 truncate text-xs text-muted">{PROP_TYPES.find((t) => t.type === p.type)?.label}</span>
                <button
                  type="button"
                  title={hidden ? "Show in this view" : "Hide in this view"}
                  aria-label={hidden ? `Show ${p.name} in this view` : `Hide ${p.name} in this view`}
                  onClick={() =>
                    update(mapView(view.id, (v) => ({ ...v, hidden: hidden ? (v.hidden ?? []).filter((x) => x !== p.id) : [...(v.hidden ?? []), p.id] })))
                  }
                  className="rounded px-1.5 text-xs text-muted hover:bg-accent-soft"
                >
                  {hidden ? "Hidden" : "Shown"}
                </button>
                <button
                  type="button"
                  aria-expanded={open === p.id}
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                  className="rounded px-1.5 text-xs hover:bg-accent-soft"
                >
                  Edit
                </button>
              </div>
              {open === p.id && (
                <div className="mt-2 flex flex-col gap-2 border-t border-line pt-2">
                  {hasOptions(p.type) && <OptionsEditor prop={p} update={update} />}
                  {p.type === "relation" && (
                    <label className="flex items-center gap-2 text-xs">
                      Links to
                      <select
                        className={select}
                        value={p.relationDatabaseId ?? ""}
                        onChange={(e) => update(mapProp(p.id, (x) => ({ ...x, relationDatabaseId: e.target.value || undefined })))}
                      >
                        <option value="">Any page</option>
                        {databases.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.id === databaseId ? "This database" : d.title || "Untitled database"}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      update((s) => ({
                        ...s,
                        properties: s.properties.filter((x) => x.id !== p.id),
                        views: s.views.map((v) => ({
                          ...v,
                          filters: v.filters.filter((f) => f.propertyId !== p.id),
                          sorts: v.sorts.filter((x) => x.propertyId !== p.id),
                          groupBy: v.groupBy === p.id ? undefined : v.groupBy,
                          dateProperty: v.dateProperty === p.id ? undefined : v.dateProperty,
                        })),
                      }))
                    }
                    className="self-start rounded px-2 py-1 text-xs text-danger hover:bg-danger/10"
                  >
                    Delete property (values stay in each record)
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <form
        className="flex items-center gap-1 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const p = newProperty(name.trim(), type);
          update((s) => ({ ...s, properties: [...s.properties, p] }));
          setName("");
        }}
      >
        <input aria-label="New property name" placeholder="New property" value={name} onChange={(e) => setName(e.target.value)} className={`${textInput} flex-1`} />
        <select aria-label="New property type" className={select} value={type} onChange={(e) => setType(e.target.value as PropType)}>
          {PROP_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <button type="submit" className="h-8 rounded px-2 text-accent hover:bg-accent-soft">
          Add
        </button>
      </form>
    </div>
  );
}

function OptionsEditor({ prop, update }: { prop: PropertyDef; update: Update }) {
  const [name, setName] = useState("");
  const options = prop.options ?? [];
  const setOptions = (fn: (o: typeof options) => typeof options) => update(mapProp(prop.id, (p) => ({ ...p, options: fn(p.options ?? []) })));
  return (
    <div className="flex flex-col gap-1">
      {options.map((o, i) => (
        <div key={o.id} className="flex items-center gap-1">
          <input
            aria-label="Option name"
            value={o.name}
            onChange={(e) => setOptions((os) => os.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))}
            className={`${textInput} flex-1`}
          />
          <select
            aria-label={`Color of ${o.name}`}
            value={o.color}
            onChange={(e) => setOptions((os) => os.map((x) => (x.id === o.id ? { ...x, color: e.target.value as typeof o.color } : x)))}
            className={select}
          >
            {OPTION_COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <OptionChip option={o} />
          <button
            type="button"
            aria-label={`Move ${o.name} up`}
            disabled={i === 0}
            onClick={() => setOptions((os) => os.map((x, j) => (j === i - 1 ? o : j === i ? os[i - 1] : x)))}
            className="rounded px-1 text-xs hover:bg-accent-soft disabled:opacity-30"
          >
            ↑
          </button>
          <button type="button" aria-label={`Remove ${o.name}`} onClick={() => setOptions((os) => os.filter((x) => x.id !== o.id))} className="rounded px-1 text-xs text-danger hover:bg-danger/10">
            ×
          </button>
        </div>
      ))}
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const opt = { id: newOptionId(), name: name.trim(), color: OPTION_COLORS[options.length % OPTION_COLORS.length] };
          setOptions((os) => [...os, opt]);
          setName("");
        }}
      >
        <input aria-label="New option" placeholder="New option" value={name} onChange={(e) => setName(e.target.value)} className={`${textInput} flex-1`} />
        <button type="submit" className="rounded px-2 text-xs text-accent hover:bg-accent-soft">
          Add
        </button>
      </form>
    </div>
  );
}

// ---- filters and sorts --------------------------------------------------------

export function FilterPanel({ schema, view, update }: { schema: DatabaseSchema; view: ViewDef; update: Update }) {
  const setFilters = (fn: (f: ViewFilter[]) => ViewFilter[]) => update(mapView(view.id, (v) => ({ ...v, filters: fn(v.filters) })));
  const fields = [{ id: "title", name: "Name", type: "title" as const }, ...schema.properties];
  return (
    <div className="flex w-[26rem] max-w-[90vw] flex-col gap-2">
      {view.filters.length === 0 && <p className="text-muted">No filters. Every record shows.</p>}
      {view.filters.map((f, i) => {
        const p = schema.properties.find((x) => x.id === f.propertyId);
        const ops = FILTER_OPS[f.propertyId === "title" ? "title" : (p?.type ?? "text")];
        const needsValue = !["empty", "not_empty"].includes(f.op) && p?.type !== "checkbox";
        const set = (patch: Partial<ViewFilter>) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="flex flex-wrap items-center gap-1">
            <select
              aria-label="Filter property"
              className={select}
              value={f.propertyId}
              onChange={(e) => {
                const np = schema.properties.find((x) => x.id === e.target.value);
                set({ propertyId: e.target.value, op: FILTER_OPS[e.target.value === "title" ? "title" : (np?.type ?? "text")][0].op, value: null });
              }}
            >
              {fields.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <select aria-label="Filter condition" className={select} value={f.op} onChange={(e) => set({ op: e.target.value as FilterOp })}>
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {needsValue && <FilterValue prop={p} filter={f} onChange={(value) => set({ value })} />}
            <button type="button" aria-label="Remove filter" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} className="rounded px-1.5 text-danger hover:bg-danger/10">
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setFilters((fs) => [...fs, { propertyId: "title", op: "contains", value: "" }])}
        className="self-start rounded px-2 py-1 text-accent hover:bg-accent-soft"
      >
        + Add filter
      </button>
      {view.filters.length > 1 && <p className="text-xs text-muted">Records must match every filter.</p>}
    </div>
  );
}

function FilterValue({ prop, filter, onChange }: { prop: PropertyDef | undefined; filter: ViewFilter; onChange: (v: string | number | null) => void }) {
  const v = filter.value;
  if (prop && hasOptions(prop.type)) {
    return (
      <select aria-label="Filter value" className={select} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Choose…</option>
        {(prop.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (prop?.type === "date") {
    return (
      <span className="flex items-center gap-1">
        <select aria-label="Filter date" className={select} value={v === "today" ? "today" : "date"} onChange={(e) => onChange(e.target.value === "today" ? "today" : null)}>
          <option value="today">today</option>
          <option value="date">a date…</option>
        </select>
        {v !== "today" && <input type="date" aria-label="Filter date value" className={textInput} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(e.target.value || null)} />}
      </span>
    );
  }
  return (
    <input
      aria-label="Filter value"
      type={prop?.type === "number" ? "number" : "text"}
      className={`${textInput} w-32`}
      value={v == null ? "" : String(v)}
      onChange={(e) => onChange(prop?.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
    />
  );
}

export function SortPanel({ schema, view, update }: { schema: DatabaseSchema; view: ViewDef; update: Update }) {
  const setSorts = (fn: (s: ViewDef["sorts"]) => ViewDef["sorts"]) => update(mapView(view.id, (v) => ({ ...v, sorts: fn(v.sorts) })));
  const fields = [
    { id: "title", name: "Name" },
    { id: "created", name: "Created" },
    { id: "updated", name: "Last edited" },
    ...schema.properties.filter((p) => p.type !== "relation"),
  ];
  return (
    <div className="flex w-80 max-w-[90vw] flex-col gap-2">
      {view.sorts.length === 0 && <p className="text-muted">Sorted by creation order.</p>}
      {view.sorts.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          <select aria-label="Sort by" className={`${select} flex-1`} value={s.propertyId} onChange={(e) => setSorts((ss) => ss.map((x, j) => (j === i ? { ...x, propertyId: e.target.value } : x)))}>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Direction"
            className={select}
            value={s.direction}
            onChange={(e) => setSorts((ss) => ss.map((x, j) => (j === i ? { ...x, direction: e.target.value as "asc" | "desc" } : x)))}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="button" aria-label="Remove sort" onClick={() => setSorts((ss) => ss.filter((_, j) => j !== i))} className="rounded px-1.5 text-danger hover:bg-danger/10">
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setSorts((ss) => [...ss, { propertyId: "title", direction: "asc" }])} className="self-start rounded px-2 py-1 text-accent hover:bg-accent-soft">
        + Add sort
      </button>
    </div>
  );
}

export function ViewSettings({ schema, view, update, onDelete }: { schema: DatabaseSchema; view: ViewDef; update: Update; onDelete?: () => void }) {
  const groupable = schema.properties.filter((p) => p.type === "select" || p.type === "status");
  const dates = schema.properties.filter((p) => p.type === "date");
  return (
    <div className="flex w-72 max-w-[90vw] flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">View name</span>
        <input className={textInput} value={view.name} onChange={(e) => update(mapView(view.id, (v) => ({ ...v, name: e.target.value })))} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Layout</span>
        <select className={select} value={view.type} onChange={(e) => update(mapView(view.id, (v) => ({ ...v, type: e.target.value as ViewDef["type"] })))}>
          <option value="table">Table</option>
          <option value="board">Board</option>
          <option value="calendar">Calendar</option>
        </select>
      </label>
      {view.type === "board" && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Group by</span>
          <select className={select} value={view.groupBy ?? ""} onChange={(e) => update(mapView(view.id, (v) => ({ ...v, groupBy: e.target.value || undefined })))}>
            <option value="">Choose…</option>
            {groupable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {view.type === "calendar" && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Date property</span>
          <select className={select} value={view.dateProperty ?? ""} onChange={(e) => update(mapView(view.id, (v) => ({ ...v, dateProperty: e.target.value || undefined })))}>
            <option value="">Choose…</option>
            {dates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete} className="self-start rounded px-2 py-1 text-xs text-danger hover:bg-danger/10">
          Delete this view
        </button>
      )}
    </div>
  );
}
