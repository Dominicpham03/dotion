// A folder is a page that acts purely as a container for other pages, folders
// and databases — only folders can hold pages ("a page is not put inside a
// page"). New folders carry meta.folder; the 📁-icon check keeps folders made
// before that flag existed working too.
import type { EntryMeta } from "@/platform/types";

export const FOLDER_ICON = "📁";

export function isFolder(meta?: EntryMeta | { folder?: boolean; icon?: string } | null): boolean {
  return !!meta && (meta.folder === true || meta.icon === FOLDER_ICON);
}
