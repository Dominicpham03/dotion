import CharacterCount from "@tiptap/extension-character-count";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Typography from "@tiptap/extension-typography";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { DatabaseView } from "./nodes/DatabaseView";
import { DriveFile } from "./nodes/DriveFile";
import { FileAttachment } from "./nodes/FileAttachment";
import { LinkCard } from "./nodes/LinkCard";
import { PageLink } from "./nodes/PageLink";
import { store } from "@platform";

export const lowlight = createLowlight(common);

export const LANGUAGES = [
  ["", "Plain text"],
  ["bash", "Bash"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["go", "Go"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["kotlin", "Kotlin"],
  ["markdown", "Markdown"],
  ["php", "PHP"],
  ["python", "Python"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["typescript", "TypeScript"],
  ["xml", "HTML / XML"],
  ["yaml", "YAML"],
] as const;

// On Android, images live in on-device storage: resolve "/v1/blobs/<hash>"
// to a displayable URL. Elsewhere the src works as is.
const DiaryImage = store.resolveImage
  ? Image.extend({
      addNodeView() {
        return ({ node }) => {
          const img = document.createElement("img");
          img.className = "diary-image";
          img.alt = (node.attrs.alt as string) ?? "";
          img.dataset.src = node.attrs.src as string;
          void store.resolveImage!(node.attrs.src as string).then((u) => u && (img.src = u));
          return { dom: img };
        };
      },
    })
  : Image;

export const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false }),
  CodeBlockLowlight.configure({ lowlight, defaultLanguage: null, HTMLAttributes: { spellcheck: "false" } }),
  Placeholder.configure({ placeholder: "Write something, or type [[ to link a page" }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Link.configure({ openOnClick: false, autolink: true, protocols: ["http", "https"] }),
  Typography, // smart quotes, dashes
  CharacterCount, // word count in the footer
  Table.configure({ resizable: false, HTMLAttributes: { class: "diary-table" } }),
  TableRow,
  TableHeader,
  TableCell,
  DiaryImage.configure({ inline: false, allowBase64: false, HTMLAttributes: { class: "diary-image" } }),
  PageLink,
  LinkCard,
  DatabaseView,
  DriveFile,
  FileAttachment,
];
