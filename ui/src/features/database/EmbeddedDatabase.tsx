import { Link } from "react-router-dom";
import { DatabaseViewer } from "./DatabaseViewer";
import { useDatabase } from "./useDatabase";

/** A database view embedded in a page (dashboards). Records and view settings
 *  are the database's own: editing here edits the database. */
export function EmbeddedDatabase({ databaseId, viewId, onViewChange, onRemove }: {
  databaseId: string;
  viewId: string | null;
  onViewChange: (viewId: string, title: string) => void;
  onRemove?: () => void;
}) {
  const api = useDatabase(databaseId);
  if (api.missing) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed border-line p-3 text-sm text-muted">
        This database was deleted.
        {onRemove && (
          <button type="button" className="rounded px-2 py-1 hover:bg-accent-soft" onClick={onRemove}>
            Remove view
          </button>
        )}
      </div>
    );
  }
  if (!api.db) return <div className="h-24 animate-pulse rounded-lg bg-accent-soft/40" aria-label="Loading" />;
  return (
    <section className="flex flex-col gap-2" aria-label={api.db.title || "Database"}>
      <div className="flex items-center justify-between gap-2">
        <Link to={`/entry/${api.db.id}`} className="flex items-center gap-2 font-sans text-base font-semibold text-ink hover:text-accent">
          {api.db.meta.icon || "▦"} {api.db.title || "Untitled database"}
        </Link>
        {onRemove && (
          <button type="button" className="rounded px-2 py-1 text-xs text-muted hover:bg-accent-soft hover:text-ink" onClick={onRemove}>
            Remove from page
          </button>
        )}
      </div>
      <DatabaseViewer api={api} viewId={viewId} compact onViewChange={(id, name) => onViewChange(id, `${api.db?.title ?? ""} · ${name}`)} />
    </section>
  );
}
