import { useState } from "react";
import { Link } from "react-router-dom";
import { Banner, Button } from "@/components/ui";
import { diffLines } from "@/lib/diff";
import { extractText } from "@/lib/text";
import type { Entry } from "@/platform/types";

export function ConflictBanner({ current, copy, onDismiss }: { current: Entry; copy: Entry; onDismiss: () => void }) {
  const [comparing, setComparing] = useState(false);
  return (
    <>
      <Banner
        tone="warn"
        actions={
          <>
            <Button onClick={() => setComparing(true)}>Compare side by side</Button>
            <Link to={`/entry/${copy.id}`} className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium hover:bg-accent-soft">
              Open my copy
            </Link>
            <Button onClick={onDismiss}>Dismiss</Button>
          </>
        }
      >
        <p className="font-medium">⚠ This entry was also edited on another device.</p>
        <p className="text-muted">Your version was saved as “{copy.title}”.</p>
      </Banner>
      {comparing && <CompareDialog current={current} copy={copy} onClose={() => setComparing(false)} />}
    </>
  );
}

/** Both versions read-only next to each other with a plain-text diff, so the
 *  user can copy what they need from their copy. */
function CompareDialog({ current, copy, onClose }: { current: Entry; copy: Entry; onClose: () => void }) {
  const lines = diffLines(extractText(current.body), extractText(copy.body));
  const side = (keep: "removed" | "added", heading: string) => (
    <section className="flex min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-sm font-medium text-muted">{heading}</h3>
      <div className="overflow-auto rounded-md border border-line bg-paper p-3 font-serif text-[0.95rem] leading-relaxed">
        {lines
          .filter((l) => l.kind === "same" || l.kind === keep)
          .map((l, i) => (
            <p
              key={i}
              className={`min-h-[1.5em] whitespace-pre-wrap ${
                l.kind === "same" ? "" : keep === "removed" ? "bg-danger/10" : "bg-accent-soft"
              }`}
            >
              {l.kind !== "same" && <span className="sr-only">Only here: </span>}
              {l.text}
            </p>
          ))}
      </div>
    </section>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true" aria-label="Compare versions" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col gap-4 rounded-xl bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-serif text-xl font-semibold">Compare versions</h2>
          <Button autoFocus onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto md:flex-row">
          {side("removed", `Other device · “${current.title || "Untitled"}”`)}
          {side("added", `Your copy · “${copy.title}”`)}
        </div>
        <p className="text-xs text-muted">Highlighted lines appear on one side only. Copy what you need into the entry, then delete the copy.</p>
      </div>
    </div>
  );
}
