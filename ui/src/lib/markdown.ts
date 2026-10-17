// Markdown → editor document, for importing Google Docs as pages.
import { generateJSON } from "@tiptap/html";
import { marked } from "marked";
import { extensions } from "@/editor/extensions";
import type { JSONContent } from "@/platform/types";

/** Converts Markdown to a ProseMirror document through the editor's own
 *  schema, so only content the editor supports survives (no raw HTML). */
export function markdownToDoc(md: string): JSONContent {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
  // Drop raw HTML blocks and images pointing elsewhere: Dotion stores its own images.
  const clean = html.replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "").replace(/<img[^>]*>/gi, "");
  return generateJSON(clean, extensions) as JSONContent;
}
