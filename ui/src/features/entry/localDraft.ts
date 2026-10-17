// Web safety net (FRONTEND.md §7.2): the last few seconds of typing survive a
// lost connection or a closed tab. This is not offline mode.
import { readJSON, remove, writeJSON } from "@/lib/storage";
import type { EntryDraft } from "@/platform/types";

export type LocalDraft = EntryDraft & { baseVersion: number; savedAt: string };

/** Daily entries are keyed by date, so a draft of a not-yet-created entry is
 *  found again after a reload (its id is generated fresh each time). */
export const draftKey = (d: { id: string; entryDate: string | null }) =>
  d.entryDate ? `draft:date:${d.entryDate}` : `draft:id:${d.id}`;

export function saveLocalDraft(d: EntryDraft, baseVersion: number): void {
  writeJSON(draftKey(d), { ...d, baseVersion, savedAt: new Date().toISOString() } satisfies LocalDraft);
}

export function loadLocalDraft(key: { id: string; entryDate: string | null }): LocalDraft | null {
  return readJSON<LocalDraft | null>(draftKey(key), null);
}

export function clearLocalDraft(d: { id: string; entryDate: string | null }): void {
  remove(draftKey(d));
}
