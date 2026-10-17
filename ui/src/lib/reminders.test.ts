import { describe, expect, it } from "vitest";
import type { CalendarEvent, Entry } from "@/platform/types";
import { renderAiMarkdown } from "./aiMarkdown";
import { DEFAULT_REMINDERS, dueInfo, planReminders, reminderId } from "./reminders";

const doc = { type: "doc", content: [] };
const entry = (e: Partial<Entry>): Entry => ({
  id: "x", entryDate: null, kind: "page", parentId: null, title: "", body: doc, meta: {}, version: 1, updatedAt: "", deletedAt: null, ...e,
});

const db = entry({
  id: "db1", kind: "database", title: "Action items", meta: {
    icon: "✅",
    schema: {
      properties: [
        { id: "p_status", name: "Status", type: "status", options: [{ id: "o_todo", name: "To do", color: "blue" }, { id: "o_done", name: "Done", color: "green" }] },
        { id: "p_start", name: "Started", type: "date" },
        { id: "p_due", name: "Due", type: "date" },
      ],
      views: [],
    },
  },
});
const rec = (id: string, due: string, status = "o_todo", extra: Partial<Entry> = {}) =>
  entry({ id, parentId: "db1", title: `Task ${id}`, meta: { props: { p_status: status, p_start: "2026-01-01", p_due: due } }, ...extra });

// Monday 19 October 2026, 10:00 local time.
const now = new Date(2026, 9, 19, 10, 0);

describe("planReminders", () => {
  it("reminds about due records that aren't done, at the chosen time", () => {
    const plan = planReminders(
      [db, rec("a", "2026-10-21"), rec("b", "2026-10-22", "o_done"), rec("c", "2026-10-01"), rec("d", "2026-12-25"), rec("e", "2026-10-23", "o_todo", { deletedAt: "x" })],
      [],
      DEFAULT_REMINDERS,
      now,
    );
    expect(plan.map((r) => r.title)).toEqual(["Due: Task a"]);
    expect(plan[0].at).toEqual(new Date(2026, 9, 21, 9, 0));
    expect(plan[0].body).toBe("✅ Action items");
    expect(plan[0].route).toBe("/entry/a");
  });

  it("uses the Due property, not the first date", () => {
    expect(dueInfo(rec("a", "2026-10-21"), db.meta.schema!.properties)).toEqual({ due: "2026-10-21", done: false });
  });

  it("still reminds today when the usual time has passed", () => {
    const [r] = planReminders([db, rec("a", "2026-10-19")], [], DEFAULT_REMINDERS, now);
    expect(r.title).toBe("Due today: Task a");
    expect(r.at!.getTime()).toBe(now.getTime() + 60_000);
  });

  it("adds event reminders and the daily nudge, and respects the switches", () => {
    const events: CalendarEvent[] = [
      { id: "ev1", title: "Standup", start: new Date(2026, 9, 19, 11, 0).toISOString(), end: "", allDay: false, calendar: "Work" },
      { id: "ev2", title: "Holiday", start: "2026-10-20", end: "2026-10-21", allDay: true, calendar: "Work" },
      { id: "ev3", title: "Already started", start: new Date(2026, 9, 19, 10, 5).toISOString(), end: "", allDay: false, calendar: "Work" },
    ];
    const plan = planReminders([db, rec("a", "2026-10-21")], events, { ...DEFAULT_REMINDERS, daily: "20:30" }, now);
    expect(plan.map((r) => r.title)).toEqual(["Time to write", "Standup", "Due: Task a"]);
    expect(plan[0]).toMatchObject({ id: 1, daily: { hour: 20, minute: 30 } });
    expect(plan[1].at).toEqual(new Date(2026, 9, 19, 10, 50));

    const off = planReminders([db, rec("a", "2026-10-21")], events, { daily: null, due: false, dueTime: "09:00", events: false }, now);
    expect(off).toEqual([]);
  });

  it("gives stable ids above the fixed ones", () => {
    expect(reminderId("due:a:2026-10-21")).toBe(reminderId("due:a:2026-10-21"));
    expect(reminderId("due:a:2026-10-21")).not.toBe(reminderId("due:a:2026-10-22"));
    expect(reminderId("x")).toBeGreaterThanOrEqual(10);
  });
});

describe("renderAiMarkdown", () => {
  it("formats Markdown and turns dotion: links into page links", () => {
    const html = renderAiMarkdown("**Due:** see [Standup](dotion:0192f0a0-1111-7000-8000-000000000001)\n\n- one");
    expect(html).toContain("<strong>Due:</strong>");
    expect(html).toContain('data-entry="0192f0a0-1111-7000-8000-000000000001"');
    expect(html).toContain("<li>one</li>");
  });

  it("never emits raw HTML, images or script links", () => {
    const html = renderAiMarkdown('<img src=x onerror="alert(1)"> ![a](https://evil/x.png) [x](javascript:alert(1)) [y](dotion:not-an-id) [z](https://example.com)');
    expect(html).not.toMatch(/<img|<script|javascript:|onerror="/);
    expect(html).toContain("&lt;img");
    expect(html).toContain('href="https://example.com" data-external="1"');
  });
});
