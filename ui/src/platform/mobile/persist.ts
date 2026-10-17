// Durable storage for the Android app. IndexedDB lives in the app's private
// data folder, so it survives restarts and is removed with the app.
import type { LocalEntry, OutboxRow } from "./local";

export interface BlobRecord {
  hash: string;
  type: string;
  data: Blob;
  uploaded: boolean;
}

export interface Snapshot {
  entries: LocalEntry[];
  outbox: OutboxRow[];
  state: [string, string][];
  blobs: { hash: string; type: string; uploaded: boolean }[];
  wanted: string[];
}

export interface Persist {
  load(): Promise<Snapshot>;
  putEntries(e: LocalEntry[]): Promise<void>;
  deleteEntry(id: string): Promise<void>;
  putOutbox(r: OutboxRow): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
  setState(k: string, v: string | null): Promise<void>;
  putBlob(b: BlobRecord): Promise<void>;
  getBlob(hash: string): Promise<BlobRecord | null>;
  setWanted(hash: string, wanted: boolean): Promise<void>;
}

/** In memory only: for tests. */
export class MemoryPersist implements Persist {
  entries = new Map<string, LocalEntry>();
  outbox = new Map<string, OutboxRow>();
  state = new Map<string, string>();
  blobs = new Map<string, BlobRecord>();
  wanted = new Set<string>();
  async load(): Promise<Snapshot> {
    return {
      entries: [...this.entries.values()].map((e) => structuredClone(e)),
      outbox: [...this.outbox.values()].map((r) => structuredClone(r)),
      state: [...this.state.entries()],
      blobs: [...this.blobs.values()].map(({ hash, type, uploaded }) => ({ hash, type, uploaded })),
      wanted: [...this.wanted],
    };
  }
  async putEntries(list: LocalEntry[]) {
    list.forEach((e) => this.entries.set(e.id, structuredClone(e)));
  }
  async deleteEntry(id: string) {
    this.entries.delete(id);
  }
  async putOutbox(r: OutboxRow) {
    this.outbox.set(r.entryId, structuredClone(r));
  }
  async deleteOutbox(id: string) {
    this.outbox.delete(id);
  }
  async setState(k: string, v: string | null) {
    if (v === null) this.state.delete(k);
    else this.state.set(k, v);
  }
  async putBlob(b: BlobRecord) {
    this.blobs.set(b.hash, b);
  }
  async getBlob(hash: string) {
    return this.blobs.get(hash) ?? null;
  }
  async setWanted(hash: string, wanted: boolean) {
    if (wanted) this.wanted.add(hash);
    else this.wanted.delete(hash);
  }
}

const STORES = ["entries", "outbox", "state", "blobs", "wanted"] as const;

/** IndexedDB, one object store per table. */
export class IdbPersist implements Persist {
  private db: Promise<IDBDatabase>;

  constructor(name = "diary") {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("entries", { keyPath: "id" });
        db.createObjectStore("outbox", { keyPath: "entryId" });
        db.createObjectStore("state");
        db.createObjectStore("blobs", { keyPath: "hash" });
        db.createObjectStore("wanted");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(stores: (typeof STORES)[number][], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const req = fn(t);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  private all<T>(store: (typeof STORES)[number]): Promise<T[]> {
    return this.tx<T[]>([store], "readonly", (t) => t.objectStore(store).getAll()).then((r) => r ?? []);
  }

  async load(): Promise<Snapshot> {
    const db = await this.db;
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = db.transaction("state").objectStore("state").getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const values = await this.all<string>("state");
    const blobs = await this.all<BlobRecord>("blobs");
    const wanted = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = db.transaction("wanted").objectStore("wanted").getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return {
      entries: await this.all<LocalEntry>("entries"),
      outbox: await this.all<OutboxRow>("outbox"),
      state: keys.map((k, i) => [String(k), values[i]]),
      blobs: blobs.map(({ hash, type, uploaded }) => ({ hash, type, uploaded })),
      wanted: wanted.map(String),
    };
  }

  async putEntries(list: LocalEntry[]) {
    await this.tx(["entries"], "readwrite", (t) => list.forEach((e) => t.objectStore("entries").put(e)));
  }
  async deleteEntry(id: string) {
    await this.tx(["entries"], "readwrite", (t) => t.objectStore("entries").delete(id));
  }
  async putOutbox(r: OutboxRow) {
    await this.tx(["outbox"], "readwrite", (t) => t.objectStore("outbox").put(r));
  }
  async deleteOutbox(id: string) {
    await this.tx(["outbox"], "readwrite", (t) => t.objectStore("outbox").delete(id));
  }
  async setState(k: string, v: string | null) {
    await this.tx(["state"], "readwrite", (t) => {
      if (v === null) t.objectStore("state").delete(k);
      else t.objectStore("state").put(v, k);
    });
  }
  async putBlob(b: BlobRecord) {
    await this.tx(["blobs"], "readwrite", (t) => t.objectStore("blobs").put(b));
  }
  async getBlob(hash: string) {
    return (await this.tx<BlobRecord>(["blobs"], "readonly", (t) => t.objectStore("blobs").get(hash))) ?? null;
  }
  async setWanted(hash: string, wanted: boolean) {
    await this.tx(["wanted"], "readwrite", (t) => {
      if (wanted) t.objectStore("wanted").put(true, hash);
      else t.objectStore("wanted").delete(hash);
    });
  }
}
