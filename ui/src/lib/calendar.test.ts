import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@/platform/types";
import { daysOf, eventsByDay, localMidnight, rangeFor } from "./calendar";

const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({ id: "x", title: "t", start: "", end: "", allDay: false, calendar: "c", ...p });

describe("calendar helpers", () => {
  it("builds local-midnight ranges", () => {
    const r = rangeFor("2026-10-01", "2026-10-31");
    expect(r.start.startsWith("2026-10-01T00:00:00")).toBe(true);
    expect(r.end.startsWith("2026-11-01T00:00:00")).toBe(true);
    expect(new Date(localMidnight("2026-10-05")).getHours()).toBe(0);
  });
  it("spreads all-day events over their days, end exclusive", () => {
    expect(daysOf(ev({ allDay: true, start: "2026-10-05", end: "2026-10-08" }))).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(daysOf(ev({ allDay: true, start: "2026-10-05", end: "2026-10-06" }))).toEqual(["2026-10-05"]);
  });
  it("keeps a timed event ending at midnight on its own day", () => {
    const start = new Date(2026, 9, 5, 22, 0).toISOString();
    const end = new Date(2026, 9, 6, 0, 0).toISOString();
    expect(daysOf(ev({ start, end }))).toEqual(["2026-10-05"]);
    const late = new Date(2026, 9, 6, 1, 0).toISOString();
    expect(daysOf(ev({ start, end: late }))).toEqual(["2026-10-05", "2026-10-06"]);
  });
  it("groups by day", () => {
    const m = eventsByDay([ev({ id: "a", allDay: true, start: "2026-10-05", end: "2026-10-07" }), ev({ id: "b", allDay: true, start: "2026-10-06", end: "2026-10-07" })]);
    expect(m.get("2026-10-05")?.map((e) => e.id)).toEqual(["a"]);
    expect(m.get("2026-10-06")?.map((e) => e.id)).toEqual(["a", "b"]);
  });
});
