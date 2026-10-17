import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EmptyState } from "@/components/ui";
import { DatabasePage } from "@/features/database/DatabasePage";
import { defaultSchema } from "@/lib/db";
import { longDate } from "@/lib/dates";
import { saverFor } from "@/lib/savers";
import { isConflictCopy } from "@/lib/text";
import { markCopySeen } from "@/lib/attention";
import { uuidv7 } from "@/lib/uuid";
import { store } from "@platform";
import { EntryEditor } from "./EntryEditor";

/** Any entry by id: pages, sub-pages, database records, databases and
 *  conflict copies. /entry/<new id>?new=1[&parent=<id>] starts a page. */
export function EntryPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const isNew = params.get("new") === "1";
  const parent = params.get("parent");
  const { data: entry, isPending, isError, error } = useQuery({
    queryKey: ["entry", id],
    queryFn: () => store.getEntry(id),
  });

  useEffect(() => {
    if (entry && isConflictCopy(entry.title)) markCopySeen(entry.id);
  }, [entry]);

  if (isError) return <p className="text-danger">Couldn't load this page: {(error as Error).message}</p>;
  if (isPending) return <div className="h-64 animate-pulse rounded-lg bg-accent-soft/40" aria-label="Loading" />;
  if ((!entry || entry.deletedAt) && !isNew) {
    return (
      <EmptyState>
        This page doesn't exist or was deleted. <Link to="/today" className="text-accent underline">Go to today</Link>
      </EmptyState>
    );
  }
  if (entry?.kind === "database") return <DatabasePage key={id} entry={entry} />;
  return (
    <div className="flex flex-col gap-6">
      {entry?.entryDate && !entry.parentId && (
        <p className="text-sm text-muted">
          Daily entry for <Link to={`/day/${entry.entryDate}`} className="text-accent underline">{longDate(entry.entryDate)}</Link>
        </p>
      )}
      {entry && isConflictCopy(entry.title) && (
        <p className="inline-flex w-fit items-center gap-2 rounded-full border border-warn/50 bg-warn-soft px-3 py-1 text-xs font-medium">
          Conflict copy · merge what you need, then delete it
        </p>
      )}
      <EntryEditor key={id} entry={entry ?? null} id={id} entryDate={entry?.entryDate ?? null} parentId={entry?.parentId ?? parent} defaultTitle="" />
    </div>
  );
}

/** /new-database[?parent=<id>]: creates a database with Status, Tags and Date
 *  properties and three views, then opens it. */
export function NewDatabase() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in development
    started.current = true;
    const id = uuidv7();
    const draft = {
      id, entryDate: null, kind: "database" as const, parentId: params.get("parent"), title: "Untitled database",
      body: { type: "doc", content: [] }, meta: { schema: defaultSchema() },
    };
    qc.setQueryData(["entry", id], { ...draft, version: 0, updatedAt: new Date().toISOString(), deletedAt: null });
    qc.setQueryData(["children", id], []);
    const s = saverFor(qc, id, 0);
    s.change(draft, 0);
    void s.flush().then(() => {
      requestAnimationFrame(() => document.getElementById("database-title")?.focus());
    });
    navigate(`/entry/${id}`, { replace: true });
  }, [params, navigate, qc]);
  return <div className="h-64 animate-pulse rounded-lg bg-accent-soft/40" aria-label="Creating database" />;
}
