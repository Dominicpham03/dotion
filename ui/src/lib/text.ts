import type { JSONContent } from "@/platform/types";

/** Plain text of a ProseMirror document, one line per text block. */
export function extractText(doc: JSONContent | null | undefined): string {
  const lines: string[] = [];
  const walk = (n: JSONContent, line: string[]): void => {
    if (n.type === "text") {
      line.push(n.text ?? "");
      return;
    }
    if (n.type === "hardBreak") {
      line.push("\n");
      return;
    }
    const children = n.content ?? [];
    const inline = children.some((c) => c.type === "text" || c.type === "hardBreak");
    if (inline) {
      const own: string[] = [];
      children.forEach((c) => walk(c, own));
      lines.push(own.join(""));
    } else {
      children.forEach((c) => walk(c, line));
    }
  };
  if (doc) walk(doc, []);
  return lines.join("\n").trim();
}

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === "" ? 0 : words.length;
}

export function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + "…" : flat;
}

export const EMPTY_DOC: JSONContent = { type: "doc", content: [] };

/** Structural equality for editor documents. */
export function sameDoc(a: JSONContent | null | undefined, b: JSONContent | null | undefined): boolean {
  return JSON.stringify(a ?? EMPTY_DOC) === JSON.stringify(b ?? EMPTY_DOC);
}

const COPY_SUFFIX = " (conflict copy)";

export function copyTitle(title: string): string {
  const t = title.trim() || "Untitled";
  return t.endsWith(COPY_SUFFIX) ? t : t + COPY_SUFFIX;
}

export function isConflictCopy(title: string): boolean {
  return title.endsWith(COPY_SUFFIX);
}
