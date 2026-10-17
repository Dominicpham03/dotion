import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner, Button, MenuItem, MoreMenu } from "@/components/ui";
import { IconPicker } from "@/features/pages/IconPicker";
import { Breadcrumbs, Backlinks } from "@/features/pages/PageRelations";
import { readJSON, writeJSON } from "@/lib/storage";
import type { Entry } from "@/platform/types";
import { DatabaseViewer } from "./DatabaseViewer";
import { useDatabase } from "./useDatabase";

/** A database as a full page: title, views and records. */
export function DatabasePage({ entry }: { entry: Entry }) {
  const api = useDatabase(entry.id);
  const navigate = useNavigate();
  const db = api.db ?? entry;
  const [viewId, setViewId] = useState<string | null>(() => readJSON<string | null>(`view:${entry.id}`, null));
  const [title, setTitle] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const n = api.records.length;

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs entry={db} />

      {confirm && (
        <Banner
          tone="warn"
          actions={
            <>
              <Button
                variant="danger"
                onClick={async () => {
                  await api.deleteDatabase();
                  navigate("/today", { replace: true });
                }}
              >
                <Trash2 size={15} /> Delete
              </Button>
              <Button onClick={() => setConfirm(false)}>Keep</Button>
            </>
          }
        >
          <p className="font-medium">
            Delete this database and its {n} {n === 1 ? "record" : "records"}?
          </p>
          <p className="text-muted">They disappear from all your devices.</p>
        </Banner>
      )}

      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <IconPicker value={db.meta.icon} fallback="▦" onChange={(icon) => api.updateDatabase({ meta: { icon } })} />
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted tabular-nums">
              {n} {n === 1 ? "record" : "records"}
            </span>
            <MoreMenu label="Database actions">
              {(close) => (
                <MenuItem
                  danger
                  icon={<Trash2 size={15} />}
                  onClick={() => {
                    close();
                    setConfirm(true);
                  }}
                >
                  Delete database
                </MenuItem>
              )}
            </MoreMenu>
          </div>
        </div>
        <input
          id="database-title"
          aria-label="Database name"
          value={title ?? db.title}
          placeholder="Untitled database"
          onFocus={() => setTitle(db.title)}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== null && title !== db.title) api.updateDatabase({ title });
            setTitle(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-full bg-transparent font-serif text-[2.4rem] font-semibold leading-tight tracking-tight placeholder:text-muted/50 focus:outline-none focus-visible:outline-none"
        />
      </header>

      <DatabaseViewer
        api={api}
        viewId={viewId}
        onViewChange={(id) => {
          setViewId(id);
          writeJSON(`view:${entry.id}`, id);
        }}
      />

      <Backlinks id={entry.id} />
    </div>
  );
}
