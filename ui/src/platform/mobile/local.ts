// The Android app's local database: a full copy of the entries for offline
// use, the outbox of unsent changes, and sync state. Same rules as the
// desktop's localdb (desktop/internal/localdb), kept in memory and written
// through to IndexedDB.
import { extractImages, extractLinks, metaLinks, metaText } from "@/lib/links";
import { copyTitle, extractText, isConflictCopy, preview, wordCount } from "@/lib/text";
import { uuidv7 } from "@/lib/uuid";
import type { Entry, EntryDraft, EntryKind, EntryMeta, EntrySummary, JSONContent, SearchHit } from "../types";
import type { Persist } from "./persist";

export interface LocalEntry extends Entry {
  serverSeq: number;
  createdAt: string;
}

/** The JSON body of PUT /v1/entries/{id}, minus base_version. */
export interface PutPayload {
  entry_date: string | null;
  kind: EntryKind;
  parent_id: string | null;
  title: string;
  body: JSONContent;
  meta: EntryMeta;
}

export interface OutboxRow {
  entryId: string;
  op: "put" | "delete";
  payload: PutPayload | null;
  baseVersion: number; // server version the edits started from
  rev: number; // bumped on every local edit
  idemKey: string; // new whenever rev changes
  attempts: number;
  nextTryAt: number; // ms since epoch; 0 = now
  failed: boolean; // rejected by the server: skipped until edited again
  lastError: string;
}

export const KEY = { cursor: "cursor", serverUrl: "server_url", login: "login", token: "token", lastSyncAt: "last_sync_at" } as const;

const EMPTY_DOC: JSONContent = { type: "doc", content: [] };

export function summarize(e: LocalEntry): EntrySummary {
  const text = extractText(e.body);
  return {
    id: e.id, entryDate: e.entryDate, kind: e.kind, parentId: e.parentId, icon: e.meta.icon ?? "",
    title: e.title, preview: preview(text), words: wordCount(text), updatedAt: e.updatedAt,
  };
}

const live = (e: LocalEntry) => !e.deletedAt;

export class LocalStore {
  entries = new Map<string, LocalEntry>();
  outbox = new Map<string, OutboxRow>();
  state = new Map<string, string>();
  blobs = new Map<string, { type: string; uploaded: boolean }>();
  wanted = new Set<string>();
  private links = new Map<string, { at: string; to: string[] }>();

  constructor(
    private p: Persist,
    private now: () => Date = () => new Date(),
  ) {}

  async init(): Promise<void> {
    const s = await this.p.load();
    s.entries.forEach((e) => this.entries.set(e.id, e));
    s.outbox.forEach((r) => this.outbox.set(r.entryId, r));
    s.state.forEach(([k, v]) => this.state.set(k, v));
    s.blobs.forEach((b) => this.blobs.set(b.hash, { type: b.type, uploaded: b.uploaded }));
    s.wanted.forEach((h) => this.wanted.add(h));
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // ---- reads ------------------------------------------------------------------

  get(id: string): LocalEntry | null {
    return this.entries.get(id) ?? null;
  }

  forDate(date: string): LocalEntry | null {
    return [...this.entries.values()].filter((e) => live(e) && e.entryDate === date && !e.parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  }

  range(from: string, to: string): LocalEntry[] {
    return [...this.entries.values()]
      .filter((e) => live(e) && e.entryDate !== null && e.entryDate >= from && e.entryDate <= to)
      .sort((a, b) => (a.entryDate! + a.createdAt).localeCompare(b.entryDate! + b.createdAt));
  }

  private isRecord(e: LocalEntry): boolean {
    return !!e.parentId && this.entries.get(e.parentId)?.kind === "database";
  }

  /** Recently changed live entries; database records are reached through their database. */
  recent(limit: number): LocalEntry[] {
    return [...this.entries.values()]
      .filter((e) => live(e) && !this.isRecord(e))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  children(parentId: string): LocalEntry[] {
    return [...this.entries.values()].filter((e) => live(e) && e.parentId === parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  roots(): LocalEntry[] {
    return [...this.entries.values()]
      .filter((e) => live(e) && !e.parentId && !e.entryDate)
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.createdAt.localeCompare(b.createdAt));
  }

  /** The ids an entry points to (page links, embedded views, relations), cached per version. */
  linksOf(e: LocalEntry): string[] {
    const c = this.links.get(e.id);
    if (c && c.at === e.updatedAt) return c.to;
    const self = e.id.toLowerCase();
    const to = [...new Set([...extractLinks(e.body), ...metaLinks(e.meta)])].filter((x) => x !== self);
    this.links.set(e.id, { at: e.updatedAt, to });
    return to;
  }

  backlinks(id: string): LocalEntry[] {
    const target = id.toLowerCase();
    return [...this.entries.values()]
      .filter((e) => live(e) && e.id !== id && this.linksOf(e).includes(target))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Every word must appear; the last may be a prefix. Snippets mark matches with [ ]. */
  search(query: string, limit = 50): SearchHit[] {
    const words = query.toLowerCase().split(/\s+/).map((w) => w.replace(/"/g, "")).filter(Boolean);
    if (!words.length) return [];
    const hits: { hit: SearchHit; score: number }[] = [];
    for (const e of this.entries.values()) {
      if (!live(e)) continue;
      const body = [extractText(e.body), metaText(e.meta)].filter(Boolean).join("\n");
      const hay = `${e.title}\n${body}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const score = words.reduce((n, w) => n + (e.title.toLowerCase().includes(w) ? 2 : 1), 0);
      hits.push({ hit: { id: e.id, entryDate: e.entryDate, title: e.title, snippet: snippet(body || e.title, words) }, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.hit);
  }

  // ---- local writes ----------------------------------------------------------

  /** Saves a draft and coalesces it into the outbox. The version stays the
   *  last one the server confirmed. */
  async saveLocal(d: EntryDraft): Promise<LocalEntry> {
    const now = this.stamp();
    const prev = this.entries.get(d.id);
    const e: LocalEntry = {
      id: d.id, entryDate: d.entryDate, kind: d.kind || "page", parentId: d.parentId || null, title: d.title,
      body: d.body ?? EMPTY_DOC, meta: d.meta ?? {}, version: prev?.version ?? 0, serverSeq: prev?.serverSeq ?? 0,
      createdAt: prev?.createdAt ?? now, updatedAt: now, deletedAt: null,
    };
    this.entries.set(e.id, e);
    await this.p.putEntries([e]);
    await this.enqueue(e.id, "put", payloadOf(e));
    return e;
  }

  /** Tombstones the entry and queues the delete. One the server never saw is just removed. */
  async deleteLocal(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.version === 0) {
      this.entries.delete(id);
      this.outbox.delete(id);
      await this.p.deleteEntry(id);
      await this.p.deleteOutbox(id);
      return;
    }
    const now = this.stamp();
    const t: LocalEntry = { ...e, title: "", body: EMPTY_DOC, meta: {}, deletedAt: now, updatedAt: now };
    this.entries.set(id, t);
    await this.p.putEntries([t]);
    await this.enqueue(id, "delete", null);
  }

  private async enqueue(id: string, op: OutboxRow["op"], payload: PutPayload | null): Promise<void> {
    const prev = this.outbox.get(id);
    const row: OutboxRow = {
      entryId: id, op, payload,
      baseVersion: prev ? prev.baseVersion : (this.entries.get(id)?.version ?? 0),
      rev: (prev?.rev ?? 0) + 1, idemKey: uuidv7(), attempts: 0, nextTryAt: 0, failed: false, lastError: "",
    };
    this.outbox.set(id, row);
    await this.p.putOutbox(row);
  }

  // ---- outbox, used by the sync engine ------------------------------------

  due(): OutboxRow[] {
    const now = this.now().getTime();
    return [...this.outbox.values()].filter((r) => !r.failed && r.nextTryAt <= now).map((r) => ({ ...r }));
  }

  pendingCount(): number {
    return this.outbox.size;
  }

  /** Records the server's answer. Edits made while the request was in flight
   *  stay queued, now based on the version the server just confirmed. */
  async pushSucceeded(row: OutboxRow, server: { version: number; serverSeq: number }): Promise<void> {
    const e = this.entries.get(row.entryId);
    if (e) {
      const next = { ...e, version: server.version, serverSeq: server.serverSeq };
      this.entries.set(e.id, next);
      await this.p.putEntries([next]);
    }
    const cur = this.outbox.get(row.entryId);
    if (cur && cur.rev === row.rev) {
      this.outbox.delete(row.entryId);
      await this.p.deleteOutbox(row.entryId);
    } else if (cur) {
      cur.baseVersion = server.version;
      await this.p.putOutbox(cur);
    }
  }

  /** A 409: the local version becomes a "(conflict copy)" queued as a create;
   *  the original takes the server's version. Returns the copy's id, or "". */
  async pushConflict(row: OutboxRow, current: LocalEntry): Promise<string> {
    const latest = this.outbox.get(row.entryId) ?? row; // the newest edit, not the one in flight
    let copyId = "";
    if (latest.op === "put" && latest.payload) {
      const p = latest.payload;
      const now = this.stamp();
      const copy: LocalEntry = {
        id: uuidv7(), entryDate: null, kind: p.kind, parentId: p.parent_id, title: copyTitle(p.title),
        body: p.body, meta: p.meta, version: 0, serverSeq: 0, createdAt: now, updatedAt: now, deletedAt: null,
      };
      copyId = copy.id;
      this.entries.set(copy.id, copy);
      await this.p.putEntries([copy]);
      await this.enqueue(copy.id, "put", payloadOf(copy));
    }
    this.entries.set(current.id, current);
    await this.p.putEntries([current]);
    this.outbox.delete(row.entryId);
    await this.p.deleteOutbox(row.entryId);
    return copyId;
  }

  /** The server no longer has the entry: re-create it, or drop a delete. */
  async pushNotFound(row: OutboxRow): Promise<void> {
    const cur = this.outbox.get(row.entryId);
    if (!cur) return;
    if (row.op === "delete") {
      this.outbox.delete(row.entryId);
      await this.p.deleteOutbox(row.entryId);
      return;
    }
    cur.baseVersion = 0;
    await this.p.putOutbox(cur);
    const e = this.entries.get(row.entryId);
    if (e) {
      e.version = 0;
      await this.p.putEntries([e]);
    }
  }

  async pushFailed(row: OutboxRow, msg: string, permanent: boolean, nextTryAt: number): Promise<void> {
    const cur = this.outbox.get(row.entryId);
    if (!cur || cur.rev !== row.rev) return;
    Object.assign(cur, { attempts: cur.attempts + 1, lastError: msg, failed: permanent, nextTryAt });
    await this.p.putOutbox(cur);
  }

  /** Stores pulled changes and the new cursor. Entries with unsent edits are
   *  skipped: the pull never overwrites them. Returns the ids that changed. */
  async applyPull(changes: LocalEntry[], cursor: number): Promise<string[]> {
    const ids: string[] = [];
    const put: LocalEntry[] = [];
    for (const c of changes) {
      if (this.outbox.has(c.id)) continue;
      this.entries.set(c.id, c);
      put.push(c);
      ids.push(c.id);
      for (const h of extractImages(c.body)) {
        if (!this.blobs.has(h) && !this.wanted.has(h)) {
          this.wanted.add(h);
          await this.p.setWanted(h, true);
        }
      }
    }
    if (put.length) await this.p.putEntries(put);
    await this.setState(KEY.cursor, String(cursor));
    return ids;
  }

  // ---- state and images ----------------------------------------------------

  getState(k: string): string {
    return this.state.get(k) ?? "";
  }

  async setState(k: string, v: string | null): Promise<void> {
    if (v === null) this.state.delete(k);
    else this.state.set(k, v);
    await this.p.setState(k, v);
  }

  /** Stores image bytes under their sha256 (the server's name for them too). */
  async putBlob(data: Blob, type: string, uploaded: boolean): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", await data.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const prev = this.blobs.get(hash);
    this.blobs.set(hash, { type, uploaded: uploaded || !!prev?.uploaded });
    await this.p.putBlob({ hash, type, data, uploaded: uploaded || !!prev?.uploaded });
    if (this.wanted.delete(hash)) await this.p.setWanted(hash, false);
    return hash;
  }

  getBlob(hash: string): Promise<{ data: Blob; type: string } | null> {
    return this.p.getBlob(hash).then((b) => (b ? { data: b.data, type: b.type } : null));
  }

  blobsToUpload(): string[] {
    return [...this.blobs.entries()].filter(([, b]) => !b.uploaded).map(([h]) => h);
  }

  async markUploaded(hash: string): Promise<void> {
    const b = await this.p.getBlob(hash);
    if (!b) return;
    b.uploaded = true;
    this.blobs.set(hash, { type: b.type, uploaded: true });
    await this.p.putBlob(b);
  }

  async dropWanted(hash: string): Promise<void> {
    this.wanted.delete(hash);
    await this.p.setWanted(hash, false);
  }

  conflictCopies(): LocalEntry[] {
    return [...this.entries.values()].filter((e) => live(e) && isConflictCopy(e.title));
  }
}

export function payloadOf(e: { entryDate: string | null; kind: EntryKind; parentId: string | null; title: string; body: JSONContent; meta: EntryMeta }): PutPayload {
  return { entry_date: e.entryDate, kind: e.kind, parent_id: e.parentId, title: e.title, body: e.body, meta: e.meta };
}

/** About 12 words around the first match, matches wrapped in [ ]. */
function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), flat.length));
  const start = Math.max(0, flat.lastIndexOf(" ", Math.max(0, at - 40)) + 1);
  let part = flat.slice(start, start + 120);
  for (const w of words) {
    part = part.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `[${m}]`);
  }
  return (start > 0 ? "…" : "") + part + (start + 120 < flat.length ? "…" : "");
}

