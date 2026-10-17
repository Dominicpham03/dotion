import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, EmptyState, PageTitle, inputClass } from "@/components/ui";
import { useCalendarStatus } from "@/features/calendar/useCalendar";
import { DriveIcon, driveKind } from "@/features/drive/driveIcons";
import { importGoogleDoc } from "@/features/drive/DrivePicker";
import { openExternal } from "@/lib/external";
import { relativeTime, shortDate } from "@/lib/dates";
import { splitSnippet } from "@/lib/highlight";
import { store } from "@platform";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const q = params.get("q")?.trim() ?? "";

  // Debounce typing into the URL (which drives the query).
  useEffect(() => {
    const t = setTimeout(() => setParams(text.trim() ? { q: text } : {}, { replace: true }), 250);
    return () => clearTimeout(t);
  }, [text, setParams]);

  const { data: hits = [], isFetching, isError } = useQuery({
    queryKey: ["search", q],
    queryFn: () => store.search(q),
    enabled: q.length > 0,
    placeholderData: (prev) => prev,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>Search</PageTitle>
      <input
        id="search-input"
        type="search"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Words from a title or entry"
        aria-label="Search entries"
        className={inputClass}
      />
      {store.platform !== "web" && <p className="-mt-4 text-xs text-muted">Searches this device, so it works offline.</p>}

      {isError && <p className="text-danger">Search failed. Check the connection and try again.</p>}
      {q && !isFetching && hits.length === 0 && !isError && <EmptyState>Nothing matches “{q}”.</EmptyState>}

      <ul className="flex flex-col divide-y divide-line">
        {hits.map((h) => (
          <li key={h.id}>
            <Link to={h.entryDate ? `/day/${h.entryDate}` : `/entry/${h.id}`} className="flex flex-col gap-1 rounded px-2 py-3 hover:bg-accent-soft/50">
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-serif text-lg font-semibold">{h.title || "Untitled"}</span>
                {h.entryDate && <span className="text-xs text-muted tabular-nums">{shortDate(h.entryDate)}</span>}
              </span>
              <span className="font-serif text-[0.95rem] text-muted">
                {splitSnippet(h.snippet).map((p, i) =>
                  p.hit ? (
                    <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-ink">
                      {p.text}
                    </mark>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {q && <DriveResults q={q} />}
    </div>
  );
}

/** Matching Google Drive files, when Google is connected with Drive access. */
function DriveResults({ q }: { q: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: status } = useCalendarStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["drive", q],
    queryFn: () => store.drive.search(q),
    enabled: !!status?.drive,
    retry: false,
  });
  if (!status?.drive || !data?.connected || data.files.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Google Drive results">
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Google Drive</h2>
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {data.files.slice(0, 10).map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-3 py-2.5">
            <DriveIcon mimeType={f.mimeType} />
            <button type="button" onClick={() => openExternal(f.link)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-medium hover:text-accent">{f.name}</span>
              <span className="block text-xs text-muted">
                {driveKind(f.mimeType)} · edited {relativeTime(f.modified)}
              </span>
            </button>
            {f.canImport && (
              <Button
                variant="outline"
                className="h-8 px-2.5 text-xs"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(f.id);
                  try {
                    navigate(`/entry/${await importGoogleDoc(f, qc)}`);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === f.id ? "Importing…" : "Import as page"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
