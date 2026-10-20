import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "@platform";
import type { JSONContent } from "@/platform/types";
import { extensions } from "./extensions";
import { isUrl } from "./nodes/LinkCard";
import { Toolbar } from "./Toolbar";

type Props = {
  initialContent: JSONContent;
  onReady: (editor: Editor) => void;
  onUserChange: () => void;
  onBlur: () => void;
};

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 10 << 20; // 10 MB
const MAX_FILE_BYTES = 50 << 20; // 50 MB

/** TipTap editor. Content is ProseMirror JSON, never HTML: rendering goes
 *  through the schema, so unknown or unsafe markup cannot appear. */
export function DiaryEditor({ initialContent, onReady, onUserChange, onBlur }: Props) {
  const [error, setError] = useState("");
  const editorRef = useRef<Editor | null>(null);

  // Images render inline; any other file is stored and shown as a download card.
  const upload = useCallback(async (files: File[], pos?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    setError("");
    for (const file of files) {
      const isImage = IMAGE_TYPES.includes(file.type);
      if (!isImage && !store.uploadFile) {
        setError("Only PNG, JPEG, GIF and WebP images can be added.");
        continue;
      }
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.size > limit) {
        setError(`${file.name} is larger than ${isImage ? "10 MB" : "50 MB"}.`);
        continue;
      }
      try {
        const node = isImage
          ? { type: "image", attrs: { src: await store.uploadImage(file), alt: file.name.replace(/\.[^.]+$/, "") } }
          : { type: "fileAttachment", attrs: { src: await store.uploadFile!(file), name: file.name, mimeType: file.type, size: file.size } };
        if (pos !== undefined) ed.chain().focus().insertContentAt(pos, node).run();
        else ed.chain().focus().insertContent(node).run();
      } catch (e) {
        setError(`Couldn't add ${file.name}: ${(e as Error).message}`);
      }
    }
  }, []);

  const editor = useEditor({
    extensions,
    content: initialContent,
    editorProps: {
      attributes: { class: "diary-prose min-h-[40vh] py-4", "aria-label": "Entry text" },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length) {
          void upload(files);
          return true;
        }
        // A link pasted on its own line becomes a link card.
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const ed = editorRef.current;
        if (ed && isUrl(text) && ed.state.selection.$from.parent.textContent === "" && !ed.isActive("codeBlock")) {
          ed.chain().focus().insertContent({ type: "linkCard", attrs: { url: text.trim() } }).run();
          return true;
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (moved || !files.length) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void upload(files, pos);
        return true;
      },
    },
    onUpdate: () => onUserChange(), // setContent(..., false) from code does not fire this
    onBlur: () => onBlur(),
  });

  useEffect(() => {
    editorRef.current = editor;
    if (editor) onReady(editor);
  }, [editor, onReady]);

  if (!editor) return <div className="min-h-[40vh]" />;
  const words = editor.storage.characterCount?.words?.() ?? 0;
  return (
    <div className="flex flex-col">
      <Toolbar editor={editor} onUpload={(f) => void upload(f)} />
      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <EditorContent editor={editor} />
      <p className="mt-2 text-xs text-muted tabular-nums" aria-live="off">
        {words} {words === 1 ? "word" : "words"}
      </p>
    </div>
  );
}
