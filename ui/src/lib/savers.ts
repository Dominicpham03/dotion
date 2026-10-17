// One Autosave per entry, shared by every view that edits it (the page
// editor, table cells, board drags, schema changes), so saves to one entry
// are always serialized and based on the latest version.
import type { QueryClient } from "@tanstack/react-query";
import { store } from "@platform";
import type { Entry } from "@/platform/types";
import { Autosave } from "./autosave";

const savers = new Map<string, Autosave>();

/** Writes a saved entry into every cached list that shows it. */
export function updateCaches(qc: QueryClient, e: Entry): void {
  qc.setQueryData(["entry", e.id], e);
  if (e.entryDate && !e.parentId) qc.setQueryData(["entry-date", e.entryDate], e);
  if (e.parentId) {
    qc.setQueryData<Entry[]>(["children", e.parentId], (list) =>
      list ? (list.some((x) => x.id === e.id) ? list.map((x) => (x.id === e.id ? e : x)) : [...list, e]) : list,
    );
  }
  void qc.invalidateQueries({ queryKey: ["recent"] });
  void qc.invalidateQueries({ queryKey: ["range"] });
  void qc.invalidateQueries({ queryKey: ["pages"] });
  void qc.invalidateQueries({ queryKey: ["backlinks"] });
}

/** The saver for an entry; version is the newest version this caller has seen. */
export function saverFor(qc: QueryClient, id: string, version: number): Autosave {
  let s = savers.get(id);
  if (!s) {
    s = new Autosave(
      (d, base) => store.saveEntry(d, base),
      {
        onSaved: (e) => updateCaches(qc, e),
        onConflict: (current, copy) => {
          updateCaches(qc, current);
          updateCaches(qc, copy);
        },
      },
      version,
    );
    savers.set(id, s);
  } else if (!s.busy() && version > s.base) {
    s.base = version;
    s.latest = null;
  }
  return s;
}

/** Saves everything pending (window closing). */
export function flushAll(): void {
  savers.forEach((s) => void s.flush());
}
