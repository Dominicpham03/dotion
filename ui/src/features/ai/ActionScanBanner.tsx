import { CalendarCheck, ListChecks } from "lucide-react";
import { Link } from "react-router-dom";
import { Banner, Button } from "@/components/ui";
import { shortDate } from "@/lib/dates";
import { openExternal } from "@/lib/external";
import type { ActionItem } from "@/platform/types";

export type ScanState =
  | { status: "running" }
  | { status: "done"; result: { scanned: number; created: ActionItem[] } }
  | { status: "error"; message: string };

/** The outcome of "Find my action items" on a page. */
export function ActionScanBanner({ state, name, onDismiss }: { state: ScanState; name: string; onDismiss: () => void }) {
  if (state.status === "running") {
    return (
      <Banner>
        <span className="flex items-center gap-2" role="status">
          <ListChecks size={15} className="animate-pulse text-accent" /> {name} is reading this page for your action items…
        </span>
      </Banner>
    );
  }
  if (state.status === "error") {
    return (
      <Banner tone="warn" actions={<Button onClick={onDismiss}>OK</Button>}>
        Couldn't look for action items: {state.message}
      </Banner>
    );
  }
  const items = state.result.created;
  return (
    <Banner actions={<Button onClick={onDismiss}>Done</Button>}>
      {items.length === 0 ? (
        <p>No new action items with a due date for you on this page.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="font-medium">
            Added {items.length} action item{items.length === 1 ? "" : "s"}
            {items.some((i) => i.eventLink) ? " to Action items and Google Calendar" : " to Action items"}:
          </p>
          <ul className="flex flex-col gap-1">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-2">
                <Link to={`/entry/${i.id}`} className="text-accent underline underline-offset-2">
                  {i.title}
                </Link>
                <span className="text-xs text-muted">due {shortDate(i.due)}</span>
                {i.eventLink && (
                  <button type="button" onClick={() => openExternal(i.eventLink!)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent">
                    <CalendarCheck size={13} /> in Calendar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Banner>
  );
}
