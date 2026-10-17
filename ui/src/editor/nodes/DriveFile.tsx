import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { DriveIcon, driveKind } from "@/features/drive/driveIcons";
import { openExternal } from "@/lib/external";

/** A Google Drive file shown as a card; opens the file in Drive. */
export const DriveFile = Node.create({
  name: "driveFile",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return { fileId: { default: "" }, name: { default: "" }, mimeType: { default: "" }, link: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-drive-file]", getAttrs: (el) => ({ ...(el as HTMLElement).dataset }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-drive-file": "", "data-link": node.attrs.link }), node.attrs.name];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DriveFileView);
  },
});

function DriveFileView({ node, selected }: NodeViewProps) {
  const { name, mimeType, link } = node.attrs as { name: string; mimeType: string; link: string };
  return (
    <NodeViewWrapper className="my-3" data-drag-handle="">
      <a
        href={link}
        onClick={(e) => {
          e.preventDefault();
          openExternal(link);
        }}
        className={`flex items-center gap-3 rounded-xl border bg-surface px-4 py-3 font-sans text-sm no-underline transition-colors hover:border-accent-strong/50 ${
          selected ? "border-accent-strong" : "border-line"
        }`}
      >
        <DriveIcon mimeType={mimeType} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{name || "Google Drive file"}</span>
          <span className="block text-xs text-muted">Google Drive · {driveKind(mimeType)}</span>
        </span>
        <span className="text-xs text-muted">Open ↗</span>
      </a>
    </NodeViewWrapper>
  );
}
