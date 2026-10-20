// Per-device preference for which views a brand-new database starts with.
// Stored in localStorage (like the theme/editor-size prefs in lib/theme).
import { readJSON, writeJSON } from "@/lib/storage";
import type { ViewDef } from "@/platform/types";

export type ViewType = ViewDef["type"];

export const ALL_VIEW_TYPES: ViewType[] = ["table", "board", "calendar"];
const KEY = "db-default-views";

/** The view types a new database should be created with. Defaults to all three
 *  (unchanged from before this setting existed). Always returns at least one
 *  (a Table), kept in the canonical table→board→calendar order. */
export function getDefaultViews(): ViewType[] {
  const saved = readJSON<ViewType[]>(KEY, ALL_VIEW_TYPES);
  const picked = ALL_VIEW_TYPES.filter((t) => saved.includes(t));
  return picked.length ? picked : ["table"];
}

export function setDefaultViews(types: ViewType[]): void {
  const picked = ALL_VIEW_TYPES.filter((t) => types.includes(t));
  writeJSON(KEY, picked.length ? picked : ["table"]);
}
