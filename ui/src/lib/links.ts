// TypeScript twins of shared/prosemirror (ExtractLinks, ExtractImages,
// BlobHash) and shared/model (MetaLinks, MetaText), for the Android app's
// local store. Keep the rules identical to the Go versions.
import type { EntryMeta, JSONContent } from "@/platform/types";

export const BLOB_PREFIX = "/v1/blobs/";
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const OPTION = /^opt_[A-Za-z0-9]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

function visit(n: JSONContent | null | undefined, fn: (n: JSONContent) => void): void {
  if (!n) return;
  fn(n);
  n.content?.forEach((c) => visit(c, fn));
}

/** "/v1/blobs/<64 hex>" → the hash, else "". */
export function blobHash(src: string | null | undefined): string {
  if (!src?.startsWith(BLOB_PREFIX)) return "";
  const h = src.slice(BLOB_PREFIX.length).split("?")[0];
  return /^[0-9a-f]{64}$/.test(h) ? h : "";
}

/** Entry ids a document points to: page links and embedded database views. */
export function extractLinks(body: JSONContent | null | undefined): string[] {
  const out = new Set<string>();
  visit(body, (n) => {
    const id = n.type === "pageLink" ? n.attrs?.id : n.type === "databaseView" ? n.attrs?.databaseId : null;
    if (typeof id === "string" && id) out.add(id.toLowerCase());
  });
  return [...out].sort();
}

export function extractImages(body: JSONContent | null | undefined): string[] {
  const out = new Set<string>();
  visit(body, (n) => {
    if (n.type === "image") {
      const h = blobHash(n.attrs?.src);
      if (h) out.add(h);
    }
  });
  return [...out].sort();
}

/** Every UUID inside an array-valued property (relations). */
export function metaLinks(meta: EntryMeta | null | undefined): string[] {
  const out = new Set<string>();
  for (const v of Object.values(meta?.props ?? {})) {
    if (Array.isArray(v)) v.forEach((s) => typeof s === "string" && UUID.test(s) && out.add(s.toLowerCase()));
  }
  return [...out].sort();
}

/** Free-text property values, for search. */
export function metaText(meta: EntryMeta | null | undefined): string {
  const props = meta?.props ?? {};
  return Object.keys(props)
    .sort()
    .map((k) => props[k])
    .filter((v): v is string => typeof v === "string" && v !== "" && !UUID.test(v) && !OPTION.test(v) && !DATE.test(v))
    .join("\n");
}
