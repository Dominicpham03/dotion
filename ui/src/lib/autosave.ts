import type { Entry, EntryDraft, SaveResult } from "@/platform/types";

export type SaveState = "idle" | "editing" | "saving" | "saved" | "queued" | "error";

export interface AutosaveListener {
  onSaved?(entry: Entry, queued: boolean): void;
  onConflict?(current: Entry, copy: Entry): void;
  onState?(state: SaveState): void;
  onError?(err: unknown): void;
  onDraft?(draft: EntryDraft, baseVersion: number): void; // web: local safety net
  onClearDraft?(draft: EntryDraft): void;
}

type SaveFn = (draft: EntryDraft, baseVersion: number) => Promise<SaveResult>;

export const DELAYS = { debounce: 800, maxWait: 10_000, retry: 5_000 };

/**
 * The autosave rules from FRONTEND.md §6.2:
 *  1. save 800 ms after the last change, and at least every 10 s while typing;
 *  2. flush() saves immediately (blur, route change, close, Ctrl+S);
 *  3. one save in flight per entry: changes made meanwhile are sent next,
 *     based on the version the first save returned;
 *  4. base tracks the server version the edits are based on.
 *
 * One instance exists per entry (see savers.ts), shared by every view that
 * edits it, so a table cell and the open page never race each other.
 */
export class Autosave {
  base: number;
  /** The newest draft: pending, in flight, or last saved. */
  latest: EntryDraft | null = null;
  state: SaveState = "idle";
  private pending: EntryDraft | null = null;
  private inFlight = false;
  private debounce?: ReturnType<typeof setTimeout>;
  private maxWait?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private listeners = new Set<AutosaveListener>();

  constructor(
    private save: SaveFn,
    listener: AutosaveListener,
    initialVersion: number,
  ) {
    this.base = initialVersion;
    this.listeners.add(listener);
  }

  /** Adds a listener; returns its removal. */
  on(l: AutosaveListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit<K extends keyof AutosaveListener>(k: K, ...args: Parameters<NonNullable<AutosaveListener[K]>>): void {
    this.listeners.forEach((l) => (l[k] as ((...a: unknown[]) => void) | undefined)?.(...args));
  }

  private setState(s: SaveState) {
    this.state = s;
    this.emit("onState", s);
  }

  change(draft: EntryDraft, delay = DELAYS.debounce): void {
    this.pending = draft;
    this.latest = draft;
    this.emit("onDraft", draft, this.base);
    this.setState("editing");
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush(), delay);
    this.maxWait ??= setTimeout(() => {
      this.maxWait = undefined;
      void this.flush();
    }, DELAYS.maxWait);
  }

  /** Applies fn to the newest draft (or fallback, if nothing is pending) and saves. */
  edit(fallback: EntryDraft, fn: (d: EntryDraft) => EntryDraft, delay = 300): void {
    this.change(fn(this.latest ?? fallback), delay);
  }

  /** True while a save is running or changes are waiting. */
  busy(): boolean {
    return this.inFlight || this.pending !== null;
  }

  /** A newer copy arrived from elsewhere: adopt its version if nothing local is waiting. */
  adopt(entry: Entry): boolean {
    if (this.busy() || entry.version <= this.base) return false;
    this.base = entry.version;
    this.latest = null;
    return true;
  }

  async flush(): Promise<void> {
    clearTimeout(this.debounce);
    clearTimeout(this.maxWait);
    clearTimeout(this.retry);
    this.maxWait = undefined;
    if (this.inFlight || !this.pending) return;

    const draft = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.setState("saving");
    let ok = false;
    try {
      const r = await this.save(draft, this.base);
      if (r.status === "conflict") {
        this.base = r.current.version;
        // Changes made while the losing save was in flight belong in the copy too.
        const later = this.pending as EntryDraft | null;
        if (later) {
          this.pending = null;
          await this.save({ ...later, id: r.copy.id, title: r.copy.title, entryDate: null }, r.copy.version);
        }
        this.latest = null;
        this.emit("onConflict", r.current, r.copy);
        this.setState("saved");
      } else {
        this.base = r.entry.version;
        this.emit("onSaved", r.entry, r.status === "queued");
        this.setState(r.status === "queued" ? "queued" : "saved");
      }
      this.emit("onClearDraft", draft);
      ok = true;
    } catch (err) {
      this.pending ??= draft; // keep it for the next attempt
      this.setState("error");
      this.emit("onError", err);
      if (!this.disposed) this.retry = setTimeout(() => void this.flush(), DELAYS.retry);
    } finally {
      this.inFlight = false;
    }
    if (ok && this.pending && !this.disposed) await this.flush(); // changed during the save
  }

  /** Allows retries again after dispose() (React remounts in development). */
  revive(): void {
    this.disposed = false;
  }

  /** Stops timers; a final flush() is still allowed. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.debounce);
    clearTimeout(this.maxWait);
    clearTimeout(this.retry);
  }
}
