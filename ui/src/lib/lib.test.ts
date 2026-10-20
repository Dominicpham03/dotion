import { describe, expect, it } from "vitest";
import { addDays, addMonths, isDate, monthGrid, monthRange, relativeTime, toLocalDate } from "./dates";
import { diffLines } from "./diff";
import { splitSnippet } from "./highlight";
import { copyTitle, extractText, preview, wordCount } from "./text";
import { uuidv7 } from "./uuid";

describe("dates", () => {
  it("uses the local calendar, not UTC", () => {
    expect(toLocalDate(new Date(2026, 9, 5, 23, 59))).toBe("2026-10-05");
  });
  it("adds days across months and leap years", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("validates real dates only", () => {
    expect(isDate("2026-02-28")).toBe(true);
    expect(isDate("2026-02-30")).toBe(false);
    expect(isDate("26-1-1")).toBe(false);
  });
  it("builds a Sunday-first month grid", () => {
    const weeks = monthGrid("2026-10"); // 1 October 2026 is a Thursday
    expect(weeks[0]).toEqual([null, null, null, null, "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });
  it("computes month ranges and steps", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
  it("describes recent times", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(relativeTime("2026-10-05T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-05T11:55:00Z", now)).toBe("5 min ago");
  });
});

describe("text", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", content: [{ type: "text", text: "Monday" }] },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "Long " }, { type: "text", text: "day" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "tea" }] }] }] },
    ],
  };
  it("extracts one line per block, like the server", () => {
    expect(extractText(doc)).toBe("Monday\nLong day\ntea");
  });
  it("counts words and trims previews", () => {
    expect(wordCount("  a b\nc ")).toBe(3);
    expect(wordCount("")).toBe(0);
    expect(preview("x".repeat(200))).toHaveLength(141);
  });
  it("names conflict copies once", () => {
    expect(copyTitle("Monday")).toBe("Monday (conflict copy)");
    expect(copyTitle("Monday (conflict copy)")).toBe("Monday (conflict copy)");
    expect(copyTitle(" ")).toBe("Untitled (conflict copy)");
  });
});

describe("diff", () => {
  it("marks removed and added lines", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });
});

describe("highlight", () => {
  it("splits [matches] out of snippets", () => {
    expect(splitSnippet("walked along the [river] at [dusk]…")).toEqual([
      { text: "walked along the ", hit: false },
      { text: "river", hit: true },
      { text: " at ", hit: false },
      { text: "dusk", hit: true },
      { text: "…", hit: false },
    ]);
  });
});

describe("uuidv7", () => {
  it("is a time-ordered version 7 UUID", () => {
    const a = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
