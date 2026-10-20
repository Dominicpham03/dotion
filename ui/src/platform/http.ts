// Web implementation of DiaryStore: every call goes to the server API. There
// is no cursor and no /v1/sync here; live notices just refetch what is on
// screen (FRONTEND.md §3.3).
import { uuidv7 } from "@/lib/uuid";
import { isFolder } from "@/lib/folders";
import { copyTitle, extractText, preview, wordCount } from "@/lib/text";
import {
  aiChatBody,
  fromWireActionsScan,
  fromWireActionsStatus,
  fromWireAiReply,
  fromWireDrive,
  fromWireGitLab,
  type WireActionsScan,
  type WireActionsStatus,
  type WireAiReply,
  type WireDriveFile,
  type WireGitLab,
} from "./http-wire";
import {
  ApiError,
  AuthRequired,
  type CalendarEvent,
  type DiaryStore,
  type Entry,
  type EntryDraft,
  type EntryKind,
  type EntryMeta,
  type EntrySummary,
  type SearchHit,
  type SyncStatus,
} from "./types";

type ApiEntry = {
  id: string;
  entry_date: string | null;
  kind?: EntryKind;
  parent_id?: string | null;
  title: string;
  body: Entry["body"];
  meta?: EntryMeta | null;
  version: number;
  server_seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const fromApi = (e: ApiEntry): Entry => ({
  id: e.id,
  entryDate: e.entry_date,
  kind: e.kind ?? "page",
  parentId: e.parent_id ?? null,
  title: e.title,
  body: e.body,
  meta: e.meta ?? {},
  version: e.version,
  updatedAt: e.updated_at,
  deletedAt: e.deleted_at,
});

const summarize = (e: ApiEntry): EntrySummary => {
  const text = extractText(e.body);
  return {
    id: e.id, entryDate: e.entry_date, kind: e.kind ?? "page", parentId: e.parent_id ?? null, icon: e.meta?.icon ?? "",
    folder: isFolder(e.meta), title: e.title, preview: preview(text), words: wordCount(text), updatedAt: e.updated_at, version: e.version,
  };
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Diary-Client": "1", ...init.headers },
  });
  if (res.status === 401) throw new AuthRequired();
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "unknown", body ?? {});
  return body as T;
}

const nullOn404 = (e: unknown): null => {
  if (e instanceof ApiError && e.status === 404) return null;
  throw e;
};

async function put(draft: EntryDraft, baseVersion: number): Promise<Entry> {
  const e = await api<ApiEntry>(`/entries/${draft.id}`, {
    method: "PUT",
    headers: { "Idempotency-Key": uuidv7() },
    body: JSON.stringify({
      base_version: baseVersion, entry_date: draft.entryDate, kind: draft.kind, parent_id: draft.parentId,
      title: draft.title, body: draft.body, meta: draft.meta,
    }),
  });
  return fromApi(e);
}

const entries = async (q: string) => (await api<{ entries: ApiEntry[] }>(`/entries?${q}`)).entries;

// One EventSource shared by every listener.
const changedSubs = new Set<(ids: "all") => void>();
const statusSubs = new Set<(s: SyncStatus) => void>();
let es: EventSource | null = null;
let lastStatus: SyncStatus = { state: "synced" };

function emitStatus(s: SyncStatus) {
  lastStatus = s;
  statusSubs.forEach((cb) => cb(s));
}

function ensureStream() {
  if (es) return;
  es = new EventSource("/v1/events");
  let dropped = false;
  es.addEventListener("changed", () => changedSubs.forEach((cb) => cb("all")));
  es.onopen = () => {
    emitStatus({ state: "synced", at: new Date().toISOString() });
    if (dropped) changedSubs.forEach((cb) => cb("all")); // notices may have been missed
    dropped = false;
  };
  es.onerror = () => {
    dropped = true;
    emitStatus({ state: "offline", pending: 0 });
  };
}

function releaseStream() {
  if (!changedSubs.size && !statusSubs.size) {
    es?.close();
    es = null;
  }
}

export const store: DiaryStore = {
  platform: "web",

  getEntry: (id) => api<ApiEntry>(`/entries/${id}`).then(fromApi).catch(nullOn404),

  async getEntryForDate(date) {
    const list = (await entries(`from=${date}&to=${date}`)).filter((e) => !e.parent_id);
    return list.length ? fromApi(list[0]) : null;
  },

  listRange: async (from, to) => (await entries(`from=${from}&to=${to}`)).map(summarize),
  listRecent: async (limit) => (await entries(`recent=${limit}`)).map(summarize),
  listChildren: async (parentId) => (await entries(`parent=${encodeURIComponent(parentId)}`)).map(fromApi),
  listPages: async () => (await entries("pages=1")).map(summarize),
  backlinks: async (id) => (await api<{ entries: ApiEntry[] }>(`/entries/${id}/backlinks`)).entries.map(summarize),

  async search(query): Promise<SearchHit[]> {
    const r = await api<{ hits: { id: string; entry_date: string | null; title: string; snippet: string }[] }>(
      `/search?q=${encodeURIComponent(query)}`,
    );
    return r.hits.map((h) => ({ id: h.id, entryDate: h.entry_date, title: h.title, snippet: h.snippet }));
  },

  async saveEntry(draft, baseVersion) {
    try {
      return { status: "saved", entry: await put(draft, baseVersion) };
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict" && e.body.current) {
        // Keep the server version; save this one as a copy. It keeps its parent
        // and properties (a record stays in its database) but loses its date.
        const copy = await put({ ...draft, id: uuidv7(), entryDate: null, title: copyTitle(draft.title) }, 0);
        return { status: "conflict", current: fromApi(e.body.current as ApiEntry), copy };
      }
      throw e;
    }
  },

  async deleteEntry(id, baseVersion) {
    await api(`/entries/${id}?base_version=${baseVersion}`, { method: "DELETE", headers: { "Idempotency-Key": uuidv7() } });
  },

  listTrash: async () => (await api<{ entries: ApiEntry[] }>("/trash")).entries.map(summarize),
  async restoreEntry(id, baseVersion) {
    await api(`/entries/${id}/restore?base_version=${baseVersion}`, { method: "POST", headers: { "Idempotency-Key": uuidv7() } });
  },
  async purgeEntry(id, baseVersion) {
    await api(`/entries/${id}/purge?base_version=${baseVersion}`, { method: "POST", headers: { "Idempotency-Key": uuidv7() } });
  },

  async uploadImage(file) {
    const r = await api<{ url: string }>("/blobs", { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
    return r.url;
  },

  async uploadFile(file) {
    // Same content-addressed endpoint as images; the server stores any file and
    // serves non-images as a download attachment.
    const r = await api<{ url: string }>("/blobs", { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
    return r.url;
  },

  onChanged(cb) {
    changedSubs.add(cb);
    ensureStream();
    return () => {
      changedSubs.delete(cb);
      releaseStream();
    };
  },

  onSyncStatus(cb) {
    statusSubs.add(cb);
    ensureStream();
    return () => {
      statusSubs.delete(cb);
      releaseStream();
    };
  },

  getSyncStatus: async () => lastStatus,
  onConflict: () => () => {},
  onFlushRequest: () => () => {},
  onImagesArrived: () => () => {},

  calendar: {
    async status() {
      const r = await api<{ configured: boolean; connected: boolean; email?: string; redirect_uri: string; drive?: boolean; calendar_write?: boolean }>(
        "/integrations/google",
      );
      return { configured: r.configured, connected: r.connected, email: r.email, redirectUri: r.redirect_uri, drive: !!r.drive, calendarWrite: !!r.calendar_write };
    },
    async connect() {
      const r = await api<{ url: string }>("/integrations/google/start", { method: "POST", body: JSON.stringify({ client: "web" }) });
      window.location.assign(r.url); // Google sends the browser back to /settings
    },
    async disconnect() {
      await api("/integrations/google", { method: "DELETE" });
    },
    async events(start, end) {
      const r = await api<{ connected: boolean; events: (Omit<CalendarEvent, "allDay"> & { all_day: boolean })[] }>(
        `/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
      return { connected: r.connected, events: r.events.map(({ all_day, ...e }) => ({ ...e, allDay: all_day })) };
    },
    async addEvent(input) {
      return api<{ id: string; link?: string }>("/calendar/events", {
        method: "POST",
        headers: { "Idempotency-Key": uuidv7() },
        body: JSON.stringify({
          title: input.title, date: input.date, end_date: input.endDate, start: input.start, end: input.end, description: input.description,
        }),
      });
    },
  },

  drive: {
    async search(query, page) {
      const q = new URLSearchParams({ q: query, ...(page ? { page } : {}) });
      const r = await api<{ connected: boolean; files: WireDriveFile[]; next?: string }>(`/drive/files?${q}`);
      return { connected: r.connected, files: r.files.map(fromWireDrive), next: r.next };
    },
    markdown: (id) => api<{ name: string; markdown: string }>(`/drive/files/${encodeURIComponent(id)}/markdown`),
  },

  gitlab: {
    status: async () => fromWireGitLab(await api<WireGitLab>("/integrations/gitlab")),
    connect: async (url, token) => fromWireGitLab(await api<WireGitLab>("/integrations/gitlab", { method: "POST", body: JSON.stringify({ url, token }) })),
    sync: () => api("/integrations/gitlab/sync", { method: "POST" }),
    async disconnect() {
      await api("/integrations/gitlab", { method: "DELETE" });
    },
  },

  ai: {
    status: () => api("/ai"),
    chat: async (messages, entryId) =>
      fromWireAiReply(await api<WireAiReply>("/ai/chat", { method: "POST", body: JSON.stringify(aiChatBody(messages, entryId)) })),
    actionsStatus: async () => fromWireActionsStatus(await api<WireActionsStatus>("/ai/actions")),
    configureActions: async (enabled, names) =>
      fromWireActionsStatus(await api<WireActionsStatus>("/ai/actions", { method: "PUT", body: JSON.stringify({ enabled, names }) })),
    scanActions: async (entryId) =>
      fromWireActionsScan(await api<WireActionsScan>("/ai/actions/scan", { method: "POST", body: JSON.stringify({ entry_id: entryId ?? "" }) })),
  },

  web: {
    async me() {
      const r = await api<{ login: string; auth_mode: string }>("/me");
      return { login: r.login, authMode: r.auth_mode };
    },
    async login(password) {
      try {
        await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      } catch (e) {
        if (e instanceof AuthRequired) throw new Error("That password is not right.");
        throw e;
      }
    },
    async logout() {
      await api("/auth/logout", { method: "POST" });
    },
    exportUrl: "/v1/export",
  },
};

