import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronRight, FileText, LayoutTemplate, Menu, Plus, Search, Settings, Sparkles, Sun, Table2, X } from "lucide-react";
import { useEffect, useState } from "react";
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
import { isConflictCopy } from "@/lib/text";
import { toggleTheme } from "@/lib/theme";
import { uuidv7 } from "@/lib/uuid";
import { store } from "@platform";
import type { EntrySummary } from "@/platform/types";

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
  const { data: roots = [] } = useQuery({ queryKey: ["pages"], queryFn: () => store.listPages() });
  const pages = roots.filter((p) => !isConflictCopy(p.title));
  return (
    <section className="flex flex-col gap-0.5" aria-label="Pages">
      <SectionHeader title="Pages">
        <IconButton size="sm" label="New page (Ctrl+N)" onClick={() => navigate(`/entry/${uuidv7()}?new=1`)}>
          <Plus size={15} />
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

function TreeNode({ entry, depth }: { entry: { id: string; title: string; icon: string; kind: string }; depth: number }) {
  const key = `tree-open:${entry.id}`;
  const [open, setOpen] = useState(() => readJSON(key, false));
  const canOpen = entry.kind !== "database" && depth < 4;
  const { data: children = [] } = useQuery({
    queryKey: ["children", entry.id],
    queryFn: () => store.listChildren(entry.id),
    enabled: open && canOpen,
  });
  return (
    <li>
      <NavLink to={`/entry/${entry.id}`} className={({ isActive }) => `${rowClass(isActive)} !gap-1.5 !py-1`} style={{ paddingLeft: 6 + depth * 14 }}>
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
        <span className="truncate">{entry.title || "Untitled"}</span>
      </NavLink>
      {open && canOpen && children.length > 0 && (
        <ul className="flex flex-col gap-px">
          {children.map((c) => (
            <TreeNode key={c.id} entry={{ id: c.id, title: c.title, icon: c.meta.icon ?? "", kind: c.kind }} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function EntryLists() {
  const { data: recent = [] } = useQuery({ queryKey: ["recent"], queryFn: () => store.listRecent(12) });
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
