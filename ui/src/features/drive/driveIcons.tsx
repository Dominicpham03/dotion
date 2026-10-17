import { File, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation } from "lucide-react";

const KINDS: [test: (m: string) => boolean, label: string, icon: typeof File, color: string][] = [
  [(m) => m === "application/vnd.google-apps.document", "Google Doc", FileText, "text-[#4285f4]"],
  [(m) => m === "application/vnd.google-apps.spreadsheet", "Google Sheet", FileSpreadsheet, "text-[#0f9d58]"],
  [(m) => m === "application/vnd.google-apps.presentation", "Google Slides", Presentation, "text-[#f4b400]"],
  [(m) => m === "application/vnd.google-apps.folder", "Folder", Folder, "text-muted"],
  [(m) => m === "application/pdf", "PDF", FileText, "text-[#db4437]"],
  [(m) => m.startsWith("image/"), "Image", FileImage, "text-muted"],
  [(m) => m.startsWith("video/"), "Video", FileVideo, "text-muted"],
];

export function driveKind(mime: string): string {
  return KINDS.find(([t]) => t(mime))?.[1] ?? "File";
}

export function DriveIcon({ mimeType, size = 20 }: { mimeType: string; size?: number }) {
  const hit = KINDS.find(([t]) => t(mimeType));
  const Icon = hit?.[2] ?? File;
  return <Icon size={size} className={`shrink-0 ${hit?.[3] ?? "text-muted"}`} aria-hidden />;
}
