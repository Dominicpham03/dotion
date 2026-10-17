import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useState } from "react";
import { openExternal } from "@/lib/external";

export const isUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s.trim());

/** A link shown as a card. Nothing is fetched from the other site (the diary
 *  stays private and offline): the title is whatever you type. */
export const LinkCard = Node.create({
  name: "linkCard",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return { url: { default: "" }, title: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-link-card]", getAttrs: (el) => ({ url: (el as HTMLElement).dataset.url, title: (el as HTMLElement).textContent }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-link-card": "", "data-url": node.attrs.url }), node.attrs.title || node.attrs.url];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LinkCardView);
  },
});

function LinkCardView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const url = node.attrs.url as string;
  const [draft, setDraft] = useState(url);
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    // not a URL yet
  }
  const editable = editor.isEditable;

  return (
    <NodeViewWrapper className={`my-3 rounded-lg border bg-surface ${selected ? "border-accent" : "border-line"}`} data-drag-handle="">
      {!url ? (
        <form
          className="flex gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (isUrl(draft)) updateAttributes({ url: draft.trim() });
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste a link, e.g. https://go.dev/doc"
            aria-label="Link address"
            className="h-9 min-w-0 flex-1 rounded border border-line bg-paper px-2 font-sans text-sm"
          />
          <button type="submit" className="rounded px-3 text-sm text-accent hover:bg-accent-soft">
            Add
          </button>
        </form>
      ) : (
        <div className="flex items-start gap-3 p-3 font-sans">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-soft text-accent" aria-hidden>
            ↗
          </span>
          <div className="min-w-0 flex-1">
            {editable ? (
              <input
                value={node.attrs.title as string}
                onChange={(e) => updateAttributes({ title: e.target.value })}
                placeholder={host || "Add a title"}
                aria-label="Link title"
                className="w-full bg-transparent text-[0.95rem] font-medium text-ink placeholder:text-muted focus:outline-none"
              />
            ) : (
              <p className="text-[0.95rem] font-medium">{(node.attrs.title as string) || host}</p>
            )}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                openExternal(url);
              }}
              className="block truncate text-xs text-accent underline-offset-2 hover:underline"
            >
              {url}
            </a>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}
