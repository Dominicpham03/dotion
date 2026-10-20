import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Download, File as FileIcon } from "lucide-react";

/** Human-readable size, e.g. "2.4 MB". */
function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

type Attrs = { src: string; name: string; mimeType: string; size: number };

/** A stored file shown as a card with a download link. The bytes live under
 *  /v1/blobs/<hash>; the name/type/size travel in the node's attrs. */
export const FileAttachment = Node.create({
  name: "fileAttachment",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return { src: { default: "" }, name: { default: "" }, mimeType: { default: "" }, size: { default: 0 } };
  },
  parseHTML() {
    return [
      {
        tag: "a[data-file-attachment]",
        getAttrs: (el) => {
          const d = (el as HTMLElement).dataset;
          return { src: d.src ?? "", name: d.name ?? "", mimeType: d.mimeType ?? "", size: Number(d.size) || 0 };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { src, name, mimeType, size } = node.attrs as Attrs;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-file-attachment": "",
        "data-src": src,
        "data-name": name,
        "data-mime-type": mimeType,
        "data-size": String(size),
        href: src,
        download: name || null,
      }),
      name || "File",
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentView);
  },
});

function FileAttachmentView({ node, selected }: NodeViewProps) {
  const { src, name, mimeType, size } = node.attrs as Attrs;
  const meta = [mimeType || "File", formatSize(size)].filter(Boolean).join(" · ");
  return (
    <NodeViewWrapper className="my-3" data-drag-handle="">
      <a
        href={src}
        download={name || undefined}
        className={`flex items-center gap-3 rounded-xl border bg-surface px-4 py-3 font-sans text-sm no-underline transition-colors hover:border-accent-strong/50 ${
          selected ? "border-accent-strong" : "border-line"
        }`}
      >
        <FileIcon size={20} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{name || "File"}</span>
          <span className="block text-xs text-muted">{meta}</span>
        </span>
        <Download size={16} className="shrink-0 text-muted" aria-hidden />
      </a>
    </NodeViewWrapper>
  );
}
