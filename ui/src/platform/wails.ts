// Desktop implementation of DiaryStore: every call is a local SQLite
// operation in the Go app, reached through the Wails bridge. It never waits
// on the network. Bound methods live on window.go.main.App; events on
// window.runtime (both injected by Wails).
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
import type {
  AiStatus,
  CalendarEvent,
  CalendarStatus,
  ConflictEvent,
  ConnectResult,
  AppSettings,
  DiaryStore,
  Entry,
  EntryDraft,
  EntrySummary,
  SaveResult,
  SearchHit,
  SyncStatus,
} from "./types";

interface GoApp {
  GetEntry(id: string): Promise<Entry | null>;
  GetEntryForDate(date: string): Promise<Entry | null>;
  ListRange(from: string, to: string): Promise<EntrySummary[] | null>;
  ListRecent(limit: number): Promise<EntrySummary[] | null>;
  ListChildren(parentId: string): Promise<Entry[] | null>;
  ListPages(): Promise<EntrySummary[] | null>;
  Backlinks(id: string): Promise<EntrySummary[] | null>;
  Search(query: string): Promise<SearchHit[] | null>;
  SaveEntry(draft: EntryDraft, baseVersion: number): Promise<SaveResult>;
  DeleteEntry(id: string, baseVersion: number): Promise<void>;
  UploadImage(dataBase64: string): Promise<string>;
  GetSettings(): Promise<AppSettings>;
  GetSyncStatus(): Promise<SyncStatus>;
  Connect(serverUrl: string): Promise<ConnectResult>;
  SignIn(serverUrl: string, password: string): Promise<ConnectResult>;
  Disconnect(): Promise<void>;
  SyncNow(): Promise<void>;
  CalendarStatus(): Promise<CalendarStatus>;
  CalendarConnect(): Promise<void>;
  CalendarDisconnect(): Promise<void>;
  CalendarEvents(start: string, end: string): Promise<{ connected: boolean; events: (Omit<CalendarEvent, "allDay"> & { all_day: boolean })[] | null; stale: boolean }>;
  DriveSearch(query: string, page: string): Promise<{ connected: boolean; files: WireDriveFile[] | null; next: string }>;
  DriveMarkdown(id: string): Promise<{ name: string; markdown: string }>;
  GitLabStatus(): Promise<WireGitLab>;
  GitLabConnect(url: string, token: string): Promise<WireGitLab>;
  GitLabSync(): Promise<{ created: number; updated: number; pushed: number }>;
  GitLabDisconnect(): Promise<void>;
  AIStatus(): Promise<AiStatus>;
  AIChat(req: ReturnType<typeof aiChatBody>): Promise<WireAiReply>;
  ActionsStatus(): Promise<WireActionsStatus>;
  ActionsConfigure(enabled: boolean, names: string[]): Promise<WireActionsStatus>;
  ActionsScan(entryId: string): Promise<WireActionsScan>;
}

interface WailsRuntime {
  EventsOn(name: string, cb: (...data: unknown[]) => void): () => void;
}

declare global {
  interface Window {
    go?: { main?: { App?: GoApp } };
    runtime?: WailsRuntime;
  }
}

function app(): GoApp {
  const a = window.go?.main?.App;
  if (!a) throw new Error("The desktop bridge is not available. Run this build inside the Dotion app.");
  return a;
}

function on<T>(name: string, cb: (data: T) => void): () => void {
  return window.runtime?.EventsOn(name, (data) => cb(data as T)) ?? (() => {});
}

// Go returns null for empty JSON fields; the UI expects objects.
const fix = (e: Entry | null): Entry | null => (e ? { ...e, meta: e.meta ?? {}, kind: e.kind || "page", parentId: e.parentId ?? null } : null);

async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const store: DiaryStore = {
  platform: "desktop",

  getEntry: async (id) => fix(await app().GetEntry(id)),
  getEntryForDate: async (d) => fix(await app().GetEntryForDate(d)),
  listRange: async (from, to) => (await app().ListRange(from, to)) ?? [],
  listRecent: async (limit) => (await app().ListRecent(limit)) ?? [],
  listChildren: async (parentId) => ((await app().ListChildren(parentId)) ?? []).map((e) => fix(e)!),
  listPages: async () => (await app().ListPages()) ?? [],
  backlinks: async (id) => (await app().Backlinks(id)) ?? [],
  search: async (q) => (await app().Search(q)) ?? [], // local FTS5, works offline
  async saveEntry(draft, base) {
    // writes SQLite + outbox, returns immediately
    const r = await app().SaveEntry(draft, base);
    return r.status === "conflict" ? r : { ...r, entry: fix(r.entry)! };
  },
  deleteEntry: (id, base) => app().DeleteEntry(id, base),
  uploadImage: async (file) => app().UploadImage(await toBase64(file)),

  onChanged: (cb) => on<string[]>("entries:changed", (ids) => cb(ids ?? [])),
  onSyncStatus: (cb) => on<SyncStatus>("sync:status", cb),
  getSyncStatus: () => app().GetSyncStatus(),
  onConflict: (cb) => on<ConflictEvent>("conflict:created", cb),
  onFlushRequest: (cb) => on<void>("app:flush", () => cb()),
  onImagesArrived: (cb) => on<string[]>("blobs:downloaded", (h) => cb(h ?? [])),

  calendar: {
    status: () => app().CalendarStatus(),
    connect: () => app().CalendarConnect(),
    disconnect: () => app().CalendarDisconnect(),
    async events(start, end) {
      const r = await app().CalendarEvents(start, end);
      return { connected: r.connected, stale: r.stale, events: (r.events ?? []).map(({ all_day, ...e }) => ({ ...e, allDay: all_day })) };
    },
  },

  drive: {
    async search(query, page) {
      const r = await app().DriveSearch(query, page ?? "");
      return { connected: r.connected, files: (r.files ?? []).map(fromWireDrive), next: r.next || undefined };
    },
    markdown: (id) => app().DriveMarkdown(id),
  },

  gitlab: {
    status: async () => fromWireGitLab(await app().GitLabStatus()),
    connect: async (url, token) => fromWireGitLab(await app().GitLabConnect(url, token)),
    sync: () => app().GitLabSync(),
    disconnect: () => app().GitLabDisconnect(),
  },

  ai: {
    status: () => app().AIStatus(),
    chat: async (messages, entryId) => fromWireAiReply(await app().AIChat(aiChatBody(messages, entryId))),
    actionsStatus: async () => fromWireActionsStatus(await app().ActionsStatus()),
    configureActions: async (enabled, names) => fromWireActionsStatus(await app().ActionsConfigure(enabled, names)),
    scanActions: async (entryId) => fromWireActionsScan(await app().ActionsScan(entryId ?? "")),
  },

  app: {
    getSettings: () => app().GetSettings(),
    connect: (url) => app().Connect(url),
    signIn: (url, pw) => app().SignIn(url, pw),
    disconnect: () => app().Disconnect(),
    syncNow: () => app().SyncNow(),
  },
};
