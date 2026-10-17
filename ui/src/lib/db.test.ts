import { describe, expect, it } from "vitest";
import type { DatabaseSchema, Entry, PropertyDef, ViewDef } from "@/platform/types";
import { applyView, formatValue, groupRecords, newProperty, presetFromView, withProp, toDraft } from "./db";

const status: PropertyDef = {
  id: "p_status", name: "Status", type: "status",
  options: [{ id: "opt_todo", name: "To do", color: "gray" }, { id: "opt_doing", name: "Doing", color: "blue" }, { id: "opt_done", name: "Done", color: "green" }],
};
const tags: PropertyDef = { id: "p_tags", name: "Tags", type: "multi_select", options: [{ id: "opt_a", name: "Alpha", color: "red" }] };
const due: PropertyDef = { id: "p_due", name: "Due", type: "date" };
const pts: PropertyDef = { id: "p_pts", name: "Points", type: "number" };
const done: PropertyDef = { id: "p_ok", name: "Reviewed", type: "checkbox" };
const schema: DatabaseSchema = { properties: [status, tags, due, pts, done], views: [] };

let n = 0;
const rec = (title: string, props: Entry["meta"]["props"]): Entry => ({
  id: `0192a3c4-7b1e-7c2a-9f00-00000000000${n++}`, entryDate: null, kind: "page", parentId: "db", title,
  body: { type: "doc" }, meta: { props }, version: 1, updatedAt: "", deletedAt: null,
});
const view = (v: Partial<ViewDef>): ViewDef => ({ id: "v", name: "v", type: "table", filters: [], sorts: [], ...v });

const a = rec("Write spec", { p_status: "opt_done", p_due: "2026-10-01", p_pts: 3, p_ok: true, p_tags: ["opt_a"] });
const b = rec("Build API", { p_status: "opt_doing", p_due: "2026-10-20", p_pts: 8 });
const c = rec("Ship it", {});
const all = [c, b, a];

describe("applyView", () => {
  it("filters by select, date and checkbox", () => {
    expect(applyView(all, schema, view({ filters: [{ propertyId: "p_status", op: "is", value: "opt_doing" }] }), "2026-10-10")).toEqual([b]);
    expect(applyView(all, schema, view({ filters: [{ propertyId: "p_due", op: "before", value: "today" }] }), "2026-10-10")).toEqual([a]);
    expect(applyView(all, schema, view({ filters: [{ propertyId: "p_ok", op: "is" }] }), "")).toEqual([a]);
    expect(applyView(all, schema, view({ filters: [{ propertyId: "p_due", op: "empty" }] }), "")).toEqual([c]);
    expect(applyView(all, schema, view({ filters: [{ propertyId: "title", op: "contains", value: "api" }] }), "")).toEqual([b]);
    expect(applyView(all, schema, view({ filters: [{ propertyId: "p_tags", op: "contains", value: "opt_a" }] }), "")).toEqual([a]);
    expect(applyView(all, schema, view({ filters: [{ propertyId: "p_pts", op: "gt", value: 5 }] }), "")).toEqual([b]);
  });
  it("ignores unfinished filters", () => {
    expect(applyView(all, schema, view({ filters: [{ propertyId: "p_status", op: "is" }] }), "")).toHaveLength(3);
  });
  it("sorts by option order and puts empty values last", () => {
    const sorted = applyView(all, schema, view({ sorts: [{ propertyId: "p_status", direction: "asc" }] }), "");
    expect(sorted.map((r) => r.title)).toEqual(["Build API", "Write spec", "Ship it"]);
    const desc = applyView(all, schema, view({ sorts: [{ propertyId: "p_pts", direction: "desc" }] }), "");
    expect(desc.map((r) => r.title)).toEqual(["Build API", "Write spec", "Ship it"]);
  });
});

describe("groupRecords", () => {
  it("makes one column per option plus No value", () => {
    const groups = groupRecords(all, status);
    expect(groups.map((g) => g.option?.name ?? "none")).toEqual(["none", "To do", "Doing", "Done"]);
    expect(groups[0].records).toEqual([c]);
    expect(groups[2].records).toEqual([b]);
  });
});

describe("values", () => {
  it("formats by type", () => {
    expect(formatValue(status, "opt_done")).toBe("Done");
    expect(formatValue(tags, ["opt_a", "opt_gone"])).toBe("Alpha");
    expect(formatValue(done, null)).toBe("No");
    expect(formatValue({ id: "r", name: "R", type: "relation" }, ["x"], () => "Project X")).toBe("Project X");
  });
  it("sets and clears props without touching others", () => {
    const d = withProp(toDraft(a), "p_pts", 5);
    expect(d.meta.props).toMatchObject({ p_pts: 5, p_status: "opt_done" });
    expect(withProp(d, "p_tags", []).meta.props).not.toHaveProperty("p_tags");
  });
  it("presets new records from a view's filters", () => {
    const v = view({ filters: [{ propertyId: "p_status", op: "is", value: "opt_todo" }, { propertyId: "p_tags", op: "contains", value: "opt_a" }] });
    expect(presetFromView(v, schema)).toEqual({ p_status: "opt_todo", p_tags: ["opt_a"] });
  });
  it("gives status properties default options", () => {
    expect(newProperty("State", "status").options?.map((o) => o.name)).toEqual(["Not started", "In progress", "Done"]);
  });
});
