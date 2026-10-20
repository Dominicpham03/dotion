import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronRight, FileText, FolderPlus, LayoutTemplate, Menu, MoreHorizontal, Plus, Search, Settings, Sparkles, Sun, Table2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { SyncBadge } from "@/components/SyncBadge";
import { IconButton } from "@/components/ui";
import { AskPanel, useAiStatus } from "@/features/ai/AskPanel";
import { aiName } from "@/features/ai/aiName";
import { openAsk } from "@/features/ai/askBus";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { seenCopies } from "@/lib/attention";
import { shortDate } from "@/lib/dates";
import { flushAll } from "@/lib/savers";
import { readJSON, writeJSON } from "@/lib/storage";
import { isFolder } from "@/lib/folders";
import { isConflictCopy } from "@/lib/text";
import { toggleTheme } from "@/lib/theme";
import { uuidv7 } from "@/lib/uuid";
import { store } from "@platform";
import type { EntrySummary } from "@/platform/types";
import type { QueryClient } from "@tanstack/react-query";

// --- drag a page into a folder ------------------------------------------------
// The id of the page currently being dragged in the sidebar (null when idle).
// Kept at module scope because dataTransfer contents can't be read during
// dragover, so each node needs to know what's in flight to decide if it's a
// valid drop target.
let draggingId: string | null = null;

// True when dropping `dragId` onto `targetId` would nest a page inside itself
// or one of its own descendants (which would create a cycle in the tree).
async function wouldCycle(dragId: string, targetId: string | null): Promise<boolean> {
  let cur = targetId;
  for (let i = 0; cur && i < 12; i++) {
    if (cur === dragId) return true;
    cur = (await store.getEntry(cur))?.parentId ?? null;
  }
  return false;
}

// Move a page under a new parent (null = top level) and refresh the tree.
async function movePage(id: string, targetParentId: string | null, qc: QueryClient): Promise<void> {
  if (id === targetParentId || (await wouldCycle(id, targetParentId))) return;
  const full = await store.getEntry(id);
  if (!full || full.parentId === targetParentId) return;
  const oldParent = full.parentId;
  await store.saveEntry(
    { id: full.id, entryDate: full.entryDate, kind: full.kind, parentId: targetParentId, title: full.title, body: full.body, meta: full.meta },
    full.version,
  );
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["pages"] }),
    qc.invalidateQueries({ queryKey: ["recent"] }),
    targetParentId ? qc.invalidateQueries({ queryKey: ["children", targetParentId] }) : Promise.resolve(),
    oldParent ? qc.invalidateQueries({ queryKey: ["children", oldParent] }) : Promise.resolve(),
  ]);
}

// Soft-delete a page from the sidebar: it moves to Trash (recoverable), and the
// tree, recent list and trash refresh.
async function deletePage(id: string, qc: QueryClient): Promise<void> {
  const full = await store.getEntry(id);
  if (!full) return;
  await store.deleteEntry(id, full.version);
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["pages"] }),
    qc.invalidateQueries({ queryKey: ["recent"] }),
    qc.invalidateQueries({ queryKey: ["trash"] }),
    full.parentId ? qc.invalidateQueries({ queryKey: ["children", full.parentId] }) : Promise.resolve(),
  ]);
}

export function Layout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const sync = useSyncStatus();
  const ai = useAiStatus();

  // Desktop first run: ask for the server unless the user chose offline-only.
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => store.app!.getSettings(), enabled: !!store.app });
  // Web: a 401 here sends the user to /login (see the QueryCache in App.tsx).
  useQuery({ queryKey: ["me"], queryFn: () => store.web!.me(), enabled: !!store.web, staleTime: 5 * 60_000 });

  // Reacting to changes from other devices (FRONTEND.md §4).
  useEffect(
    () =>
      store.onChanged((ids) => {
        if (ids === "all") return void qc.invalidateQueries();
        ids.forEach((id) => void qc.invalidateQueries({ queryKey: ["entry", id] }));
        for (const key of ["entry-date", "range", "recent", "settings", "children", "pages", "backlinks"]) {
          void qc.invalidateQueries({ queryKey: [key] });
        }
      }),
    [qc],
  );
  useEffect(() => store.onConflict(() => void qc.invalidateQueries({ queryKey: ["recent"] })), [qc]);
  useEffect(() => store.onFlushRequest(flushAll), []);
  // Images that finished downloading replace their broken placeholders.
  useEffect(
    () =>
      store.onImagesArrived((hashes) => {
        if (store.resolveImage) {
          document.querySelectorAll<HTMLImageElement>("img[data-src^='/v1/blobs/']").forEach((img) => {
            const src = img.dataset.src ?? "";
            if (hashes.some((h) => src.endsWith(h))) void store.resolveImage!(src).then((u) => u && (img.src = u));
          });
          return;
        }
        document.querySelectorAll<HTMLImageElement>("img[src^='/v1/blobs/']").forEach((img) => {
          const src = img.getAttribute("src") ?? "";
          if (hashes.some((h) => src.endsWith(h))) img.src = `${src.split("?")[0]}?r=${Date.now()}`;
        });
      }),
    [],
  );

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "l") {
        e.preventDefault();
        toggleTheme();
      } else if (!e.shiftKey && k === "t") {
        e.preventDefault();
        navigate("/today");
      } else if (!e.shiftKey && k === "n") {
        e.preventDefault();
        navigate(`/entry/${uuidv7()}?new=1`);
      } else if (!e.shiftKey && k === "k") {
        e.preventDefault();
        navigate("/search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => setMenuOpen(false), [location.pathname, location.search]);

  if (store.app && settings.data && !settings.data.serverUrl && !readJSON("offline-only", false)) {
    return <Navigate to="/welcome" replace />;
  }

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-paper/95 px-4 py-2.5 backdrop-blur md:hidden">
        <Brand />
        <IconButton label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="sidebar" onClick={() => setMenuOpen((o) => !o)}>
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </IconButton>
      </header>

      <aside
        id="sidebar"
        className={`${menuOpen ? "flex" : "hidden"} w-full shrink-0 flex-col gap-4 border-b border-line bg-surface/50 px-3 py-4 md:sticky md:top-0 md:flex md:h-screen md:w-64 md:border-b-0 md:border-r`}
      >
        <div className="hidden px-2 pt-1 md:block">
          <Brand />
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          <SideLink to="/today" icon={<Sun size={16} />} hint="Ctrl+T">
            Today
          </SideLink>
          <SideLink to="/calendar" icon={<CalendarDays size={16} />}>
            Calendar
          </SideLink>
          <SideLink to="/search" icon={<Search size={16} />} hint="Ctrl+K">
            Search
          </SideLink>
          {ai.data?.enabled && (
            <button type="button" onClick={() => openAsk()} className={rowClass(false)}>
              <span className="opacity-80">
                <Sparkles size={16} />
              </span>
              <span className="flex-1 text-left">Ask {aiName(ai.data)}</span>
              <kbd className="hidden font-sans text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100 md:inline">Ctrl+J</kbd>
            </button>
          )}
        </nav>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
          <PagesTree />
          <EntryLists />
        </div>
        <div className="flex flex-col gap-0.5 border-t border-line pt-3">
          <SyncBadge />
          <SideLink to="/templates" icon={<LayoutTemplate size={16} />}>
            Templates
          </SideLink>
          {typeof store.listTrash === "function" && (
            <SideLink to="/trash" icon={<Trash2 size={16} />}>
              Trash
            </SideLink>
          )}
          <SideLink to="/settings" icon={<Settings size={16} />}>
            Settings
          </SideLink>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-10 md:py-12">
        {store.platform === "web" && sync.state === "offline" && (
          <div className="mx-auto mb-4 max-w-4xl rounded-lg bg-warn-soft px-3 py-1.5 text-center text-xs" role="status">
            Reconnecting… Saving still works.
          </div>
        )}
        <div className={`mx-auto ${wide(location.pathname) ? "max-w-6xl" : "max-w-3xl"}`}>
          <Outlet />
        </div>
      </main>
      <AskPanel />
    </div>
  );
}

// Database pages and templates need room for tables and boards.
const wide = (path: string) => path.startsWith("/entry/") || path.startsWith("/templates") || path.startsWith("/new-database");

function Brand() {
  return (
    <Link to="/today" className="flex items-center gap-2.5" aria-label="Dotion home">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-strong font-serif text-sm font-bold text-on-accent shadow-sm" aria-hidden>
        D
      </span>
      <span className="font-serif text-lg font-semibold tracking-tight">Dotion</span>
    </Link>
  );
}

const rowClass = (active: boolean) =>
  `group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
    active ? "bg-accent-soft font-medium text-accent" : "text-ink/80 hover:bg-ink/[0.06] hover:text-ink"
  }`;

function SideLink({ to, icon, hint, children }: { to: string; icon: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <NavLink to={to} className={({ isActive }) => rowClass(isActive)}>
      <span className="opacity-80">{icon}</span>
      <span className="flex-1">{children}</span>
      {hint && <kbd className="hidden font-sans text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100 md:inline">{hint}</kbd>}
    </NavLink>
  );
}

function SectionHeader({ title, children, warn }: { title: string; children?: React.ReactNode; warn?: boolean }) {
  return (
    <div className="flex h-7 items-center justify-between px-2.5">
      <h2 className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${warn ? "text-warn" : "text-muted"}`}>{title}</h2>
      {children && <span className="flex gap-0.5">{children}</span>}
    </div>
  );
}

function PagesTree() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: roots = [] } = useQuery({ queryKey: ["pages"], queryFn: () => store.listPages() });
  const pages = roots.filter((p) => !isConflictCopy(p.title));
  // Dropping a page onto empty space in this section moves it back to the top level.
  const onRootDragOver = (e: React.DragEvent) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onRootDrop = (e: React.DragEvent) => {
    const id = draggingId ?? e.dataTransfer.getData("text/plain");
    draggingId = null;
    if (id) void movePage(id, null, qc);
  };
  return (
    <section className="flex flex-col gap-0.5" aria-label="Pages" onDragOver={onRootDragOver} onDrop={onRootDrop}>
      <SectionHeader title="Pages">
        <IconButton size="sm" label="New page (Ctrl+N)" onClick={() => navigate(`/entry/${uuidv7()}?new=1`)}>
          <Plus size={15} />
        </IconButton>
        <IconButton size="sm" label="New folder" onClick={() => navigate("/new-folder")}>
          <FolderPlus size={15} />
        </IconButton>
        <IconButton size="sm" label="New database" onClick={() => navigate("/new-database")}>
          <Table2 size={15} />
        </IconButton>
      </SectionHeader>
      {pages.length === 0 ? (
        <p className="px-2.5 text-xs leading-relaxed text-muted">
          No pages yet. Add one with + or start from a{" "}
          <Link to="/templates" className="text-accent underline underline-offset-2">
            template
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {pages.map((p) => (
            <TreeNode key={p.id} entry={p} depth={0} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PageIcon({ icon, kind }: { icon: string; kind: string }) {
  if (icon) return <span className="w-4 shrink-0 text-center text-[15px] leading-none">{icon}</span>;
  return kind === "database" ? <Table2 size={15} className="shrink-0 opacity-70" /> : <FileText size={15} className="shrink-0 opacity-70" />;
}

function TreeNode({ entry, depth }: { entry: { id: string; title: string; icon: string; kind: string; folder?: boolean }; depth: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const key = `tree-open:${entry.id}`;
  const [open, setOpen] = useState(() => readJSON(key, false));
  const [dropActive, setDropActive] = useState(false);
  const canOpen = entry.kind !== "database" && depth < 4;
  // Only a FOLDER holds other pages — a page is never put inside a page. So the
  // "add inside" and drop-into affordances are offered on folders only.
  const canAddChild = isFolder(entry) && depth < 4;
  const { data: children = [] } = useQuery({
    queryKey: ["children", entry.id],
    queryFn: () => store.listChildren(entry.id),
    enabled: open && canOpen,
  });
  const addChild = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
    writeJSON(key, true); // reveal the new sub-page once it saves
    navigate(`/entry/${uuidv7()}?new=1&parent=${entry.id}`);
  };
  // Drag this page onto another page to nest it there (a page acts as a folder).
  const onDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    draggingId = entry.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", entry.id);
  };
  const canAcceptDrop = canAddChild && !!draggingId && draggingId !== entry.id;
  const onDragOver = (e: React.DragEvent) => {
    if (!canAcceptDrop) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (!dropActive) setDropActive(true);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!canAddChild) return;
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    const id = draggingId ?? e.dataTransfer.getData("text/plain");
    draggingId = null;
    if (!id || id === entry.id) return;
    setOpen(true);
    writeJSON(key, true); // reveal the moved page inside this one
    void movePage(id, entry.id, qc);
  };
  // Row "⋯" menu: add a page inside, or delete the page (to Trash).
  const location = useLocation();
  const menuRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const closeMenu = () => {
    setMenuPos(null);
    setConfirmDel(false);
  };
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = menuRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: Math.min(r.left, window.innerWidth - 190), top: r.bottom + 4 });
  };
  const doDelete = () => {
    const viewing = location.pathname === `/entry/${entry.id}`;
    void deletePage(entry.id, qc).then(() => {
      if (viewing) navigate("/today");
    });
    closeMenu();
  };
  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragEnd={() => (draggingId = null)}
      onDragOver={onDragOver}
      onDragLeave={() => dropActive && setDropActive(false)}
      onDrop={onDrop}
    >
      <NavLink
        to={`/entry/${entry.id}`}
        className={({ isActive }) =>
          `${rowClass(isActive)} !gap-1.5 !py-1 ${dropActive ? "!bg-accent-soft ring-1 ring-inset ring-accent" : ""}`
        }
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <button
          type="button"
          aria-label={open ? `Collapse ${entry.title}` : `Expand ${entry.title}`}
          aria-expanded={canOpen ? open : undefined}
          disabled={!canOpen}
          onClick={(e) => {
            e.preventDefault();
            setOpen(!open);
            writeJSON(key, !open);
          }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-ink/10 disabled:invisible"
        >
          <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <PageIcon icon={entry.icon} kind={entry.kind} />
        <span className="min-w-0 flex-1 truncate">{entry.title || "Untitled"}</span>
        {canAddChild && (
          <button
            type="button"
            aria-label={`Add a page inside ${entry.title || "Untitled"}`}
            title="Add a page inside"
            onClick={addChild}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-ink/10 hover:text-ink group-hover:opacity-100"
          >
            <Plus size={14} />
          </button>
        )}
        <button
          ref={menuRef}
          type="button"
          aria-label={`More actions for ${entry.title || "Untitled"}`}
          aria-haspopup="menu"
          aria-expanded={!!menuPos}
          title="More"
          onClick={openMenu}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-ink/10 hover:text-ink group-hover:opacity-100"
        >
          <MoreHorizontal size={14} />
        </button>
      </NavLink>
      {menuPos &&
        createPortal(
          <>
            <button type="button" aria-label="Close menu" className="fixed inset-0 z-[60] cursor-default" onClick={closeMenu} />
            <div
              role="menu"
              style={{ left: menuPos.left, top: menuPos.top }}
              className="fixed z-[61] flex w-44 flex-col rounded-lg border border-line bg-surface p-1 text-sm text-ink shadow-lg"
            >
              {canAddChild && (
                <button
                  type="button"
                  role="menuitem"
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-ink/[0.06]"
                  onClick={(e) => {
                    closeMenu();
                    addChild(e);
                  }}
                >
                  <Plus size={14} /> Add page inside
                </button>
              )}
              {confirmDel ? (
                <div className="flex flex-col gap-1 rounded bg-danger/5 p-1.5">
                  <span className="px-1 text-xs text-muted">Move to Trash?</span>
                  <div className="flex gap-1">
                    <button type="button" className="flex-1 rounded px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10" onClick={doDelete}>
                      Delete
                    </button>
                    <button type="button" className="flex-1 rounded px-2 py-1 text-xs hover:bg-ink/[0.06]" onClick={() => setConfirmDel(false)}>
                      Keep
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-danger hover:bg-danger/10"
                  onClick={() => setConfirmDel(true)}
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
      {open && canOpen && children.length > 0 && (
        <ul className="flex flex-col gap-px">
          {children.map((c) => (
            <TreeNode key={c.id} entry={{ id: c.id, title: c.title, icon: c.meta.icon ?? "", kind: c.kind, folder: isFolder(c.meta) }} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function EntryLists() {
  const { data: recent = [] } = useQuery({ queryKey: ["recent"], queryFn: () => store.listRecent(5) });
  const [, rerender] = useState(0);
  useEffect(() => {
    const on = () => rerender((n) => n + 1);
    window.addEventListener("diary:attention", on);
    return () => window.removeEventListener("diary:attention", on);
  }, []);
  const seen = seenCopies();
  const attention = recent.filter((e) => isConflictCopy(e.title) && !seen.has(e.id));

  return (
    <>
      {attention.length > 0 && <EntryList title="Needs attention" entries={attention} warn />}
      <EntryList title="Recent" entries={recent} />
    </>
  );
}

function EntryList({ title, entries, warn }: { title: string; entries: EntrySummary[]; warn?: boolean }) {
  return (
    <section className="flex flex-col gap-0.5">
      <SectionHeader title={title} warn={warn} />
      {entries.length === 0 ? (
        <p className="px-2.5 text-xs text-muted">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-px">
          {entries.map((e) => (
            <li key={e.id}>
              <NavLink
                to={e.entryDate && !e.parentId ? `/day/${e.entryDate}` : `/entry/${e.id}`}
                className={({ isActive }) => rowClass(isActive)}
                title={e.preview}
              >
                <PageIcon icon={e.icon} kind={e.kind} />
                <span className="min-w-0 flex-1 truncate">{e.title || "Untitled"}</span>
                {isConflictCopy(e.title) ? (
                  <span className="shrink-0 rounded border border-warn/50 px-1 text-[10px] font-medium uppercase text-warn">copy</span>
                ) : (
                  e.entryDate && <span className="shrink-0 text-[11px] text-muted tabular-nums">{shortDate(e.entryDate).replace(/,? \d{4}$/, "")}</span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
