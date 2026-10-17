// The UI talks only to DiaryStore; the build picks http.ts or wails.ts.
import type { JSONContent } from "@tiptap/react";

export type { JSONContent };
export type EntryId = string;
export type EntryKind = "page" | "database";

// ---- databases ---------------------------------------------------------------

export type PropType = "text" | "number" | "select" | "multi_select" | "status" | "date" | "checkbox" | "url" | "relation";
export type OptionColor = "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

export interface SelectOption {
  id: string; // "opt_…"
  name: string;
  color: OptionColor;
}

export interface PropertyDef {
  id: string; // "p_…"
  name: string;
  type: PropType;
  options?: SelectOption[]; // select, multi_select, status
  relationDatabaseId?: string; // relation: records of this database (any page if unset)
}

export type FilterOp = "is" | "is_not" | "contains" | "empty" | "not_empty" | "before" | "after" | "gt" | "lt";

export interface ViewFilter {
  propertyId: string; // a property id, or "title"
  op: FilterOp;
  value?: PropValue;
}

export interface ViewSort {
  propertyId: string; // a property id, "title", "created" or "updated"
  direction: "asc" | "desc";
}

export interface ViewDef {
  id: string;
  name: string;
  type: "table" | "board" | "calendar";
  groupBy?: string; // board: a select or status property
  dateProperty?: string; // calendar
  filters: ViewFilter[];
  sorts: ViewSort[];
  hidden?: string[]; // property ids hidden in this view
}

export interface DatabaseSchema {
  properties: PropertyDef[];
  views: ViewDef[];
}

export type PropValue = string | number | boolean | string[] | null;

export interface EntryMeta {
  icon?: string; // an emoji
  props?: Record<string, PropValue>; // database record values, by property id
  schema?: DatabaseSchema; // only on databases
}

// ---- entries -------------------------------------------------------------

export interface Entry {
  id: EntryId;
  entryDate: string | null; // "2026-10-05"
  kind: EntryKind;
  parentId: EntryId | null; // parent page, or the database of a record
  title: string;
  body: JSONContent; // TipTap / ProseMirror JSON
  meta: EntryMeta;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface EntryDraft {
  id: EntryId;
  entryDate: string | null;
  kind: EntryKind;
  parentId: EntryId | null;
  title: string;
  body: JSONContent;
  meta: EntryMeta;
}

export interface EntrySummary {
  id: EntryId;
  entryDate: string | null;
  kind: EntryKind;
  parentId: EntryId | null;
  icon: string;
  title: string;
  preview: string; // first ~140 characters of plain text
  words: number;
  updatedAt: string;
}

export interface SearchHit {
  id: EntryId;
  entryDate: string | null;
  title: string;
  snippet: string; // matches wrapped in [ ]
}

export type SaveResult =
  | { status: "saved"; entry: Entry }
  | { status: "queued"; entry: Entry } // desktop: saved locally, will sync
  | { status: "conflict"; current: Entry; copy: Entry }; // conflict copy already created

export type SyncStatus =
  | { state: "synced"; at?: string; pending?: number }
  | { state: "syncing"; message?: string; pending?: number }
  | { state: "offline"; pending: number }
  | { state: "error"; message: string; pending?: number }
  | { state: "disconnected" };

export interface ConflictEvent {
  id: EntryId;
  copyId: EntryId;
}

export interface AppSettings {
  serverUrl: string;
  login: string;
  lastSyncAt: string;
  pending: number;
  status: SyncStatus;
  dataPath: string;
}

export interface ConnectResult {
  ok: boolean;
  needsPassword: boolean;
  login: string;
  message: string;
}

// ---- Google Calendar (read-only, through the diary server) ---------------

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // "2026-10-05" when all-day, else an ISO time
  end: string; // exclusive
  allDay: boolean;
  location?: string;
  link?: string; // opens the event in Google Calendar
  calendar: string;
  color?: string;
}

export interface CalendarStatus {
  configured: boolean; // the server has Google credentials
  connected: boolean;
  email?: string;
  redirectUri: string; // to paste into Google Cloud Console
  offline?: boolean; // the server couldn't be reached
  drive?: boolean; // the Google connection can read Drive
  calendarWrite?: boolean; // the Google connection can add events (action items)
}

// ---- Google Drive (read-only) and GitLab, through the Dotion server -------

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modified: string;
  link: string; // opens the file in Google Drive
  owner?: string;
  canImport: boolean; // a Google Doc: can become a Dotion page
}

export interface DriveApi {
  search(query: string, page?: string): Promise<{ connected: boolean; files: DriveFile[]; next?: string }>;
  /** A Google Doc as Markdown, for importing as a page. */
  markdown(fileId: string): Promise<{ name: string; markdown: string }>;
}

export interface GitLabStatus {
  connected: boolean;
  url?: string;
  username?: string;
  databaseId?: string; // the "GitLab" database
  lastSync?: string;
  lastError?: string;
  offline?: boolean;
}

export interface GitLabApi {
  status(): Promise<GitLabStatus>;
  connect(url: string, token: string): Promise<GitLabStatus>;
  sync(): Promise<{ created: number; updated: number; pushed: number }>;
  disconnect(): Promise<void>;
}

export interface CalendarApi {
  status(): Promise<CalendarStatus>;
  /** Web: leaves the page for Google. Apps: opens the browser; poll status() after. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** start and end are ISO instants in the viewer's time zone. */
  events(start: string, end: string): Promise<{ connected: boolean; events: CalendarEvent[]; stale?: boolean }>;
}

// ---- Gemini assistant and action items (through the Dotion server; online only) ----

export interface AiStatus {
  enabled: boolean; // the server has a Gemini API key
  model?: string;
}

export interface AiMessage {
  role: "user" | "model";
  text: string;
}

export interface AiSource {
  id: EntryId;
  title: string;
  entryDate: string | null;
}

/** A page Gemini drafted; nothing is saved until the user creates it. */
export interface AiProposal {
  title: string;
  markdown: string;
  parentId?: EntryId;
}

export interface AiReply {
  text: string; // Markdown; [Title](dotion:<id>) links to a page
  sources: AiSource[];
  proposals: AiProposal[];
}

export interface ActionItem {
  id: EntryId; // its record in the Action items database
  title: string;
  due: string; // YYYY-MM-DD
  sourceId: EntryId;
  sourceTitle: string;
  eventLink?: string; // the Google Calendar event, when one was added
}

export interface ActionsStatus {
  enabled: boolean; // scan changed notes automatically
  names: string[]; // what the user is called in notes
  databaseId: string;
  lastScan?: string;
  lastError?: string;
  calendarConnected: boolean;
  calendarWrite: boolean;
}

export interface AiApi {
  status(): Promise<AiStatus>;
  /** Answers the last user message; entryId is the page open on screen. */
  chat(messages: AiMessage[], entryId?: EntryId): Promise<AiReply>;
  actionsStatus(): Promise<ActionsStatus>;
  configureActions(enabled: boolean, names: string[]): Promise<ActionsStatus>;
  /** One page now, or (without entryId) every note changed since the last scan. */
  scanActions(entryId?: EntryId): Promise<{ scanned: number; created: ActionItem[] }>;
}

// ---- Android notifications -----------------------------------------------

export type NotificationPermission = "granted" | "denied" | "prompt";

export interface ReminderSettings {
  daily: string | null; // "20:00": a nudge to write today's entry; null = off
  due: boolean; // records with a due date (Action items, GitLab, any database)
  dueTime: string; // "09:00": when due-today reminders arrive
  events: boolean; // Google Calendar events, 10 minutes before
}

export interface NotificationsApi {
  permission(): Promise<NotificationPermission>;
  /** Shows Android's "Allow notifications?" prompt (after a refusal, only system Settings can change it). */
  request(): Promise<NotificationPermission>;
  getSettings(): ReminderSettings;
  /** Saves and reschedules. */
  setSettings(s: ReminderSettings): Promise<void>;
  /** Schedules every reminder again from the current data. Returns how many are pending. */
  reschedule(): Promise<number>;
  test(): Promise<void>;
}

/** Only in the local-first apps (desktop and Android): server connection and sync. */
export interface AppApi {
  getSettings(): Promise<AppSettings>;
  connect(serverUrl: string): Promise<ConnectResult>;
  signIn(serverUrl: string, password: string): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  syncNow(): Promise<void>;
}

export interface Me {
  login: string;
  authMode: string; // "tailscale" | "password"
}

/** Only in the web build. */
export interface WebApi {
  me(): Promise<Me>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  exportUrl: string;
}

export interface DiaryStore {
  platform: "web" | "desktop" | "mobile";

  getEntry(id: EntryId): Promise<Entry | null>;
  getEntryForDate(date: string): Promise<Entry | null>;
  listRange(from: string, to: string): Promise<EntrySummary[]>;
  listRecent(limit: number): Promise<EntrySummary[]>;
  /** Sub-pages of a page, or the records of a database (full entries). */
  listChildren(parentId: EntryId): Promise<Entry[]>;
  /** Undated pages and databases with no parent: the sidebar tree roots. */
  listPages(): Promise<EntrySummary[]>;
  backlinks(id: EntryId): Promise<EntrySummary[]>;
  search(query: string): Promise<SearchHit[]>;

  saveEntry(draft: EntryDraft, baseVersion: number): Promise<SaveResult>;
  deleteEntry(id: EntryId, baseVersion: number): Promise<void>;
  /** Stores an image and returns its src ("/v1/blobs/<hash>"). */
  uploadImage(file: Blob): Promise<string>;
  /** Android: turns "/v1/blobs/<hash>" into a displayable URL (null: not downloaded yet). */
  resolveImage?(src: string): Promise<string | null>;

  onChanged(cb: (ids: EntryId[] | "all") => void): () => void; // returns unsubscribe
  onSyncStatus(cb: (s: SyncStatus) => void): () => void;
  getSyncStatus(): Promise<SyncStatus>;
  /** Desktop: the sync engine made a conflict copy. Web conflicts come back from saveEntry. */
  onConflict(cb: (e: ConflictEvent) => void): () => void;
  /** Desktop: the window is closing, flush autosave now. */
  onFlushRequest(cb: () => void): () => void;
  /** Desktop: images finished downloading. */
  onImagesArrived(cb: (hashes: string[]) => void): () => void;

  calendar: CalendarApi;
  drive: DriveApi;
  gitlab: GitLabApi;
  ai: AiApi;
  /** Android only. */
  notifications?: NotificationsApi;
  app?: AppApi;
  web?: WebApi;
}

/** Thrown when the server answers 401: show the sign-in screen. */
export class AuthRequired extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "AuthRequired";
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.message === "string" ? body.message : `Server error ${status}`);
    this.name = "ApiError";
  }
}
