import { useEffect, useState } from "react";
import { Popover } from "@/components/Popover";
import { formatValue, OPTION_STYLES } from "@/lib/db";
import { openExternal } from "@/lib/external";
import type { PropertyDef, PropValue, SelectOption } from "@/platform/types";
import { useRelationTargets } from "./useDatabase";

type Props = {
  prop: PropertyDef;
  value: PropValue;
  onChange: (v: PropValue) => void;
  /** Adds an option to a select property; returns its id. */
  onCreateOption: (prop: PropertyDef, name: string) => string;
  label?: string; // accessible name, e.g. "Status of Write spec"
};

export function OptionChip({ option }: { option: SelectOption }) {
  return (
    <span className={`inline-flex max-w-full items-center truncate rounded-md px-2 py-0.5 text-xs font-medium text-ink ${OPTION_STYLES[option.color]}`}>
      {option.name}
    </span>
  );
}

const cellInput =
  "h-8 w-full min-w-0 rounded-md bg-transparent px-2 text-sm transition-colors hover:bg-ink/[0.05] focus:bg-surface focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent-strong/60";

/** Edits one property value, in a table cell or the record page. */
export function PropertyCell({ prop, value, onChange, onCreateOption, label }: Props) {
  const name = label ?? prop.name;
  switch (prop.type) {
    case "checkbox":
      return (
        <input
          type="checkbox"
          aria-label={name}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="align-middle"
        />
      );
    case "date":
      return (
        <input
          type="date"
          aria-label={name}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
          className={cellInput}
        />
      );
    case "select":
    case "status":
    case "multi_select":
      return <OptionPicker prop={prop} value={value} onChange={onChange} onCreateOption={onCreateOption} label={name} />;
    case "relation":
      return <RelationPicker prop={prop} value={value} onChange={onChange} label={name} />;
    default:
      return <TextLike prop={prop} value={value} onChange={onChange} label={name} />;
  }
}

/** text, number and url: edited locally, saved on blur or Enter. */
function TextLike({ prop, value, onChange, label }: { prop: PropertyDef; value: PropValue; onChange: (v: PropValue) => void; label: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const t = text.trim();
    const v: PropValue = t === "" ? null : prop.type === "number" ? (Number.isFinite(Number(t)) ? Number(t) : null) : t;
    if (v !== value) onChange(v);
  };
  return (
    <span className="flex items-center gap-1">
      <input
        type={prop.type === "number" ? "number" : prop.type === "url" ? "url" : "text"}
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        className={`${cellInput} ${prop.type === "number" ? "text-right tabular-nums" : ""}`}
      />
      {prop.type === "url" && typeof value === "string" && /^https?:\/\//.test(value) && (
        <button type="button" title="Open link" aria-label={`Open ${value}`} onClick={() => openExternal(value)} className="shrink-0 rounded px-1 text-accent hover:bg-accent-soft">
          ↗
        </button>
      )}
    </span>
  );
}

function OptionPicker({ prop, value, onChange, onCreateOption, label }: Props & { label: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const multi = prop.type === "multi_select";
  const selected = multi ? (Array.isArray(value) ? value : []) : typeof value === "string" ? [value] : [];
  const options = prop.options ?? [];
  const shown = options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));

  const toggle = (id: string) => {
    if (multi) onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else {
      onChange(selected[0] === id ? null : id);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${label}: ${formatValue(prop, value) || "empty"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-ink/[0.05]"
      >
        {selected.length === 0 && <span className="text-sm text-muted/50 opacity-0 transition-opacity group-hover:opacity-100">Empty</span>}
        {selected.map((id) => {
          const o = options.find((x) => x.id === id);
          return o ? <OptionChip key={id} option={o} /> : null;
        })}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-60">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) {
              e.preventDefault();
              const hit = options.find((o) => o.name.toLowerCase() === query.trim().toLowerCase());
              toggle(hit ? hit.id : onCreateOption(prop, query.trim()));
              setQuery("");
            }
          }}
          placeholder="Find or create an option"
          aria-label="Find or create an option"
          className="mb-1 h-8 w-full rounded border border-line bg-paper px-2"
        />
        <ul role="listbox" aria-multiselectable={multi} className="max-h-56 overflow-y-auto">
          {shown.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                role="option"
                aria-selected={selected.includes(o.id)}
                onClick={() => toggle(o.id)}
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-accent-soft"
              >
                <OptionChip option={o} />
                {selected.includes(o.id) && <span aria-hidden>✓</span>}
              </button>
            </li>
          ))}
          {query.trim() && !options.some((o) => o.name.toLowerCase() === query.trim().toLowerCase()) && (
            <li>
              <button
                type="button"
                onClick={() => {
                  toggle(onCreateOption(prop, query.trim()));
                  setQuery("");
                }}
                className="w-full rounded px-1.5 py-1 text-left text-accent hover:bg-accent-soft"
              >
                + Create “{query.trim()}”
              </button>
            </li>
          )}
          {!query && options.length === 0 && <li className="px-1.5 py-1 text-muted">Type to create the first option.</li>}
        </ul>
      </Popover>
    </div>
  );
}

function RelationPicker({ prop, value, onChange, label }: { prop: PropertyDef; value: PropValue; onChange: (v: PropValue) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { items, title } = useRelationTargets(prop.relationDatabaseId);
  const ids = Array.isArray(value) ? value : [];
  const shown = items.filter((i) => (i.title || "Untitled").toLowerCase().includes(query.toLowerCase())).slice(0, 30);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${label}: ${ids.map(title).join(", ") || "empty"}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-ink/[0.05]"
      >
        {ids.length === 0 && <span className="text-sm text-muted/50 opacity-0 transition-opacity group-hover:opacity-100">Empty</span>}
        {ids.map((id) => (
          <span key={id} className="max-w-full truncate rounded border border-line px-1.5 py-0.5 text-xs">
            ↗ {title(id)}
          </span>
        ))}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-64">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a page"
          aria-label="Find a page"
          className="mb-1 h-8 w-full rounded border border-line bg-paper px-2"
        />
        <ul className="max-h-56 overflow-y-auto">
          {shown.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                aria-pressed={ids.includes(i.id)}
                onClick={() => onChange(ids.includes(i.id) ? ids.filter((x) => x !== i.id) : [...ids, i.id])}
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-accent-soft"
              >
                <span className="truncate">
                  {i.icon ? `${i.icon} ` : ""}
                  {i.title || "Untitled"}
                </span>
                {ids.includes(i.id) && <span aria-hidden>✓</span>}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-1.5 py-1 text-muted">No matching pages.</li>}
        </ul>
      </Popover>
    </div>
  );
}
