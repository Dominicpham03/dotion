import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, EmptyState, PageTitle } from "@/components/ui";
import { store } from "@platform";
import type { EntrySummary } from "@/platform/types";

/** The trash: pages you deleted stay here (recoverable) and are emptied
 *  automatically 15 days after deletion. Restore or delete-forever each one. */
export function TrashPage() {
  const qc = useQueryClient();
  const supported = typeof store.listTrash === "function";
  const { data = [], isPending } = useQuery({
    queryKey: ["trash"],
    queryFn: () => store.listTrash!(),
    enabled: supported,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = () =>
    Promise.all(
      ["trash", "recent", "pages", "range", "children"].map((k) => qc.invalidateQueries({ queryKey: [k] })),
    );

  const restore = async (e: EntrySummary) => {
    if (busy) return;
    setBusy(e.id);
    try {
      await store.restoreEntry!(e.id, e.version ?? 1);
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  const purge = async (e: EntrySummary) => {
    if (busy) return;
    setBusy(e.id);
    try {
      await store.purgeEntry!(e.id, e.version ?? 1);
      setConfirming(null);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!supported) return <EmptyState>The trash isn't available on this device.</EmptyState>;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>Trash</PageTitle>
      <p className="text-sm text-muted">
        Deleted pages stay here so you can restore them, and are emptied automatically 15 days after you delete them.
      </p>
      {isPending ? (
        <div className="h-32 animate-pulse rounded-lg bg-accent-soft/40" aria-label="Loading" />
      ) : data.length === 0 ? (
        <EmptyState>The trash is empty.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.map((e) => (
            <li key={e.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface/50 px-3 py-2">
              <span className="w-5 shrink-0 text-center">{e.icon || (e.kind === "database" ? "▦" : "📄")}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{e.title || "Untitled"}</span>
                {e.preview && <span className="block truncate text-xs text-muted">{e.preview}</span>}
              </span>
              {confirming === e.id ? (
                <>
                  <span className="text-xs text-muted">Delete for good?</span>
                  <Button variant="danger" onClick={() => void purge(e)} disabled={busy === e.id}>
                    {busy === e.id ? "Deleting…" : "Yes, delete"}
                  </Button>
                  <Button onClick={() => setConfirming(null)} disabled={busy === e.id}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={() => void restore(e)} disabled={busy === e.id}>
                    <RotateCcw size={14} /> {busy === e.id ? "…" : "Restore"}
                  </Button>
                  <Button variant="danger" onClick={() => setConfirming(e.id)} disabled={busy === e.id}>
                    <Trash2 size={14} /> Delete forever
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
