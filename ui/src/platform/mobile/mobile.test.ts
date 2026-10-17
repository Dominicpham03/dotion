import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@/lib/uuid";
import type { EntryDraft } from "../types";
import { Api, type WireEntry } from "./api";
import { Engine } from "./engine";
import { KEY, LocalStore } from "./local";
import { MemoryPersist } from "./persist";

/** A fake diary server with the real one's rules: versions, a per-user
 *  change log, 409 with the current entry, idempotent retries, images. */
class FakeServer {
  entries = new Map<string, WireEntry>();
  blobs = new Map<string, { data: Blob; type: string }>();
  seq = 0;
  idem = new Map<string, WireEntry>();
  down = false;

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (this.down) throw new TypeError("Failed to fetch");
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const key = (init.headers as Record<string, string>)?.["Idempotency-Key"] ?? "";
    const m = url.pathname.match(/^\/v1\/entries\/([^/]+)$/);
    if (m && method === "PUT") {
      if (this.idem.has(key)) return json(200, this.idem.get(key));
      const req = JSON.parse(init.body as string);
      const cur = this.entries.get(m[1]);
      if (!cur && req.base_version > 0) return json(404, { error: "not_found" });
      if (cur && cur.version !== req.base_version) return json(409, { error: "conflict", current: cur });
      const now = new Date().toISOString();
      const e: WireEntry = {
        id: m[1], entry_date: req.entry_date, kind: req.kind, parent_id: req.parent_id, title: req.title, body: req.body, meta: req.meta,
        version: (cur?.version ?? 0) + 1, server_seq: ++this.seq, created_at: cur?.created_at ?? now, updated_at: now, deleted_at: null,
      };
      this.entries.set(e.id, e);
      this.idem.set(key, e);
      return json(200, e);
    }
    if (m && method === "DELETE") {
      const cur = this.entries.get(m[1]);
      if (!cur) return json(404, { error: "not_found" });
      if (cur.version !== Number(url.searchParams.get("base_version"))) return json(409, { error: "conflict", current: cur });
      const e = { ...cur, title: "", body: { type: "doc", content: [] }, meta: {}, version: cur.version + 1, server_seq: ++this.seq, deleted_at: new Date().toISOString() };
      this.entries.set(e.id, e);
      return json(200, e);
    }
    if (url.pathname === "/v1/sync") {
      const since = Number(url.searchParams.get("since"));
      if (since > this.seq) return json(409, { error: "cursor_ahead" });
      const changes = [...this.entries.values()].filter((e) => e.server_seq > since).sort((a, b) => a.server_seq - b.server_seq);
      return json(200, { changes, cursor: changes.at(-1)?.server_seq ?? since, has_more: false });
    }
    if (url.pathname === "/v1/blobs" && method === "POST") {
      const data = init.body as Blob;
      const digest = await crypto.subtle.digest("SHA-256", await data.arrayBuffer());
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.blobs.set(hash, { data, type: "image/png" });
      return json(200, { hash, url: `/v1/blobs/${hash}` });
    }
    const b = url.pathname.match(/^\/v1\/blobs\/([0-9a-f]{64})$/);
    if (b) {
      const blob = this.blobs.get(b[1]);
      return blob ? new Response(blob.data, { status: 200, headers: { "Content-Type": blob.type } }) : json(404, { error: "not_found" });
    }
    return json(404, { error: "not_found" });
  };
}

type Device = { local: LocalStore; engine: Engine; conflicts: [string, string][]; images: string[] };

let clockOffset = 0; // lets a test jump past retry delays

async function device(server: FakeServer): Promise<Device> {
  const local = new LocalStore(new MemoryPersist(), () => new Date(Date.now() + clockOffset));
  await local.init();
  await local.setState(KEY.serverUrl, "https://diary.test");
  const d: Device = { local, conflicts: [], images: [], engine: null as never };
  d.engine = new Engine(
    local,
    { changed: () => {}, status: () => {}, conflict: (a, b) => d.conflicts.push([a, b]), images: (h) => d.images.push(...h) },
    (base, token) => new Api(base, token, server.fetch),
  );
  return d;
}

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const draft = (id: string, title: string, extra: Partial<EntryDraft> = {}): EntryDraft => ({
  id, entryDate: "2026-10-05", kind: "page", parentId: null, title, body: doc(title), meta: {}, ...extra,
});
const titles = (d: Device) => Object.fromEntries(d.local.recent(100).map((e) => [e.id, e.title]));

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  clockOffset = 0;
});

describe("Android sync", () => {
  it("sends offline edits as one coalesced request and brings them to the other phone", async () => {
    const a = await device(server);
    const b = await device(server);
    const id = uuidv7();
    await a.local.saveLocal(draft(id, "Monday"));
    await a.local.saveLocal(draft(id, "Monday, later"));
    expect(a.local.due()).toHaveLength(1);
    await a.engine.syncOnce();
    expect(a.local.pendingCount()).toBe(0);
    expect(a.local.get(id)?.version).toBe(1);
    expect(server.seq).toBe(1); // one PUT, not two

    await b.engine.syncOnce();
    expect(titles(b)[id]).toBe("Monday, later");
    expect(b.engine.status.state).toBe("synced");
  });

  it("keeps edits typed during a push queued on the confirmed version", async () => {
    const a = await device(server);
    const id = uuidv7();
    await a.local.saveLocal(draft(id, "first"));
    const [inFlight] = a.local.due();
    await a.local.saveLocal(draft(id, "typed meanwhile"));
    await a.local.pushSucceeded(inFlight, { version: 1, serverSeq: 1 });
    const [next] = a.local.due();
    expect(next.rev).toBe(2);
    expect(next.baseVersion).toBe(1);
  });

  it("turns a concurrent edit into a conflict copy, and both phones converge", async () => {
    const a = await device(server);
    const b = await device(server);
    const id = uuidv7();
    await a.local.saveLocal(draft(id, "Monday"));
    await a.engine.syncOnce();
    await b.engine.syncOnce();

    await a.local.saveLocal(draft(id, "Monday from A"));
    await a.engine.syncOnce();
    await b.local.saveLocal(draft(id, "Monday from B"));
    await b.engine.syncOnce();

    expect(b.conflicts).toHaveLength(1);
    const copy = b.conflicts[0][1];
    await a.engine.syncOnce();
    for (const d of [a, b]) {
      expect(titles(d)[id]).toBe("Monday from A");
      expect(titles(d)[copy]).toBe("Monday from B (conflict copy)");
      expect(d.local.pendingCount()).toBe(0);
    }
  });

  it("propagates deletes and keeps unsent text out of pulls", async () => {
    const a = await device(server);
    const b = await device(server);
    const id = uuidv7();
    await a.local.saveLocal(draft(id, "short-lived"));
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    await a.local.deleteLocal(id);
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    expect(b.local.get(id)?.deletedAt).toBeTruthy();
    expect(titles(b)[id]).toBeUndefined();

    const mine = uuidv7();
    await b.local.saveLocal(draft(mine, "unsent"));
    await b.local.applyPull([{ ...b.local.get(mine)!, title: "server text", version: 4 }], 99);
    expect(b.local.get(mine)?.title).toBe("unsent");
  });

  it("re-pulls everything when the server was restored from a backup", async () => {
    const a = await device(server);
    const b = await device(server);
    const id = uuidv7();
    await a.local.saveLocal(draft(id, "kept"));
    await a.engine.syncOnce();
    await b.local.setState(KEY.cursor, "9999");
    await b.engine.syncOnce();
    expect(titles(b)[id]).toBe("kept");
  });

  it("goes offline without losing anything", async () => {
    const a = await device(server);
    await a.local.saveLocal(draft(uuidv7(), "on the train"));
    server.down = true;
    await expect(a.engine.syncOnce()).rejects.toThrow();
    expect(a.engine.status).toMatchObject({ state: "offline", pending: 1 });
    server.down = false;
    expect(a.local.due()).toHaveLength(0); // waits out its retry delay
    clockOffset = 2 * 60_000;
    await a.engine.syncOnce();
    expect(a.local.pendingCount()).toBe(0);
  });

  it("syncs images, records, links and backlinks", async () => {
    const a = await device(server);
    const b = await device(server);
    const hash = await a.local.putBlob(new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: "image/png" }), "image/png", false);
    const project = uuidv7();
    const tasks = uuidv7();
    const task = uuidv7();
    await a.local.saveLocal(draft(project, "Project X", { entryDate: null, body: { type: "doc", content: [{ type: "image", attrs: { src: `/v1/blobs/${hash}` } }] } }));
    await a.local.saveLocal(draft(tasks, "Tasks", { entryDate: null, kind: "database", parentId: project, meta: { schema: { properties: [], views: [] } } }));
    await a.local.saveLocal(draft(task, "Write spec", { entryDate: null, parentId: tasks, meta: { props: { p_rel: [project] } } }));
    await a.engine.syncOnce();
    expect(a.local.blobsToUpload()).toEqual([]);

    await b.engine.syncOnce();
    expect(b.images).toEqual([hash]);
    expect(await b.local.getBlob(hash)).not.toBeNull();
    expect(b.local.children(tasks).map((e) => e.id)).toEqual([task]);
    expect(b.local.backlinks(project).map((e) => e.id)).toEqual([task]);
    expect(b.local.roots().map((e) => e.id)).toEqual([project]);
    expect(b.local.recent(10).map((e) => e.id)).not.toContain(task);
    expect(b.local.search("spec")[0]?.snippet).toContain("[spec]");
  });

  it("searches titles, text and properties offline", async () => {
    const a = await device(server);
    const id = uuidv7();
    await a.local.saveLocal(draft(id, "Sunday", { body: doc("walked along the river at dusk"), meta: { props: { p_note: "bring a camera" } } }));
    expect(a.local.search("river")[0]).toMatchObject({ id, snippet: expect.stringContaining("[river]") });
    expect(a.local.search("riv dusk")).toHaveLength(1);
    expect(a.local.search("camera")).toHaveLength(1);
    expect(a.local.search("mountain")).toHaveLength(0);
  });
});
