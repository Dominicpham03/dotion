// The Android sync engine: a TypeScript port of desktop/internal/syncclient.
// Push the outbox, then pull until caught up; images up before entries and
// down after. Android has no live stream here, so it syncs on changes, when
// the app comes to the foreground or back online, and every 30 s.
import type { SyncStatus } from "../types";
import { Api, fromWire, HttpError, isNetwork } from "./api";
import { KEY, type LocalStore, type OutboxRow } from "./local";

export type EngineEvents = {
  changed(ids: string[]): void;
  status(s: SyncStatus): void;
  conflict(id: string, copyId: string): void;
  images(hashes: string[]): void;
};

class AuthFailed extends Error {}

export const backoff = (n: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, n - 1));

export class Engine {
  status: SyncStatus = { state: "disconnected" };
  private running = false;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  idleMs = 30_000;

  constructor(
    private local: LocalStore,
    private on: EngineEvents,
    private makeApi: (base: string, token: string) => Api = (b, t) => new Api(b, t),
  ) {}

  private setStatus(s: SyncStatus) {
    this.status = s;
    this.on.status(s);
  }

  private api(): Api | null {
    const url = this.local.getState(KEY.serverUrl);
    return url ? this.makeApi(url, this.local.getState(KEY.token)) : null;
  }

  /** Runs a sync soon; calls during a sync queue exactly one more. */
  nudge(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), 50);
  }

  /** Starts syncing in the background. */
  start(): void {
    const wake = () => document.visibilityState !== "hidden" && this.nudge();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
    if (typeof window !== "undefined") window.addEventListener("online", wake);
    this.nudge();
  }

  private async loop(): Promise<void> {
    this.running = true;
    let wait = this.idleMs;
    try {
      await this.syncOnce();
      this.failures = 0;
    } catch (e) {
      this.failures++;
      if (!(e instanceof AuthFailed)) wait = backoff(this.failures);
    } finally {
      this.running = false;
    }
    if (this.again) {
      this.again = false;
      wait = 50;
    }
    clearTimeout(this.timer);
    if (typeof document === "undefined" || document.visibilityState !== "hidden" || wait < this.idleMs) {
      this.timer = setTimeout(() => void this.loop(), wait);
    }
  }

  /** One full sync. Throws on failure after setting the status. */
  async syncOnce(): Promise<void> {
    const api = this.api();
    if (!api) {
      this.setStatus({ state: "disconnected" });
      return;
    }
    this.setStatus({ state: "syncing", pending: this.local.pendingCount() });
    try {
      await this.pushBlobs(api);
      await this.push(api);
      await this.pull(api);
      await this.pullBlobs(api);
      const at = new Date().toISOString();
      await this.local.setState(KEY.lastSyncAt, at);
      this.setStatus({ state: "synced", at, pending: this.local.pendingCount() });
    } catch (e) {
      if (e instanceof AuthFailed) this.setStatus({ state: "error", message: "Sign in again to keep syncing.", pending: this.local.pendingCount() });
      else if (isNetwork(e)) this.setStatus({ state: "offline", pending: this.local.pendingCount() });
      else this.setStatus({ state: "error", message: (e as Error).message, pending: this.local.pendingCount() });
      throw e;
    }
  }

  private auth(e: unknown): boolean {
    return e instanceof HttpError && (e.status === 401 || e.status === 403);
  }

  private async push(api: Api): Promise<void> {
    for (let round = 0; round < 3; round++) {
      let again = false;
      for (const row of this.local.due()) again = (await this.pushOne(api, row)) || again;
      if (!again) return;
    }
  }

  /** Returns true when the row was re-queued and is due again right away. */
  private async pushOne(api: Api, row: OutboxRow): Promise<boolean> {
    try {
      if (row.op === "delete") {
        if (row.baseVersion === 0) {
          await this.local.pushNotFound(row); // the server never had it
          return false;
        }
        const e = await api.delete(row.entryId, row.idemKey, row.baseVersion);
        await this.local.pushSucceeded(row, e);
        return false;
      }
      const e = await api.put(row.entryId, row.idemKey, row.baseVersion, row.payload!);
      await this.local.pushSucceeded(row, e);
      this.on.changed([row.entryId]);
      return false;
    } catch (err) {
      if (err instanceof HttpError && err.status === 409 && err.code === "conflict" && err.body.current) {
        const copyId = await this.local.pushConflict(row, fromWire(err.body.current as never));
        this.on.changed(copyId ? [row.entryId, copyId] : [row.entryId]);
        if (copyId) this.on.conflict(row.entryId, copyId);
        return !!copyId; // push the copy in the next round
      }
      if (err instanceof HttpError && err.status === 404) {
        await this.local.pushNotFound(row);
        return true;
      }
      if (this.auth(err)) throw new AuthFailed();
      if (err instanceof HttpError && err.status < 500) {
        await this.local.pushFailed(row, err.message, true, Date.now());
        return false;
      }
      await this.local.pushFailed(row, (err as Error).message, false, Date.now() + backoff(row.attempts + 1));
      throw err;
    }
  }

  private async pull(api: Api): Promise<void> {
    let cursor = Number(this.local.getState(KEY.cursor) || 0);
    let reset = false;
    for (;;) {
      let page;
      try {
        page = await api.sync(cursor);
      } catch (err) {
        if (err instanceof HttpError && err.code === "cursor_ahead" && !reset) {
          // The server was restored from a backup: pull everything again; unsent edits stay queued.
          cursor = 0;
          reset = true;
          continue;
        }
        if (this.auth(err)) throw new AuthFailed();
        throw err;
      }
      const ids = await this.local.applyPull(page.changes, page.cursor);
      if (ids.length) this.on.changed(ids);
      cursor = page.cursor;
      if (!page.hasMore) return;
    }
  }

  private async pushBlobs(api: Api): Promise<void> {
    for (const h of this.local.blobsToUpload()) {
      const b = await this.local.getBlob(h);
      if (!b) continue;
      try {
        await api.uploadBlob(b.data, b.type);
        await this.local.markUploaded(h);
      } catch (err) {
        if (this.auth(err)) throw new AuthFailed();
        if (err instanceof HttpError && err.status < 500) await this.local.markUploaded(h); // rejected: don't retry forever
        else throw err;
      }
    }
  }

  private async pullBlobs(api: Api): Promise<void> {
    const got: string[] = [];
    for (const h of [...this.local.wanted]) {
      try {
        const { data, type } = await api.downloadBlob(h);
        await this.local.putBlob(data, type, true);
        got.push(h);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) await this.local.dropWanted(h);
        else if (this.auth(err)) throw new AuthFailed();
        else throw err;
      }
    }
    if (got.length) this.on.images(got);
  }
}
