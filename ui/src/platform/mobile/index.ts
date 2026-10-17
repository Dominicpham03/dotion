// Android implementation of DiaryStore: local-first like the desktop app.
// Reads and saves hit the on-device store and return at once; the engine
// syncs with the server through Tailscale whenever it can.
import "@capacitor/core"; // the JS half of the native bridge (only bundled in this build)
import { openExternal } from "@/lib/external";
import { blobHash, BLOB_PREFIX } from "@/lib/links";
import type { AppSettings, CalendarEvent, ConnectResult, DiaryStore, Entry, SyncStatus } from "../types";
import { Api, HttpError } from "./api";
import { Engine } from "./engine";
import { KEY, LocalStore, summarize, type LocalEntry } from "./local";
import { createNotifications } from "./notifications";
import { IdbPersist } from "./persist";

type Listener<T> = (v: T) => void;
function emitter<T>() {
  const subs = new Set<Listener<T>>();
  return {
    on(cb: Listener<T>) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    emit: (v: T) => subs.forEach((cb) => cb(v)),
  };
}

const changed = emitter<string[]>();
const status = emitter<SyncStatus>();
const conflicts = emitter<{ id: string; copyId: string }>();
const images = emitter<string[]>();

const local = new LocalStore(new IdbPersist("diary"));
const engine = new Engine(local, {
  changed: (ids) => changed.emit(ids),
  status: (s) => status.emit(s),
  conflict: (id, copyId) => conflicts.emit({ id, copyId }),
  images: (h) => images.emit(h),
});
const ready = local.init().then(() => engine.start());

const toEntry = (e: LocalEntry | null): Entry | null => (e ? { ...e } : null);
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function normalizeUrl(raw: string): string {
  let s = raw.trim();
  if (s && !s.includes("://")) s = "https://" + s;
  const u = new URL(s);
  if (!u.host || (u.protocol !== "https:" && u.protocol !== "http:")) throw new Error();
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
}

function api(): Api | null {
  const url = local.getState(KEY.serverUrl);
  return url ? new Api(url, local.getState(KEY.token)) : null;
}

function serverApi(): Api {
  const a = api();
  if (!a) throw new Error("Connect this app to your Dotion server first.");
  return a;
}

async function finishConnect(url: string, login: string): Promise<ConnectResult> {
  if (local.getState(KEY.serverUrl) !== url) await local.setState(KEY.cursor, null); // another server: pull everything
  await local.setState(KEY.serverUrl, url);
  await local.setState(KEY.login, login);
  engine.nudge();
  return { ok: true, needsPassword: false, login, message: "" };
}

const imageUrls = new Map<string, string>();

export const store: DiaryStore = {
  platform: "mobile",

  getEntry: async (id) => (await ready, toEntry(local.get(id))),
  getEntryForDate: async (d) => (await ready, toEntry(local.forDate(d))),
  listRange: async (from, to) => (await ready, local.range(from, to).map(summarize)),
  listRecent: async (limit) => (await ready, local.recent(limit).map(summarize)),
  listChildren: async (parentId) => (await ready, local.children(parentId).map((e) => ({ ...e }))),
  listPages: async () => (await ready, local.roots().map(summarize)),
  backlinks: async (id) => (await ready, local.backlinks(id).map(summarize)),
  search: async (q) => (await ready, local.search(q)),

  async saveEntry(draft) {
    await ready;
    const e = await local.saveLocal(draft);
    engine.nudge();
    return { status: "queued", entry: { ...e } };
  },

  async deleteEntry(id) {
    await ready;
    await local.deleteLocal(id);
    engine.nudge();
    changed.emit([id]);
  },

  async uploadImage(file) {
    await ready;
    if (!IMAGE_TYPES.includes(file.type)) throw new Error("Only PNG, JPEG, GIF and WebP images can be added.");
    if (file.size > 10 << 20) throw new Error("Images can be at most 10 MB.");
    const hash = await local.putBlob(file, file.type, false);
    engine.nudge();
    return BLOB_PREFIX + hash;
  },

  async resolveImage(src) {
    const h = blobHash(src);
    if (!h) return src;
    const cached = imageUrls.get(h);
    if (cached) return cached;
    await ready;
    const b = await local.getBlob(h);
    if (!b) return null; // not downloaded yet; the next sync fetches it
    const url = URL.createObjectURL(b.data);
    imageUrls.set(h, url);
    return url;
  },

  onChanged: (cb) => changed.on(cb),
  onSyncStatus: (cb) => status.on(cb),
  getSyncStatus: async () => engine.status,
  onConflict: (cb) => conflicts.on(cb),
  onFlushRequest: () => () => {},
  onImagesArrived: (cb) => images.on(cb),

  calendar: {
    async status() {
      await ready;
      const a = api();
      if (!a) return { configured: false, connected: false, redirectUri: "", offline: true };
      try {
        return await a.calendarStatus();
      } catch {
        return { configured: false, connected: false, redirectUri: "", offline: true };
      }
    },
    async connect() {
      const a = api();
      if (!a) throw new Error("Connect this app to your Dotion server first.");
      const { url } = await a.calendarStart();
      openExternal(url);
    },
    async disconnect() {
      await api()?.calendarDisconnect();
    },
    async events(start, end) {
      await ready;
      const key = `events:${start}|${end}`;
      const a = api();
      if (a) {
        try {
          const r = await a.calendarEvents(start, end);
          await local.setState(key, JSON.stringify(r));
          return r;
        } catch {
          // offline: fall back to the last answer for this range
        }
      }
      const cached = local.getState(key);
      if (!cached) return { connected: false, events: [] as CalendarEvent[], stale: true };
      return { ...(JSON.parse(cached) as { connected: boolean; events: CalendarEvent[] }), stale: true };
    },
  },

  drive: {
    async search(query, page) {
      await ready;
      const a = api();
      if (!a) return { connected: false, files: [] };
      return a.driveSearch(query, page);
    },
    async markdown(id) {
      const a = api();
      if (!a) throw new Error("Connect this app to your Dotion server first.");
      return a.driveMarkdown(id);
    },
  },

  gitlab: {
    async status() {
      await ready;
      const a = api();
      if (!a) return { connected: false, offline: true };
      try {
        return await a.gitlabStatus();
      } catch {
        return { connected: false, offline: true };
      }
    },
    async connect(url, token) {
      const a = api();
      if (!a) throw new Error("Connect this app to your Dotion server first.");
      const st = await a.gitlabConnect(url, token);
      engine.nudge(); // pull the new GitLab records
      return st;
    },
    async sync() {
      const a = api();
      if (!a) throw new Error("Connect this app to your Dotion server first.");
      const r = await a.gitlabSync();
      engine.nudge();
      return r;
    },
    async disconnect() {
      await api()?.gitlabDisconnect();
    },
  },

  ai: {
    async status() {
      await ready;
      try {
        return (await api()?.aiStatus()) ?? { enabled: false };
      } catch {
        return { enabled: false }; // offline: the assistant needs the server
      }
    },
    chat: (messages, entryId) => serverApi().aiChat(messages, entryId),
    actionsStatus: () => serverApi().actionsStatus(),
    configureActions: (enabled, names) => serverApi().actionsConfigure(enabled, names),
    async scanActions(entryId) {
      const r = await serverApi().actionsScan(entryId);
      engine.nudge(); // pull the new Action items records
      return r;
    },
  },

  notifications: createNotifications(
    {
      entries: () => [...local.entries.values()].filter((e) => !e.deletedAt),
      events: async (start, end) => (await store.calendar.events(start, end)).events,
      getState: (k) => local.getState(k),
      setState: (k, v) => local.setState(k, v),
      onChanged: (cb) => changed.on(cb),
    },
    ready,
  ),

  app: {
    async getSettings(): Promise<AppSettings> {
      await ready;
      return {
        serverUrl: local.getState(KEY.serverUrl),
        login: local.getState(KEY.login),
        lastSyncAt: local.getState(KEY.lastSyncAt),
        pending: local.pendingCount(),
        status: engine.status,
        dataPath: "Stored in the app on this device",
      };
    },

    async connect(raw) {
      await ready;
      let url: string;
      try {
        url = normalizeUrl(raw);
      } catch {
        return { ok: false, needsPassword: false, login: "", message: "Enter an address like https://dotion.your-tailnet.ts.net" };
      }
      const a = new Api(url, local.getState(KEY.serverUrl) === url ? local.getState(KEY.token) : "");
      try {
        await a.health();
      } catch {
        return { ok: false, needsPassword: false, login: "", message: "Can't reach this address. Check that Tailscale is connected on this phone." };
      }
      try {
        const me = await a.me();
        return await finishConnect(url, me.login);
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) return { ok: false, needsPassword: true, login: "", message: "This diary needs its password." };
        if (e instanceof HttpError && e.status === 403) return { ok: false, needsPassword: false, login: "", message: "This server belongs to a different Tailscale account." };
        return { ok: false, needsPassword: false, login: "", message: `The server answered, but sign-in failed: ${(e as Error).message}` };
      }
    },

    async signIn(raw, password) {
      await ready;
      const url = normalizeUrl(raw);
      try {
        const r = await new Api(url, "").login(password);
        await local.setState(KEY.token, r.token);
        return await finishConnect(url, r.login);
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) return { ok: false, needsPassword: true, login: "", message: "That password is not right." };
        if (e instanceof HttpError && e.status === 429) return { ok: false, needsPassword: true, login: "", message: "Too many attempts. Wait a minute and try again." };
        return { ok: false, needsPassword: true, login: "", message: `Sign-in failed: ${(e as Error).message}` };
      }
    },

    async disconnect() {
      await ready;
      for (const k of [KEY.serverUrl, KEY.login, KEY.cursor, KEY.token, KEY.lastSyncAt]) await local.setState(k, null);
      engine.nudge();
    },

    syncNow: async () => engine.nudge(),
  },
};
