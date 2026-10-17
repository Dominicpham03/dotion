import { useEffect, useState } from "react";
import { store } from "@platform";
import type { SyncStatus } from "@/platform/types";

export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>({ state: "synced" });
  useEffect(() => {
    let live = true;
    store.getSyncStatus().then((s) => live && s && setStatus(s)).catch(() => {});
    const off = store.onSyncStatus((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}
