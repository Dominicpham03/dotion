import { useQuery } from "@tanstack/react-query";
import { Bold, Code, Heading2, Heading3, Italic, Link2, List, ListOrdered, ListTodo, Plus, Quote, Strikethrough } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { useRef, useState, type ReactNode } from "react";
import { store } from "@platform";
import { LANGUAGES } from "./extensions";
import { DrivePicker } from "@/features/drive/DrivePicker";

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
      onClick={onClick}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-sm transition-colors ${
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-ink/[0.06] hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-1.5 h-5 w-px bg-line" aria-hidden />;

export function Toolbar({ editor, onImages }: { editor: Editor; onImages: (files: File[]) => void }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [menu, setMenu] = useState<"insert" | "database" | null>(null);
  const [drive, setDrive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const chain = () => editor.chain().focus();

  const openLink = () => {
    setHref(editor.getAttributes("link").href ?? "https://");
    setLinkOpen(true);
  };
  const applyLink = () => {
    const url = href.trim();
    if (!url || url === "https://") chain().extendMarkRange("link").unsetLink().run();
    else if (/^https?:\/\//i.test(url)) chain().extendMarkRange("link").setLink({ href: url }).run();
    setLinkOpen(false);
  };

  const inTable = editor.isActive("table");
  const inCode = editor.isActive("codeBlock");

  return (
    <div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center gap-0.5 border-b border-line bg-paper/95 px-2 py-1.5 backdrop-blur" role="toolbar" aria-label="Formatting">
      <Tool label="Bold (Ctrl+B)" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}>
        <Bold size={16} />
      </Tool>
      <Tool label="Italic (Ctrl+I)" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}>
        <Italic size={16} />
      </Tool>
      <Tool label="Strikethrough" active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough size={16} />
      </Tool>
      <Tool label="Inline code" active={editor.isActive("code")} onClick={() => chain().toggleCode().run()}>
        <Code size={16} />
      </Tool>
      <Sep />
      <Tool label="Heading" active={editor.isActive("heading", { level: 2 })} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={17} />
      </Tool>
      <Tool label="Subheading" active={editor.isActive("heading", { level: 3 })} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
        <Heading3 size={17} />
      </Tool>
      <Sep />
      <Tool label="Bullet list" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>
        <List size={17} />
      </Tool>
      <Tool label="Numbered list" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={17} />
      </Tool>
      <Tool label="Checklist" active={editor.isActive("taskList")} onClick={() => chain().toggleTaskList().run()}>
        <ListTodo size={17} />
      </Tool>
      <Tool label="Quote" active={editor.isActive("blockquote")} onClick={() => chain().toggleBlockquote().run()}>
        <Quote size={16} />
      </Tool>
      <Tool label="Link" active={editor.isActive("link")} onClick={openLink}>
        <Link2 size={16} />
      </Tool>
      <Sep />
      <div className="relative">
        <Tool label="Insert a block" active={menu !== null} onClick={() => setMenu(menu ? null : "insert")}>
          <span className="flex items-center gap-1 pr-0.5"><Plus size={16} /> Insert</span>
        </Tool>
        {menu && (
          <InsertMenu
            mode={menu}
            onClose={() => setMenu(null)}
            onDatabases={() => setMenu("database")}
            editor={editor}
            pickImage={() => fileInput.current?.click()}
            pickDrive={() => setDrive(true)}
          />
        )}
      </div>
      {drive && (
        <DrivePicker
          onClose={() => setDrive(false)}
          onPick={(f) => {
            chain().insertContent({ type: "driveFile", attrs: { fileId: f.id, name: f.name, mimeType: f.mimeType, link: f.link } }).run();
            setDrive(false);
          }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          onImages(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {inCode && (
        <select
          aria-label="Code language"
          value={(editor.getAttributes("codeBlock").language as string) ?? ""}
          onChange={(e) => chain().updateAttributes("codeBlock", { language: e.target.value || null }).run()}
          className="h-8 rounded border border-line bg-surface px-1 text-sm"
        >
          {LANGUAGES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      )}
      {inTable && (
        <span className="flex flex-wrap items-center gap-1">
          <Sep />
          <Tool label="Add row below" onClick={() => chain().addRowAfter().run()}>
            + Row
          </Tool>
          <Tool label="Add column right" onClick={() => chain().addColumnAfter().run()}>
            + Col
          </Tool>
          <Tool label="Delete row" onClick={() => chain().deleteRow().run()}>
            − Row
          </Tool>
          <Tool label="Delete column" onClick={() => chain().deleteColumn().run()}>
            − Col
          </Tool>
          <Tool label="Delete table" onClick={() => chain().deleteTable().run()}>
            Delete table
          </Tool>
        </span>
      )}

      {linkOpen && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            id="link-href"
            autoFocus
            aria-label="Link address"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setLinkOpen(false)}
            className="h-8 w-56 rounded border border-line bg-surface px-2 text-sm"
          />
          <button type="submit" className="h-8 rounded px-2 text-sm text-accent hover:bg-accent-soft">
            Apply
          </button>
        </form>
      )}
    </div>
  );
}

function InsertMenu({
  mode, editor, onClose, onDatabases, pickImage, pickDrive,
}: { mode: "insert" | "database"; editor: Editor; onClose: () => void; onDatabases: () => void; pickImage: () => void; pickDrive: () => void }) {
  const chain = () => editor.chain().focus();
  const { data: pages = [] } = useQuery({ queryKey: ["pages"], queryFn: () => store.listPages(), enabled: mode === "database" });
  const databases = pages.filter((p) => p.kind === "database");

  const item = (label: string, hint: string, run: () => void) => (
    <button
      key={label}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        run();
        if (label !== "Database view") onClose();
      }}
      className="flex w-full flex-col items-start rounded px-3 py-1.5 text-left hover:bg-accent-soft"
    >
      <span className="text-sm">{label}</span>
      <span className="text-xs text-muted">{hint}</span>
    </button>
  );

  return (
    <div className="absolute left-0 top-9 z-30 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      {mode === "insert" ? (
        <>
          {item("Page link", "Type [[ anywhere, too", () => chain().insertContent("[[").run())}
          {item("Code block", "With syntax highlighting", () => chain().toggleCodeBlock().run())}
          {item("Table", "3 × 3 with a header row", () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
          {item("Image", "PNG, JPEG, GIF or WebP · or paste one", pickImage)}
          {item("Link card", "A link shown as a card", () => chain().insertContent({ type: "linkCard", attrs: { url: "" } }).run())}
          {item("Google Drive file", "Search Drive; import a Google Doc as a page", pickDrive)}
          {item("Database view", "Show a database inside this page", onDatabases)}
          {item("Divider", "A horizontal line", () => chain().setHorizontalRule().run())}
        </>
      ) : databases.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted">No databases yet. Create one from the sidebar first.</p>
      ) : (
        databases.map((db) =>
          item(`${db.icon || "▦"} ${db.title || "Untitled database"}`, "Insert a live view", () => {
            chain().insertContent({ type: "databaseView", attrs: { databaseId: db.id, title: db.title } }).run();
            onClose();
          }),
        )
      )}
    </div>
  );
}
