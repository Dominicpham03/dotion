import { useQueries, useQuery } from "@tanstack/react-query";
import { schemaOf, valueOf } from "@/lib/db";
import { isDate } from "@/lib/dates";
import { store } from "@platform";
import type { Entry } from "@/platform/types";

export interface DueItem {
  id: string; // the record's entry id
  title: string;
  databaseId: string;
}

/** Records from every database that has a calendar view, grouped by the day
 *  of that view's date property, for the days in [from, to].
 *
 *  A database opts in simply by having a calendar view — the same thing that
 *  makes its own Calendar tab work. We read the very ["children", db] and
 *  ["entry", db] caches the database views use, so editing a record's date
 *  updates the main calendar with no extra plumbing. */
export function useDueDates(from: string, to: string): Map<string, DueItem[]> {
  // Which of the user's entries are databases.
  const pagesQ = useQuery({ queryKey: ["pages"], queryFn: () => store.listPages() });
  const dbIds = (pagesQ.data ?? []).filter((p) => p.kind === "database").map((p) => p.id);

  // Each database entry carries the schema, hence its calendar views.
  const dbQueries = useQueries({
    queries: dbIds.map((id) => ({ queryKey: ["entry", id], queryFn: () => store.getEntry(id) })),
  });

  // Per database: the date property ids its calendar views point at (empty = no
  // calendar view, so the database does not appear on the main calendar).
  const dateProps = dbQueries.map((q) => {
    const db = q.data;
    if (!db || db.kind !== "database" || db.deletedAt) return [] as string[];
    const schema = schemaOf(db);
    const wanted = new Set(schema.views.filter((v) => v.type === "calendar" && v.dateProperty).map((v) => v.dateProperty as string));
    return schema.properties.filter((p) => p.type === "date" && wanted.has(p.id)).map((p) => p.id);
  });

  // Records, fetched only for databases that have a calendar view.
  const childQueries = useQueries({
    queries: dbIds.map((id, i) => ({
      queryKey: ["children", id],
      queryFn: () => store.listChildren(id),
      enabled: dateProps[i].length > 0,
    })),
  });

  const byDay = new Map<string, DueItem[]>();
  dbIds.forEach((id, i) => {
    const props = dateProps[i];
    const records = childQueries[i]?.data as Entry[] | undefined;
    if (!props.length || !records) return;
    for (const r of records) {
      if (r.deletedAt) continue;
      for (const propId of props) {
        const d = valueOf(r, propId);
        if (typeof d === "string" && isDate(d) && d >= from && d <= to) {
          byDay.set(d, [...(byDay.get(d) ?? []), { id: r.id, title: r.title, databaseId: id }]);
        }
      }
    }
  });
  return byDay;
}
