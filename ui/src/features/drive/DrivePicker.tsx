import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { Button, IconButton } from "@/components/ui";
import { relativeTime } from "@/lib/dates";
import { createPageFromMarkdown } from "@/lib/pages";
import { store } from "@platform";
import type { DriveFile } from "@/platform/types";
import { DriveIcon, driveKind } from "./driveIcons";

/** Creates a Dotion page from a Google Doc and returns its id. */
export async function importGoogleDoc(file: DriveFile, qc: ReturnType<typeof useQueryClient>, parentId: string | null = null): Promise<string> {
  const { name, markdown } = await store.drive.markdown(file.id);
  // Google's export starts with the title as a heading; the page title already says it.
  return createPageFromMarkdown(qc, name, markdown.replace(/^#\s+.*\n+/, ""), parentId);
}

/** Search Google Drive; pick a file to insert, or import a Google Doc. */
export function DrivePicker({ onPick, onClose }: { onPick?: (f: DriveFile) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const { data, isFetching, isError } = useQuery({
    queryKey: ["drive", q],
    queryFn: () => store.drive.search(q),
    placeholderData: (prev) => prev,
    retry: false,
  });

  const doImport = async (f: DriveFile) => {
    setBusy(f.id);
    setError("");
    try {
      const id = await importGoogleDoc(f, qc);
      onClose();
      navigate(`/entry/${id}`);
    } catch (e) {
      setError(`Couldn't import “${f.name}”: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // Rendered at the page root: a blurred toolbar would otherwise trap the fixed overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-4 pt-[10vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Google Drive"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[75vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface font-sans shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search size={17} className="text-muted" />
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search Google Drive"
            aria-label="Search Google Drive"
            className="h-9 flex-1 bg-transparent text-sm focus:outline-none focus-visible:outline-none"
          />
          <IconButton label="Close" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="px-2 py-2 text-sm text-danger">{error}</p>}
          {isError ? (
            <p className="px-3 py-6 text-center text-sm text-muted">Google Drive didn't answer. Check the connection and try again.</p>
          ) : data && !data.connected ? (
            <div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-sm text-muted">
              <p>Connect Google (with Drive) to search your files here.</p>
              <Link to="/settings#calendar" onClick={onClose} className="text-accent underline underline-offset-2">
                Open Settings → Google
              </Link>
            </div>
          ) : !data ? (
            <p className="px-3 py-6 text-center text-sm text-muted">Loading…</p>
          ) : data.files.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">{isFetching ? "Searching…" : `Nothing in Drive matches “${q}”.`}</p>
          ) : (
            <ul className="flex flex-col">
              {data.files.map((f) => (
                <li key={f.id} className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-ink/[0.05]">
                  <DriveIcon mimeType={f.mimeType} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {driveKind(f.mimeType)} · edited {relativeTime(f.modified)}
                      {f.owner ? ` · ${f.owner}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {f.canImport && (
                      <Button variant="outline" className="h-8 px-2.5 text-xs" disabled={busy !== null} onClick={() => void doImport(f)}>
                        <FileDown size={14} /> {busy === f.id ? "Importing…" : "Import as page"}
                      </Button>
                    )}
                    {onPick && (
                      <Button variant="primary" className="h-8 px-2.5 text-xs" onClick={() => onPick(f)}>
                        Insert
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-muted">Read-only: Dotion never changes your Drive.</p>
      </div>
    </div>,
    document.body,
  );
}
