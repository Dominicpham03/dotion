import type { QueryClient } from "@tanstack/react-query";
import { markdownToDoc } from "@/lib/markdown";
import { saverFor } from "@/lib/savers";
import { uuidv7 } from "@/lib/uuid";

/** Saves a new page from Markdown (a Google Doc, a Gemini draft) and returns its id. */
export async function createPageFromMarkdown(qc: QueryClient, title: string, markdown: string, parentId: string | null = null, icon = "📄"): Promise<string> {
  const id = uuidv7();
  const s = saverFor(qc, id, 0);
  s.change({ id, entryDate: null, kind: "page", parentId, title, body: markdownToDoc(markdown), meta: { icon } }, 0);
  await s.flush();
  return id;
}
