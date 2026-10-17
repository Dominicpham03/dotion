import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { eventsByDay, rangeFor } from "@/lib/calendar";
import { store } from "@platform";

export function useCalendarStatus() {
  return useQuery({ queryKey: ["calendar-status"], queryFn: () => store.calendar.status(), staleTime: 5 * 60_000, retry: false });
}

/** Events for the days from..to, grouped by local day. Off when not connected. */
export function useEvents(from: string, to: string) {
  const status = useCalendarStatus();
  const { start, end } = rangeFor(from, to);
  const q = useQuery({
    queryKey: ["events", start, end],
    queryFn: () => store.calendar.events(start, end),
    enabled: !!status.data?.connected,
    staleTime: 60_000,
    retry: 1,
  });
  return { byDay: eventsByDay(q.data?.events ?? []), stale: !!q.data?.stale, error: q.isError, connected: !!status.data?.connected };
}

/** Starts the Google sign-in. Apps open the browser, so this polls until the
 *  connection shows up (for up to 3 minutes). */
export function useConnectCalendar() {
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => () => clearInterval(timer.current), []);

  const connect = useCallback(async () => {
    setError("");
    try {
      await store.calendar.connect();
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (store.platform === "web") return; // the page is leaving for Google
    setWaiting(true);
    const started = Date.now();
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const st = await store.calendar.status().catch(() => null);
      if (st?.connected || Date.now() - started > 3 * 60_000) {
        clearInterval(timer.current);
        setWaiting(false);
        await qc.invalidateQueries({ queryKey: ["calendar-status"] });
        await qc.invalidateQueries({ queryKey: ["events"] });
      }
    }, 3000);
  }, [qc]);

  return { connect, waiting, error };
}
