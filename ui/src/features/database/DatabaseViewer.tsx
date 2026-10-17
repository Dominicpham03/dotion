import { ArrowUpDown, CalendarDays, Columns3, ListFilter, Plus, Settings2, SlidersHorizontal, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover } from "@/components/Popover";
import { applyView, newOptionId, newViewId, OPTION_COLORS, presetFromView } from "@/lib/db";
import { todayLocal } from "@/lib/dates";
import type { PropertyDef, ViewDef } from "@/platform/types";
import { FilterPanel, PropertiesPanel, SortPanel, ViewSettings } from "./panels";
import type { DatabaseApi } from "./useDatabase";
import { BoardView, CalendarView, TableView } from "./views";

type Panel = "filter" | "sort" | "properties" | "view" | "add" | null;

const btn = "relative inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink";
const activeBtn = "bg-accent-soft !text-accent";
const VIEW_ICONS = { table: Table2, board: Columns3, calendar: CalendarDays } as const;
function ViewIcon({ type }: { type: ViewDef["type"] }) {
  const Icon = VIEW_ICONS[type];
  return <Icon size={14} className="opacity-70" aria-hidden />;
}

const count = (n: number) => (n ? <span className="rounded bg-accent-strong px-1 text-[10px] font-semibold leading-4 text-on-accent">{n}</span> : null);

/** View tabs, toolbar and the active view of a database. */
export function DatabaseViewer({ api, viewId, onViewChange, compact = false }: {
  api: DatabaseApi;
  viewId: string | null;
  onViewChange: (id: string, name: string) => void;
  compact?: boolean;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const { schema, db } = api;
  const view: ViewDef | undefined = schema.views.find((v) => v.id === viewId) ?? schema.views[0];
  const records = useMemo(() => applyView(api.records, schema, view, todayLocal()), [api.records, schema, view]);
  if (!db) return null;
  const close = () => setPanel(null);
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);

  const createOption = (prop: PropertyDef, name: string): string => {
    const opt = { id: newOptionId(), name, color: OPTION_COLORS[(prop.options?.length ?? 0) % OPTION_COLORS.length] };
    api.updateSchema((s) => ({ ...s, properties: s.properties.map((p) => (p.id === prop.id ? { ...p, options: [...(p.options ?? []), opt] } : p)) }));
    return opt.id;
  };

  const addView = (type: ViewDef["type"]) => {
    const firstGroup = schema.properties.find((p) => p.type === "status" || p.type === "select");
    const firstDate = schema.properties.find((p) => p.type === "date");
    const v: ViewDef = {
      id: newViewId(), name: { table: "Table", board: "Board", calendar: "Calendar" }[type], type, filters: [], sorts: [],
      groupBy: type === "board" ? firstGroup?.id : undefined,
      dateProperty: type === "calendar" ? firstDate?.id : undefined,
    };
    api.updateSchema((s) => ({ ...s, views: [...s.views, v] }));
    onViewChange(v.id, v.name);
    close();
  };

  if (!view) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line p-4 text-sm">
        <p className="text-muted">This database has no views yet.</p>
        <button type="button" className="text-accent hover:underline" onClick={() => addView("table")}>
          + Add a table view
        </button>
      </div>
    );
  }

  const props = { api, view, records, createOption, newRecordProps: presetFromView(view, schema) };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-ink/[0.05] p-0.5" role="tablist" aria-label="Views">
          {schema.views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={v.id === view.id}
              onClick={() => onViewChange(v.id, v.name)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors ${
                v.id === view.id ? "bg-surface font-medium text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              <ViewIcon type={v.type} />
              {v.name || "Untitled view"}
            </button>
          ))}
          {!compact && (
            <span className="relative">
              <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink" aria-label="Add a view" title="Add a view" onClick={() => toggle("add")}>
                <Plus size={15} />
              </button>
              <Popover open={panel === "add"} onClose={close}>
                {(["table", "board", "calendar"] as const).map((t) => (
                  <button key={t} type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left capitalize hover:bg-ink/[0.06]" onClick={() => addView(t)}>
                    <ViewIcon type={t} />
                    {t}
                  </button>
                ))}
              </Popover>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="relative">
            <button type="button" className={`${btn} ${view.filters.length ? activeBtn : ""}`} aria-expanded={panel === "filter"} onClick={() => toggle("filter")}>
              <ListFilter size={15} /> <span className="hidden sm:inline">Filter</span> {count(view.filters.length)}
            </button>
            <Popover open={panel === "filter"} onClose={close} align="right">
              <FilterPanel schema={schema} view={view} update={api.updateSchema} />
            </Popover>
          </span>
          <span className="relative">
            <button type="button" className={`${btn} ${view.sorts.length ? activeBtn : ""}`} aria-expanded={panel === "sort"} onClick={() => toggle("sort")}>
              <ArrowUpDown size={15} /> <span className="hidden sm:inline">Sort</span> {count(view.sorts.length)}
            </button>
            <Popover open={panel === "sort"} onClose={close} align="right">
              <SortPanel schema={schema} view={view} update={api.updateSchema} />
            </Popover>
          </span>
          <span className="relative">
            <button type="button" className={btn} aria-expanded={panel === "properties"} onClick={() => toggle("properties")}>
              <SlidersHorizontal size={15} /> <span className="hidden sm:inline">Properties</span>
            </button>
            <Popover open={panel === "properties"} onClose={close} align="right">
              <PropertiesPanel schema={schema} view={view} update={api.updateSchema} databaseId={db.id} />
            </Popover>
          </span>
          <span className="relative">
            <button type="button" className={btn} aria-expanded={panel === "view"} onClick={() => toggle("view")} aria-label="View settings" title="View settings">
              <Settings2 size={15} />
            </button>
            <Popover open={panel === "view"} onClose={close} align="right">
              <ViewSettings
                schema={schema}
                view={view}
                update={api.updateSchema}
                onDelete={
                  schema.views.length > 1
                    ? () => {
                        const next = schema.views.find((v) => v.id !== view.id)!;
                        api.updateSchema((s) => ({ ...s, views: s.views.filter((v) => v.id !== view.id) }));
                        onViewChange(next.id, next.name);
                        close();
                      }
                    : undefined
                }
              />
            </Popover>
          </span>
        </div>
      </div>
      {api.loading ? (
        <div className="h-32 animate-pulse rounded-lg bg-accent-soft/40" aria-label="Loading" />
      ) : view.type === "board" ? (
        <BoardView {...props} />
      ) : view.type === "calendar" ? (
        <CalendarView {...props} />
      ) : (
        <TableView {...props} />
      )}
    </div>
  );
}
