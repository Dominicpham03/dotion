import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { EmbeddedDatabase } from "@/features/database/EmbeddedDatabase";

/** A live view of a database inside a page: the building block of dashboards. */
export const DatabaseView = Node.create({
  name: "databaseView",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return { databaseId: { default: null }, viewId: { default: null }, title: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-database-view]", getAttrs: (el) => ({ databaseId: (el as HTMLElement).dataset.databaseId, viewId: (el as HTMLElement).dataset.viewId }) }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-database-view": "", "data-database-id": node.attrs.databaseId, "data-view-id": node.attrs.viewId }), node.attrs.title];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DatabaseViewNode);
  },
});

function DatabaseViewNode({ node, updateAttributes, selected, deleteNode, editor }: NodeViewProps) {
  return (
    <NodeViewWrapper className={`my-5 rounded-xl border p-1 font-sans text-sm leading-normal ${selected ? "border-accent-strong" : "border-transparent"}`}>
      <EmbeddedDatabase
        databaseId={node.attrs.databaseId as string}
        viewId={node.attrs.viewId as string | null}
        onViewChange={(viewId, title) => updateAttributes({ viewId, title })}
        onRemove={editor.isEditable ? deleteNode : undefined}
      />
    </NodeViewWrapper>
  );
}
