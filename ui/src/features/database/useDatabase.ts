import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { schemaOf, toDraft, withProp } from "@/lib/db";
import { saverFor } from "@/lib/savers";
import { uuidv7 } from "@/lib/uuid";
import { store } from "@platform";
import type { DatabaseSchema, Entry, EntryMeta, PropValue } from "@/platform/types";

/** A database, its records, and every change you can make to them. Changes
 *  show at once (optimistic) and save through the entry's shared autosave. */
export function useDatabase(databaseId: string | null | undefined) {
  const qc = useQueryClient();
  const id = databaseId ?? "";
  const dbQ = useQuery({ queryKey: ["entry", id], queryFn: () => store.getEntry(id), enabled: !!id });
  const db = dbQ.data?.kind === "database" && !dbQ.data.deletedAt ? dbQ.data : null;
  const recQ = useQuery({ queryKey: ["children", id], queryFn: () => store.listChildren(id), enabled: !!db });
  const records = useMemo(() => recQ.data ?? [], [recQ.data]);
  const schema = schemaOf(db);

  const setRecords = useCallback(
    (fn: (list: Entry[]) => Entry[]) => qc.setQueryData<Entry[]>(["children", id], (list) => fn(list ?? [])),
    [qc, id],
  );

  /** fn must be pure: generate ids before calling, not inside. */
  const updateSchema = useCallback(
    (fn: (s: DatabaseSchema) => DatabaseSchema) => {
      const cur = qc.getQueryData<Entry | null>(["entry", id]);
      if (!cur) return;
      qc.setQueryData(["entry", id], { ...cur, meta: { ...cur.meta, schema: fn(schemaOf(cur)) } });
      saverFor(qc, id, cur.version).edit(toDraft(cur), (d) => ({
        ...d,
        meta: { ...d.meta, schema: fn(d.meta.schema ?? { properties: [], views: [] }) },
      }));
    },
    [qc, id],
  );

  const updateDatabase = useCallback(
    (patch: { title?: string; meta?: Partial<EntryMeta> }) => {
      const cur = qc.getQueryData<Entry | null>(["entry", id]);
      if (!cur) return;
      const apply = <T extends { title: string; meta: EntryMeta }>(x: T): T => ({
        ...x,
        title: patch.title ?? x.title,
        meta: { ...x.meta, ...patch.meta },
      });
      qc.setQueryData(["entry", id], apply(cur));
      saverFor(qc, id, cur.version).edit(toDraft(cur), apply);
    },
    [qc, id],
  );

  const updateRecord = useCallback(
    (rec: Entry, propId: string, value: PropValue) => {
      setRecords((list) => list.map((r) => (r.id === rec.id ? { ...r, meta: withProp(toDraft(r), propId, value).meta } : r)));
      qc.setQueryData<Entry | null>(["entry", rec.id], (e) => (e ? { ...e, meta: withProp(toDraft(e), propId, value).meta } : e));
      saverFor(qc, rec.id, rec.version).edit(toDraft(rec), (d) => withProp(d, propId, value));
    },
    [qc, setRecords],
  );

  const renameRecord = useCallback(
    (rec: Entry, title: string) => {
      setRecords((list) => list.map((r) => (r.id === rec.id ? { ...r, title } : r)));
      saverFor(qc, rec.id, rec.version).edit(toDraft(rec), (d) => ({ ...d, title }));
    },
    [qc, setRecords],
  );

  const createRecord = useCallback(
    (props: Record<string, PropValue> = {}, title = ""): string => {
      const rid = uuidv7();
      const draft = { id: rid, entryDate: null, kind: "page" as const, parentId: id, title, body: { type: "doc", content: [] }, meta: { props } };
      const optimistic: Entry = { ...draft, version: 0, updatedAt: new Date().toISOString(), deletedAt: null };
      setRecords((list) => [...list, optimistic]);
      qc.setQueryData(["entry", rid], optimistic);
      saverFor(qc, rid, 0).change(draft, 0);
      return rid;
    },
    [qc, id, setRecords],
  );

  const deleteRecord = useCallback(
    async (rec: Entry) => {
      setRecords((list) => list.filter((r) => r.id !== rec.id));
      const s = saverFor(qc, rec.id, rec.version);
      await s.flush();
      if (s.base > 0) await store.deleteEntry(rec.id, s.base);
      void qc.invalidateQueries({ queryKey: ["backlinks"] });
    },
    [qc, setRecords],
  );

  /** Deletes the database and every record in it. */
  const deleteDatabase = useCallback(async () => {
    for (const r of records) await deleteRecord(r);
    const cur = qc.getQueryData<Entry | null>(["entry", id]);
    if (!cur) return;
    const s = saverFor(qc, id, cur.version);
    await s.flush();
    await store.deleteEntry(id, s.base);
    void qc.invalidateQueries();
  }, [qc, id, records, deleteRecord]);

  return {
    db,
    records,
    schema,
    loading: dbQ.isPending || (!!db && recQ.isPending),
    missing: dbQ.isFetched && !db,
    updateSchema,
    updateDatabase,
    updateRecord,
    renameRecord,
    createRecord,
    deleteRecord,
    deleteDatabase,
  };
}

export type DatabaseApi = ReturnType<typeof useDatabase>;

/** Titles and choices for a relation property. */
export function useRelationTargets(relationDatabaseId: string | undefined) {
  const rec = useQuery({
    queryKey: ["children", relationDatabaseId ?? ""],
    queryFn: () => store.listChildren(relationDatabaseId!),
    enabled: !!relationDatabaseId,
  });
  const pages = useQuery({ queryKey: ["pages"], queryFn: () => store.listPages(), enabled: !relationDatabaseId });
  const recent = useQuery({ queryKey: ["recent"], queryFn: () => store.listRecent(20), enabled: !relationDatabaseId });
  return useMemo(() => {
    const items = relationDatabaseId
      ? (rec.data ?? []).map((e) => ({ id: e.id, title: e.title, icon: e.meta.icon ?? "" }))
      : [...(pages.data ?? []), ...(recent.data ?? [])]
          .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
          .map((e) => ({ id: e.id, title: e.title, icon: e.icon }));
    const byId = new Map(items.map((i) => [i.id, i]));
    return { items, title: (id: string) => byId.get(id)?.title || "Untitled" };
  }, [relationDatabaseId, rec.data, pages.data, recent.data]);
}
