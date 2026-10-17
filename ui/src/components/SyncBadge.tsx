import { Link } from "react-router-dom";
import { relativeTime } from "@/lib/dates";
import { store } from "@platform";
import { useSyncStatus } from "@/hooks/useSyncStatus";

/** Desktop: sync state in the sidebar. Web: nothing (the reconnect bar covers it). */
export function SyncBadge() {
  const s = useSyncStatus();
  if (store.platform === "web") return null;

  let dot = "bg-muted";
  let label = "";
  switch (s.state) {
    case "synced":
      dot = (s.pending ?? 0) > 0 ? "bg-warn" : "bg-accent";
      label = s.at ? `Synced · ${relativeTime(s.at)}` : "Synced";
      break;
    case "syncing":
      dot = "bg-accent animate-pulse";
      label = s.message ? `Syncing · ${s.message}` : "Syncing…";
      break;
    case "offline":
      dot = "bg-warn";
      label = s.pending ? `Offline · ${s.pending} waiting` : "Offline";
      break;
    case "error":
      dot = "bg-danger";
      label = s.message;
      break;
    case "disconnected":
      label = "Not connected";
  }
  return (
    <Link to="/settings" className="flex items-center gap-2 rounded px-2 py-1 text-xs text-muted hover:text-ink" aria-live="polite">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  );
}
