// The Android app's client for the /v1 API. In the app, Capacitor's native
// HTTP layer carries these requests (no CORS involved); tests pass a fake fetch.
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
} from "../http-wire";
import type { AiMessage, AiStatus, CalendarEvent, CalendarStatus, DriveFile, EntryKind, EntryMeta, JSONContent } from "../types";
import type { LocalEntry, PutPayload } from "./local";

export interface WireEntry {
  id: string;
  entry_date: string | null;
  kind?: EntryKind;
  parent_id?: string | null;
  title: string;
  body: JSONContent;
  meta?: EntryMeta | null;
  version: number;
  server_seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function fromWire(e: WireEntry): LocalEntry {
  return {
    id: e.id, entryDate: e.entry_date, kind: e.kind ?? "page", parentId: e.parent_id ?? null, title: e.title,
    body: e.body ?? { type: "doc", content: [] }, meta: e.meta ?? {}, version: e.version, serverSeq: e.server_seq,
    createdAt: e.created_at, updatedAt: e.updated_at, deletedAt: e.deleted_at,
  };
}

/** A non-2xx answer from the server. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.message === "string" ? body.message : `Server answered ${status}`);
  }
}

/** True when the request should be retried later: unreachable server or a 5xx. */
export const isNetwork = (e: unknown) => !(e instanceof HttpError) || e.status >= 500;

type Fetch = typeof fetch;

export class Api {
  constructor(
    private base: string,
    private token: string,
    private fetchFn: Fetch = (...a) => fetch(...a),
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { "X-Diary-Client": "1", ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (body instanceof Blob) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const res = await this.fetchFn(this.base + path, { method, headers, body: payload });
    const text = res.status === 204 ? "" : await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // not JSON
    }
    if (!res.ok) throw new HttpError(res.status, typeof data.error === "string" ? data.error : "", data);
    return data as T;
  }

  health = () => this.req<{ status: string }>("GET", "/v1/health");
  me = () => this.req<{ login: string; auth_mode: string }>("GET", "/v1/me");
  login = (password: string) => this.req<{ token: string; login: string }>("POST", "/v1/auth/login", { password });

  put(id: string, idemKey: string, baseVersion: number, p: PutPayload): Promise<LocalEntry> {
    return this.req<WireEntry>("PUT", `/v1/entries/${encodeURIComponent(id)}`, { base_version: baseVersion, ...p }, { "Idempotency-Key": idemKey }).then(fromWire);
  }

  delete(id: string, idemKey: string, baseVersion: number): Promise<LocalEntry> {
    return this.req<WireEntry>("DELETE", `/v1/entries/${encodeURIComponent(id)}?base_version=${baseVersion}`, undefined, { "Idempotency-Key": idemKey }).then(fromWire);
  }

  async sync(since: number, limit = 500): Promise<{ changes: LocalEntry[]; cursor: number; hasMore: boolean }> {
    const r = await this.req<{ changes: WireEntry[]; cursor: number; has_more: boolean }>("GET", `/v1/sync?since=${since}&limit=${limit}`);
    return { changes: r.changes.map(fromWire), cursor: r.cursor, hasMore: r.has_more };
  }

  /** Uploads image bytes. The body is a File so the native layer sends it as binary. */
  uploadBlob(data: Blob, type: string): Promise<{ hash: string }> {
    const file = typeof File !== "undefined" ? new File([data], "image", { type }) : data;
    return this.req("POST", "/v1/blobs", file, { "Content-Type": type || "application/octet-stream" });
  }

  async downloadBlob(hash: string): Promise<{ data: Blob; type: string }> {
    const headers: Record<string, string> = { "X-Diary-Client": "1" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchFn(`${this.base}/v1/blobs/${hash}`, { headers });
    if (!res.ok) throw new HttpError(res.status, "", {});
    const data = await res.blob();
    return { data, type: res.headers.get("Content-Type") ?? data.type };
  }

  async calendarStatus(): Promise<CalendarStatus> {
    const r = await this.req<{ configured: boolean; connected: boolean; email?: string; redirect_uri: string; drive?: boolean; calendar_write?: boolean }>(
      "GET",
      "/v1/integrations/google",
    );
    return { configured: r.configured, connected: r.connected, email: r.email, redirectUri: r.redirect_uri, drive: !!r.drive, calendarWrite: !!r.calendar_write };
  }

  calendarStart = () => this.req<{ url: string }>("POST", "/v1/integrations/google/start", { client: "app" });
  calendarDisconnect = () => this.req<unknown>("DELETE", "/v1/integrations/google");

  async driveSearch(query: string, page?: string): Promise<{ connected: boolean; files: DriveFile[]; next?: string }> {
    const q = new URLSearchParams({ q: query, ...(page ? { page } : {}) });
    const r = await this.req<{ connected: boolean; files: WireDriveFile[]; next?: string }>("GET", `/v1/drive/files?${q}`);
    return { connected: r.connected, files: r.files.map(fromWireDrive), next: r.next };
  }

  driveMarkdown = (id: string) => this.req<{ name: string; markdown: string }>("GET", `/v1/drive/files/${encodeURIComponent(id)}/markdown`);

  gitlabStatus = async () => fromWireGitLab(await this.req<WireGitLab>("GET", "/v1/integrations/gitlab"));
  gitlabConnect = async (url: string, token: string) => fromWireGitLab(await this.req<WireGitLab>("POST", "/v1/integrations/gitlab", { url, token }));
  gitlabSync = () => this.req<{ created: number; updated: number; pushed: number }>("POST", "/v1/integrations/gitlab/sync", {});
  gitlabDisconnect = () => this.req<unknown>("DELETE", "/v1/integrations/gitlab");

  aiStatus = () => this.req<AiStatus>("GET", "/v1/ai");
  aiChat = async (messages: AiMessage[], entryId?: string) =>
    fromWireAiReply(await this.req<WireAiReply>("POST", "/v1/ai/chat", aiChatBody(messages, entryId)));
  actionsStatus = async () => fromWireActionsStatus(await this.req<WireActionsStatus>("GET", "/v1/ai/actions"));
  actionsConfigure = async (enabled: boolean, names: string[]) =>
    fromWireActionsStatus(await this.req<WireActionsStatus>("PUT", "/v1/ai/actions", { enabled, names }));
  actionsScan = async (entryId?: string) =>
    fromWireActionsScan(await this.req<WireActionsScan>("POST", "/v1/ai/actions/scan", { entry_id: entryId ?? "" }));

  async calendarEvents(start: string, end: string): Promise<{ connected: boolean; events: CalendarEvent[] }> {
    const r = await this.req<{ connected: boolean; events: (Omit<CalendarEvent, "allDay"> & { all_day: boolean })[] }>(
      "GET",
      `/v1/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    );
    return { connected: r.connected, events: r.events.map(({ all_day, ...e }) => ({ ...e, allDay: all_day })) };
  }
}
