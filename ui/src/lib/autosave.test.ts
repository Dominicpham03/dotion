import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, EntryDraft, SaveResult } from "@/platform/types";
import { Autosave, DELAYS, type SaveState } from "./autosave";

const entry = (id: string, version: number, title = "t"): Entry => ({
  id, entryDate: null, kind: "page", parentId: null, title, body: { type: "doc" }, meta: {}, version, updatedAt: "", deletedAt: null,
});
const draft = (title: string): EntryDraft => ({ id: "e1", entryDate: null, kind: "page", parentId: null, title, body: { type: "doc" }, meta: {} });

function setup(save: (d: EntryDraft, base: number) => Promise<SaveResult>, initial = 0) {
  const states: SaveState[] = [];
  const saved: Entry[] = [];
  const conflicts: [Entry, Entry][] = [];
  const a = new Autosave(save, {
    onSaved: (e) => saved.push(e),
    onConflict: (c, cp) => conflicts.push([c, cp]),
    onState: (s) => states.push(s),
  }, initial);
  return { a, states, saved, conflicts };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Autosave", () => {
  it("debounces typing into one save", async () => {
    const save = vi.fn(async (d: EntryDraft, base: number) => ({ status: "saved", entry: entry(d.id, base + 1, d.title) }) as SaveResult);
    const { a, saved } = setup(save);
    a.change(draft("a"));
    a.change(draft("ab"));
    a.change(draft("abc"));
    await vi.advanceTimersByTimeAsync(DELAYS.debounce + 10);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].title).toBe("abc");
    expect(saved[0].version).toBe(1);
    expect(a.base).toBe(1);
  });

  it("saves at least every 10 s during continuous typing", async () => {
    const save = vi.fn(async (d: EntryDraft, base: number) => ({ status: "saved", entry: entry(d.id, base + 1) }) as SaveResult);
    const { a } = setup(save);
    for (let t = 0; t < DELAYS.maxWait + 500; t += 500) {
      a.change(draft(String(t)));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(save).toHaveBeenCalled();
  });

  it("keeps one save in flight and sends later edits on the new version", async () => {
    let release!: () => void;
    const calls: [string, number][] = [];
    const save = vi.fn((d: EntryDraft, base: number) => {
      calls.push([d.title, base]);
      if (calls.length === 1) {
        return new Promise<SaveResult>((r) => (release = () => r({ status: "saved", entry: entry(d.id, 1) })));
      }
      return Promise.resolve({ status: "saved", entry: entry(d.id, base + 1) } as SaveResult);
    });
    const { a } = setup(save);
    a.change(draft("first"));
    const first = a.flush();
    a.change(draft("typed during save"));
    await a.flush(); // ignored: a save is in flight
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(calls).toEqual([["first", 0], ["typed during save", 1]]);
    expect(a.base).toBe(2);
    expect(a.busy()).toBe(false);
  });

  it("reports a conflict and adopts the server version", async () => {
    const current = entry("e1", 5, "server");
    const copy = entry("copy", 1, "mine (conflict copy)");
    const { a, conflicts } = setup(async () => ({ status: "conflict", current, copy }), 3);
    a.change(draft("mine"));
    await a.flush();
    expect(conflicts).toEqual([[current, copy]]);
    expect(a.base).toBe(5);
  });

  it("keeps the draft and retries after an error", async () => {
    let fail = true;
    const save = vi.fn(async (d: EntryDraft) => {
      if (fail) throw new Error("offline");
      return { status: "saved", entry: entry(d.id, 1) } as SaveResult;
    });
    const { a, states } = setup(save);
    a.change(draft("x"));
    await a.flush();
    expect(states.at(-1)).toBe("error");
    expect(a.busy()).toBe(true);
    fail = false;
    await vi.advanceTimersByTimeAsync(DELAYS.retry + 10);
    expect(save).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("saved");
  });
});

describe("Autosave.edit", () => {
  it("builds each edit on the newest draft, so quick cell edits don't overwrite each other", async () => {
    const save = vi.fn(async (d: EntryDraft, base: number) => ({ status: "saved", entry: entry(d.id, base + 1, d.title) }) as SaveResult);
    const { a } = setup(save, 1);
    const fallback = { ...draft("t"), meta: { props: { p_a: "old" } } };
    a.edit(fallback, (d) => ({ ...d, meta: { props: { ...d.meta.props, p_a: "new" } } }));
    a.edit(fallback, (d) => ({ ...d, meta: { props: { ...d.meta.props, p_b: 2 } } }));
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].meta.props).toEqual({ p_a: "new", p_b: 2 });
    expect(save.mock.calls[0][1]).toBe(1);
  });
  it("adopts a newer version only when nothing is waiting", () => {
    const { a } = setup(async () => ({ status: "saved", entry: entry("e1", 1) }) as SaveResult, 1);
    expect(a.adopt(entry("e1", 3))).toBe(true);
    expect(a.base).toBe(3);
    a.change(draft("typing"));
    expect(a.adopt(entry("e1", 5))).toBe(false);
  });
});
