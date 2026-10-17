import { useQuery } from "@tanstack/react-query";
import { PluginKey } from "@tiptap/pm/state";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isConflictCopy } from "@/lib/text";
import { uuidv7 } from "@/lib/uuid";
import { store } from "@platform";

export type PageItem = { id: string; title: string; icon: string; create?: boolean };

/** Pages matching the text typed after "[[": root pages, recent entries and search hits. */
async function findPages(query: string): Promise<PageItem[]> {
  const q = query.trim().toLowerCase();
  const [pages, recent, hits] = await Promise.all([
    store.listPages().catch(() => []),
    store.listRecent(50).catch(() => []),
    q ? store.search(q).catch(() => []) : Promise.resolve([]),
  ]);
  const seen = new Set<string>();
  const out: PageItem[] = [];
  for (const p of [...pages, ...recent, ...hits.map((h) => ({ ...h, icon: "" }))]) {
    if (seen.has(p.id) || isConflictCopy(p.title)) continue;
    seen.add(p.id);
    if (!q || p.title.toLowerCase().includes(q)) out.push({ id: p.id, title: p.title || "Untitled", icon: p.icon ?? "" });
  }
  const items = out.slice(0, 8);
  if (q && !items.some((i) => i.title.toLowerCase() === q)) items.push({ id: uuidv7(), title: query.trim(), icon: "", create: true });
  return items;
}

/** An inline link to another page, typed as [[Title]]. The chip shows the
 *  page's current title, so renaming a page updates every link to it. */
export const PageLink = Node.create({
  name: "pageLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { id: { default: null }, title: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "a[data-page-link]", getAttrs: (el) => ({ id: (el as HTMLElement).dataset.id, title: (el as HTMLElement).textContent }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["a", mergeAttributes(HTMLAttributes, { "data-page-link": "", "data-id": node.attrs.id }), node.attrs.title || "Untitled"];
  },
  renderText({ node }) {
    return `[[${node.attrs.title}]]`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView);
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<PageItem, PageItem>({
        editor: this.editor,
        pluginKey: new PluginKey("pageLinkSuggest"),
        char: "[[",
        allowSpaces: true,
        items: ({ query }) => findPages(query),
        command: ({ editor, range, props }) => {
          if (props.create) {
            // Create the page right away so the link always points somewhere.
            void store.saveEntry(
              { id: props.id, entryDate: null, kind: "page", parentId: null, title: props.title, body: { type: "doc", content: [] }, meta: {} },
              0,
            );
          }
          editor
            .chain()
            .focus()
            .insertContentAt(range, [{ type: "pageLink", attrs: { id: props.id, title: props.title } }, { type: "text", text: " " }])
            .run();
        },
        render: () => {
          let r: ReactRenderer<SuggestHandle, SuggestProps> | null = null;
          const place = (rect: DOMRect | null | undefined) => {
            if (!r || !rect) return;
            Object.assign((r.element as HTMLElement).style, { position: "fixed", left: `${rect.left}px`, top: `${rect.bottom + 6}px`, zIndex: "60" });
          };
          return {
            onStart: (props) => {
              r = new ReactRenderer(SuggestList, { props, editor: props.editor });
              document.body.appendChild(r.element);
              place(props.clientRect?.());
            },
            onUpdate: (props) => {
              r?.updateProps(props);
              place(props.clientRect?.());
            },
            onKeyDown: (props) => (props.event.key === "Escape" ? (r?.element.remove(), true) : (r?.ref?.onKeyDown(props) ?? false)),
            onExit: () => {
              r?.element.remove();
              r?.destroy();
              r = null;
            },
          };
        },
      }),
    ];
  },
});

function PageLinkView({ node }: NodeViewProps) {
  const navigate = useNavigate();
  const id = node.attrs.id as string;
  const { data } = useQuery({ queryKey: ["entry", id], queryFn: () => store.getEntry(id), staleTime: 60_000, enabled: !!id });
  const gone = data === null || !!data?.deletedAt;
  const title = data?.title || (node.attrs.title as string) || "Untitled";
  return (
    <NodeViewWrapper as="span" className="inline">
      <a
        href="#"
        data-page-link=""
        className={`page-link ${gone ? "line-through opacity-60" : ""}`}
        title={gone ? "This page was deleted" : `Open ${title}`}
        onClick={(e) => {
          e.preventDefault();
          if (!gone) navigate(data?.entryDate && !data.parentId ? `/day/${data.entryDate}` : `/entry/${id}`);
        }}
      >
        {data?.meta.icon && <span aria-hidden>{data.meta.icon} </span>}
        {title}
      </a>
    </NodeViewWrapper>
  );
}

type SuggestProps = SuggestionProps<PageItem, PageItem>;
type SuggestHandle = { onKeyDown: (p: SuggestionKeyDownProps) => boolean };

const SuggestList = forwardRef<SuggestHandle, SuggestProps>(function SuggestList({ items, command }, ref) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowDown") return setIndex((i) => (i + 1) % Math.max(items.length, 1)), true;
      if (event.key === "ArrowUp") return setIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1)), true;
      if (event.key === "Enter" && items[index]) return command(items[index]), true;
      return false;
    },
  }));
  return (
    <div className="w-72 overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm shadow-lg" role="listbox" aria-label="Link to a page">
      {items.length === 0 ? (
        <p className="px-3 py-2 text-muted">Type a page title</p>
      ) : (
        items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => command(item)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === index ? "bg-accent-soft text-accent" : "hover:bg-accent-soft/60"}`}
          >
            <span aria-hidden className="w-5 text-center">{item.create ? "+" : item.icon || "📄"}</span>
            <span className="truncate">{item.create ? `New page “${item.title}”` : item.title}</span>
          </button>
        ))
      )}
    </div>
  );
});
