// Conflict copies sit in "Needs attention" until opened once.
import { readJSON, writeJSON } from "./storage";

const KEY = "seen-conflict-copies";

export function seenCopies(): Set<string> {
  return new Set(readJSON<string[]>(KEY, []));
}

export function markCopySeen(id: string): void {
  const seen = seenCopies();
  if (seen.has(id)) return;
  seen.add(id);
  writeJSON(KEY, [...seen].slice(-200));
  window.dispatchEvent(new Event("diary:attention"));
}
