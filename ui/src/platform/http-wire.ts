// Wire formats (snake_case JSON from the server) shared by the web and Android adapters.
import type { ActionItem, ActionsStatus, AiMessage, AiReply, DriveFile, GitLabStatus } from "./types";

export type WireDriveFile = { id: string; name: string; mime_type: string; modified: string; link: string; owner?: string; can_import: boolean };

export const fromWireDrive = (f: WireDriveFile): DriveFile => ({
  id: f.id, name: f.name, mimeType: f.mime_type, modified: f.modified, link: f.link, owner: f.owner, canImport: f.can_import,
});

export type WireGitLab = { connected: boolean; url?: string; username?: string; database_id?: string; last_sync?: string; last_error?: string };

export const fromWireGitLab = (g: WireGitLab): GitLabStatus => ({
  connected: g.connected, url: g.url, username: g.username, databaseId: g.database_id, lastSync: g.last_sync, lastError: g.last_error,
});

export type WireAiReply = {
  text: string;
  sources: { id: string; title: string; entry_date: string | null }[] | null;
  proposals: { title: string; markdown: string; parent_id?: string }[] | null;
};

export const fromWireAiReply = (r: WireAiReply): AiReply => ({
  text: r.text,
  sources: (r.sources ?? []).map((s) => ({ id: s.id, title: s.title, entryDate: s.entry_date })),
  proposals: (r.proposals ?? []).map((p) => ({ title: p.title, markdown: p.markdown, parentId: p.parent_id || undefined })),
});

/** The body of POST /v1/ai/chat. */
export const aiChatBody = (messages: AiMessage[], entryId?: string) => ({ messages, entry_id: entryId ?? "", now: localNow() });

/** The local time with its UTC offset, e.g. 2026-10-17T14:03:00-05:00. */
export function localNow(d = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

export type WireActionItem = { id: string; title: string; due: string; source_id: string; source_title: string; event_link?: string };

export const fromWireActionItem = (a: WireActionItem): ActionItem => ({
  id: a.id, title: a.title, due: a.due, sourceId: a.source_id, sourceTitle: a.source_title, eventLink: a.event_link || undefined,
});

export type WireActionsScan = { scanned: number; created: WireActionItem[] | null };

export const fromWireActionsScan = (r: WireActionsScan) => ({ scanned: r.scanned, created: (r.created ?? []).map(fromWireActionItem) });

export type WireActionsStatus = {
  enabled: boolean;
  names: string[] | null;
  database_id: string;
  last_scan?: string;
  last_error?: string;
  calendar_connected: boolean;
  calendar_write: boolean;
};

export const fromWireActionsStatus = (s: WireActionsStatus): ActionsStatus => ({
  enabled: s.enabled, names: s.names ?? [], databaseId: s.database_id, lastScan: s.last_scan || undefined, lastError: s.last_error || undefined,
  calendarConnected: s.calendar_connected, calendarWrite: s.calendar_write,
});
