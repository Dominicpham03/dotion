import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FilePlus2, FileText, FolderPlus, Link2, Table2, TableProperties } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { shortDate } from "@/lib/dates";
import { uuidv7 } from "@/lib/uuid";
import { store } from "@platform";
import type { Entry, EntrySummary } from "@/platform/types";

const hrefOf = (e: { id: string; entryDate: string | null; parentId: string | null }) =>
  e.entryDate && !e.parentId ? `/day/${e.entryDate}` : `/entry/${e.id}`;

function Icon({ icon, kind, size = 15 }: { icon?: string; kind: string; size?: number }) {
  if (icon) return <span className="w-4 text-center leading-none">{icon}</span>;
  return kind === "database" ? <Table2 size={size} className="opacity-70" /> : <FileText size={size} className="opacity-70" />;
}

/** Parent › grandparent trail above a page. */
export function Breadcrumbs({ entry }: { entry: Entry }) {
  const chain = useParents(entry.parentId);
  if (!chain.length) return null;
  return (
    <nav aria-label="Breadcrumb" className="-mb-2 flex flex-wrap items-center gap-0.5 text-sm text-muted">
      {chain.map((p) => (
        <span key={p.id} className="flex items-center gap-0.5">
          <Link to={hrefOf(p)} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-ink/[0.06] hover:text-ink">
            <Icon icon={p.meta.icon} kind={p.kind} size={14} />
            {p.title || "Untitled"}
          </Link>
          <ChevronRight size={14} className="opacity-50" aria-hidden />
        </span>
      ))}
    </nav>
  );
}

function useParents(parentId: string | null): Entry[] {
  // At most three levels up; each level is its own cached query.
  const p1 = useQuery({ queryKey: ["entry", parentId ?? ""], queryFn: () => store.getEntry(parentId!), enabled: !!parentId });
  const id2 = p1.data?.parentId ?? null;
  const p2 = useQuery({ queryKey: ["entry", id2 ?? ""], queryFn: () => store.getEntry(id2!), enabled: !!id2 });
  const id3 = p2.data?.parentId ?? null;
  const p3 = useQuery({ queryKey: ["entry", id3 ?? ""], queryFn: () => store.getEntry(id3!), enabled: !!id3 });
  return [p3.data, p2.data, p1.data].filter((e): e is Entry => !!e && !e.deletedAt);
}

const sectionTitle = "flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted";

/** Sub-pages and databases inside a folder. Pages (non-folders) are leaves —
 *  they can't hold other pages — so the create buttons show only on folders;
 *  any existing children stay listed either way so nothing is stranded. */
export function SubPages({ id, folder }: { id: string; folder: boolean }) {
  const navigate = useNavigate();
  const { data: children = [] } = useQuery({ queryKey: ["children", id], queryFn: () => store.listChildren(id) });
  if (!folder && children.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-5" aria-label="Sub-pages">
      {children.length > 0 && (
        <>
          <h2 className={sectionTitle}>{folder ? "Inside this folder" : "Inside this page"}</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {children.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/entry/${c.id}`}
                  className="flex items-center gap-2.5 rounded-lg border border-line bg-surface/50 px-3 py-2 text-sm transition-colors hover:border-accent-strong/50 hover:bg-surface"
                >
                  <Icon icon={c.meta.icon} kind={c.kind} />
                  <span className="truncate font-medium">{c.title || "Untitled"}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {folder && (
        <div className="flex gap-1">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink"
            onClick={() => navigate(`/entry/${uuidv7()}?new=1&parent=${id}`)}
          >
            <FilePlus2 size={15} /> Page
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink"
            onClick={() => navigate(`/new-folder?parent=${id}`)}
          >
            <FolderPlus size={15} /> Folder
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink"
            onClick={() => navigate(`/new-database?parent=${id}`)}
          >
            <TableProperties size={15} /> Database
          </button>
        </div>
      )}
    </section>
  );
}

/** "Linked from": pages that link here, records that relate here, dashboards that embed this. */
export function Backlinks({ id }: { id: string }) {
  const { data = [] } = useQuery({ queryKey: ["backlinks", id], queryFn: () => store.backlinks(id) });
  if (!data.length) return null;
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-5" aria-label="Linked from">
      <h2 className={sectionTitle}>
        <Link2 size={13} /> Linked from · {data.length}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {data.map((e: EntrySummary) => (
          <li key={e.id}>
            <Link
              to={hrefOf(e)}
              className="flex h-full flex-col gap-1 rounded-lg border border-line bg-surface/50 px-3 py-2.5 transition-colors hover:border-accent-strong/50 hover:bg-surface"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon icon={e.icon} kind={e.kind} />
                <span className="truncate">{e.title || "Untitled"}</span>
                {e.entryDate && <span className="ml-auto shrink-0 text-xs font-normal text-muted">{shortDate(e.entryDate)}</span>}
              </span>
              {e.preview && <span className="line-clamp-2 text-xs leading-relaxed text-muted">{e.preview}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
