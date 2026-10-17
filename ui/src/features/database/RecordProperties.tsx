import { newOptionId, OPTION_COLORS } from "@/lib/db";
import type { EntryMeta, PropertyDef, PropValue } from "@/platform/types";
import { PropertyCell } from "./PropertyCell";
import { PropIcon } from "./propIcons";
import { useDatabase } from "./useDatabase";

/** The property list at the top of a database record's page. */
export function RecordProperties({ databaseId, meta, onChange }: {
  databaseId: string;
  meta: EntryMeta;
  onChange: (propId: string, value: PropValue) => void;
}) {
  const api = useDatabase(databaseId);
  if (!api.db) return null;
  const createOption = (prop: PropertyDef, name: string) => {
    const opt = { id: newOptionId(), name, color: OPTION_COLORS[(prop.options?.length ?? 0) % OPTION_COLORS.length] };
    api.updateSchema((s) => ({ ...s, properties: s.properties.map((p) => (p.id === prop.id ? { ...p, options: [...(p.options ?? []), opt] } : p)) }));
    return opt.id;
  };
  if (!api.schema.properties.length) return null;
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-0.5 py-1 text-sm">
      {api.schema.properties.map((p) => (
        <div key={p.id} className="contents">
          <dt className="flex items-center gap-2 truncate px-2 text-muted">
            <PropIcon type={p.type} /> {p.name}
          </dt>
          <dd className="group min-w-0">
            <PropertyCell prop={p} value={meta.props?.[p.id] ?? null} onChange={(v) => onChange(p.id, v)} onCreateOption={createOption} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
