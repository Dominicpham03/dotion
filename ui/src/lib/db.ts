// Database logic: property defaults, value formatting, filters, sorts and
// grouping. Pure functions, so views stay simple and this stays tested.
import type {
  DatabaseSchema,
  Entry,
  EntryDraft,
  FilterOp,
  OptionColor,
  PropertyDef,
  PropType,
  PropValue,
  SelectOption,
  ViewDef,
  ViewFilter,
} from "@/platform/types";

const rand = () => Math.random().toString(36).slice(2, 8);
export const newPropId = () => `p_${rand()}`;
export const newOptionId = () => `opt_${rand()}`;
export const newViewId = () => `v_${rand()}`;

export const OPTION_COLORS: OptionColor[] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

export const PROP_TYPES: { type: PropType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" },
  { type: "status", label: "Status" },
  { type: "date", label: "Date" },
  { type: "checkbox", label: "Checkbox" },
  { type: "url", label: "URL" },
  { type: "relation", label: "Relation" },
];

export const hasOptions = (t: PropType) => t === "select" || t === "multi_select" || t === "status";

export function option(name: string, color: OptionColor): SelectOption {
  return { id: newOptionId(), name, color };
}

export function newProperty(name: string, type: PropType): PropertyDef {
  const p: PropertyDef = { id: newPropId(), name, type };
  if (type === "status") p.options = [option("Not started", "gray"), option("In progress", "blue"), option("Done", "green")];
  else if (hasOptions(type)) p.options = [];
  return p;
}

/** Remove a property (column) from the schema and scrub every reference to it
 *  from all views. The stored value in each record is left alone. */
export function deleteProperty(id: string): (s: DatabaseSchema) => DatabaseSchema {
  return (s) => ({
    ...s,
    properties: s.properties.filter((x) => x.id !== id),
    views: s.views.map((v) => ({
      ...v,
      hidden: v.hidden?.filter((x) => x !== id),
      filters: v.filters.filter((f) => f.propertyId !== id),
      sorts: v.sorts.filter((x) => x.propertyId !== id),
      groupBy: v.groupBy === id ? undefined : v.groupBy,
      dateProperty: v.dateProperty === id ? undefined : v.dateProperty,
    })),
  });
}

// A fresh database always carries Status, Tags and Date properties (so a Board
// or Calendar added later has something to group/plot on); `viewTypes` picks
// which views it opens with — defaults to all three, always at least a Table.
export function defaultSchema(viewTypes: ViewDef["type"][] = ["table", "board", "calendar"]): DatabaseSchema {
  const status = newProperty("Status", "status");
  const tags = newProperty("Tags", "multi_select");
  const date = newProperty("Date", "date");
  const make: Record<ViewDef["type"], () => ViewDef> = {
    table: () => ({ id: newViewId(), name: "Table", type: "table", filters: [], sorts: [] }),
    board: () => ({ id: newViewId(), name: "Board", type: "board", groupBy: status.id, filters: [], sorts: [] }),
    calendar: () => ({ id: newViewId(), name: "Calendar", type: "calendar", dateProperty: date.id, filters: [], sorts: [] }),
  };
  const order: ViewDef["type"][] = ["table", "board", "calendar"];
  const chosen = order.filter((t) => viewTypes.includes(t));
  return {
    properties: [status, tags, date],
    views: (chosen.length ? chosen : ["table"]).map((t) => make[t]()),
  };
}

export function schemaOf(db: Entry | null | undefined): DatabaseSchema {
  return db?.meta.schema ?? { properties: [], views: [] };
}

export const valueOf = (rec: Entry, propId: string): PropValue => rec.meta.props?.[propId] ?? null;

/** A draft of rec with one property changed. */
export function withProp(rec: EntryDraft, propId: string, value: PropValue): EntryDraft {
  const props = { ...(rec.meta.props ?? {}) };
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) delete props[propId];
  else props[propId] = value;
  return { ...rec, meta: { ...rec.meta, props } };
}

export function toDraft(e: Entry): EntryDraft {
  return { id: e.id, entryDate: e.entryDate, kind: e.kind, parentId: e.parentId, title: e.title, body: e.body, meta: e.meta };
}

export function isEmpty(v: PropValue): boolean {
  return v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/** Display text for a value; titles resolves relation ids. */
export function formatValue(p: PropertyDef, v: PropValue, titles?: (id: string) => string): string {
  if (isEmpty(v) && p.type !== "checkbox") return "";
  const opt = (id: string) => p.options?.find((o) => o.id === id)?.name ?? "";
  switch (p.type) {
    case "select":
    case "status":
      return typeof v === "string" ? opt(v) : "";
    case "multi_select":
      return Array.isArray(v) ? v.map(opt).filter(Boolean).join(", ") : "";
    case "relation":
      return Array.isArray(v) ? v.map((id) => titles?.(id) || "Untitled").join(", ") : "";
    case "checkbox":
      return v === true ? "Yes" : "No";
    default:
      return String(v);
  }
}

export const FILTER_OPS: Record<PropType | "title", { op: FilterOp; label: string }[]> = {
  title: [
    { op: "contains", label: "contains" },
    { op: "empty", label: "is empty" },
    { op: "not_empty", label: "is not empty" },
  ],
  text: [
    { op: "contains", label: "contains" },
    { op: "empty", label: "is empty" },
    { op: "not_empty", label: "is not empty" },
  ],
  url: [
    { op: "contains", label: "contains" },
    { op: "empty", label: "is empty" },
    { op: "not_empty", label: "is not empty" },
  ],
  number: [
    { op: "is", label: "=" },
    { op: "gt", label: ">" },
    { op: "lt", label: "<" },
    { op: "empty", label: "is empty" },
  ],
  select: [
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
    { op: "empty", label: "is empty" },
    { op: "not_empty", label: "is not empty" },
  ],
  status: [
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
  ],
  multi_select: [
    { op: "contains", label: "has" },
    { op: "empty", label: "is empty" },
    { op: "not_empty", label: "is not empty" },
  ],
  date: [
    { op: "is", label: "is" },
    { op: "before", label: "is before" },
    { op: "after", label: "is after" },
    { op: "empty", label: "is empty" },
    { op: "not_empty", label: "is not empty" },
  ],
  checkbox: [
    { op: "is", label: "is checked" },
    { op: "is_not", label: "is not checked" },
  ],
  relation: [
    { op: "contains", label: "includes" },
    { op: "empty", label: "is empty" },
    { op: "not_empty", label: "is not empty" },
  ],
};

function matches(f: ViewFilter, rec: Entry, p: PropertyDef | undefined, today: string): boolean {
  const v: PropValue = f.propertyId === "title" ? rec.title : valueOf(rec, f.propertyId);
  const type: PropType = f.propertyId === "title" ? "text" : (p?.type ?? "text");
  const want = f.value ?? null;
  switch (f.op) {
    case "empty":
      return type === "checkbox" ? v !== true : isEmpty(v);
    case "not_empty":
      return !isEmpty(v);
  }
  if (type === "checkbox") return f.op === "is" ? v === true : v !== true;
  if (want === null || want === "") return true; // an unfinished filter hides nothing
  const target = want === "today" && type === "date" ? today : want;
  switch (f.op) {
    case "is":
      return type === "number" ? Number(v) === Number(target) : v === target;
    case "is_not":
      return v !== target;
    case "contains":
      if (Array.isArray(v)) return v.includes(String(target));
      return typeof v === "string" && v.toLowerCase().includes(String(target).toLowerCase());
    case "before":
      return typeof v === "string" && v !== "" && v < String(target);
    case "after":
      return typeof v === "string" && v !== "" && v > String(target);
    case "gt":
      return typeof v === "number" && v > Number(target);
    case "lt":
      return typeof v === "number" && v < Number(target);
  }
  return true;
}

function sortKey(rec: Entry, propId: string, schema: DatabaseSchema): string | number | null {
  if (propId === "title") return rec.title.toLowerCase();
  if (propId === "updated") return rec.updatedAt;
  if (propId === "created") return rec.id; // UUID v7 ids are time-ordered
  const p = schema.properties.find((x) => x.id === propId);
  const v = valueOf(rec, propId);
  if (isEmpty(v) && p?.type !== "checkbox") return null;
  if (p && (p.type === "select" || p.type === "status")) {
    const i = p.options?.findIndex((o) => o.id === v) ?? -1; // option order, not alphabetical
    return i < 0 ? null : i;
  }
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return p ? formatValue(p, v).toLowerCase() : String(v);
}

/** Records shown by a view, filtered and sorted. Empty values sort last. */
export function applyView(records: Entry[], schema: DatabaseSchema, view: ViewDef | undefined, today: string): Entry[] {
  if (!view) return records;
  const props = new Map(schema.properties.map((p) => [p.id, p]));
  // Only "active" filters count. An unfinished filter (needs a value but has
  // none) is ignored, so in "match any" (OR) mode it can't force every record in.
  const active = view.filters.filter((f) => {
    if (f.op === "empty" || f.op === "not_empty") return true;
    const type = f.propertyId === "title" ? "text" : (props.get(f.propertyId)?.type ?? "text");
    if (type === "checkbox") return true;
    const want = f.value ?? null;
    return want !== null && want !== "";
  });
  const keep = (r: Entry) => {
    if (active.length === 0) return true;
    const test = (f: ViewFilter) => matches(f, r, props.get(f.propertyId), today);
    return view.filterOp === "or" ? active.some(test) : active.every(test);
  };
  const out = records.filter(keep);
  const sorts = view.sorts.length ? view.sorts : [{ propertyId: "created", direction: "asc" as const }];
  return out.sort((a, b) => {
    for (const s of sorts) {
      const x = sortKey(a, s.propertyId, schema);
      const y = sortKey(b, s.propertyId, schema);
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = x < y ? -1 : 1;
      return s.direction === "asc" ? c : -c;
    }
    return 0;
  });
}

/** Board columns: one per option, plus "No value" when any record lacks one. */
export function groupRecords(records: Entry[], p: PropertyDef | undefined): { option: SelectOption | null; records: Entry[] }[] {
  if (!p) return [{ option: null, records }];
  const groups = (p.options ?? []).map((o) => ({ option: o as SelectOption | null, records: [] as Entry[] }));
  const none: Entry[] = [];
  for (const r of records) {
    const v = valueOf(r, p.id);
    const ids = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    const hits = groups.filter((g) => g.option && ids.includes(g.option.id));
    if (hits.length === 0) none.push(r);
    hits.forEach((g) => g.records.push(r));
  }
  return none.length ? [{ option: null, records: none }, ...groups] : groups;
}

/** Values a new record gets when created from a filtered view or a board column. */
export function presetFromView(view: ViewDef | undefined, schema: DatabaseSchema): Record<string, PropValue> {
  const props: Record<string, PropValue> = {};
  for (const f of view?.filters ?? []) {
    const p = schema.properties.find((x) => x.id === f.propertyId);
    if (!p || f.value == null || f.value === "") continue;
    if (f.op === "is" && p.type !== "checkbox") props[p.id] = f.value;
    if (f.op === "is" && p.type === "checkbox") props[p.id] = true;
    if (f.op === "contains" && (p.type === "multi_select" || p.type === "relation")) props[p.id] = [String(f.value)];
  }
  return props;
}

export const OPTION_STYLES: Record<OptionColor, string> = {
  gray: "bg-[rgb(var(--opt-gray))]",
  brown: "bg-[rgb(var(--opt-brown))]",
  orange: "bg-[rgb(var(--opt-orange))]",
  yellow: "bg-[rgb(var(--opt-yellow))]",
  green: "bg-[rgb(var(--opt-green))]",
  blue: "bg-[rgb(var(--opt-blue))]",
  purple: "bg-[rgb(var(--opt-purple))]",
  pink: "bg-[rgb(var(--opt-pink))]",
  red: "bg-[rgb(var(--opt-red))]",
};
