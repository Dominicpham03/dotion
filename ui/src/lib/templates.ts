// Starter templates. Each builds a set of drafts (pages, databases, records)
// that are saved like anything else, so they sync and can be changed freely.
import type { DatabaseSchema, EntryDraft, JSONContent, PropertyDef, PropValue, ViewDef } from "@/platform/types";
import { newProperty, newViewId, option } from "./db";
import { addDays, todayLocal } from "./dates";
import { uuidv7 } from "./uuid";

export interface Template {
  id: string;
  name: string;
  icon: string;
  description: string;
  build(): { root: string; drafts: EntryDraft[] };
}

// ---- small document builders ------------------------------------------------

const text = (t: string): JSONContent => ({ type: "text", text: t });
const p = (...parts: (string | JSONContent)[]): JSONContent => ({
  type: "paragraph",
  content: parts.map((x) => (typeof x === "string" ? text(x) : x)),
});
const h = (level: 2 | 3, t: string): JSONContent => ({ type: "heading", attrs: { level }, content: [text(t)] });
const tasks = (...items: string[]): JSONContent => ({
  type: "taskList",
  content: items.map((t) => ({ type: "taskItem", attrs: { checked: false }, content: [p(t)] })),
});
const bullets = (...items: string[]): JSONContent => ({
  type: "bulletList",
  content: items.map((t) => ({ type: "listItem", content: [p(t)] })),
});
const code = (language: string, src: string): JSONContent => ({ type: "codeBlock", attrs: { language }, content: [text(src)] });
const link = (id: string, title: string): JSONContent => ({ type: "pageLink", attrs: { id, title } });
const dbView = (databaseId: string, viewId: string, title: string): JSONContent => ({ type: "databaseView", attrs: { databaseId, viewId, title } });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

function page(title: string, icon: string, body: JSONContent, parentId: string | null = null, id = uuidv7()): EntryDraft {
  return { id, entryDate: null, kind: "page", parentId, title, body, meta: { icon } };
}

function database(title: string, icon: string, schema: DatabaseSchema, parentId: string | null, id = uuidv7()): EntryDraft {
  return { id, entryDate: null, kind: "database", parentId, title, body: doc(), meta: { icon, schema } };
}

function record(dbId: string, title: string, props: Record<string, PropValue>, body: JSONContent = doc()): EntryDraft {
  return { id: uuidv7(), entryDate: null, kind: "page", parentId: dbId, title, body, meta: { props } };
}

const view = (name: string, type: ViewDef["type"], extra: Partial<ViewDef> = {}): ViewDef => ({
  id: newViewId(), name, type, filters: [], sorts: [], ...extra,
});

const statusProp = (names: [string, string, string]): PropertyDef => ({
  ...newProperty("Status", "status"),
  options: [option(names[0], "gray"), option(names[1], "blue"), option(names[2], "green")],
});

// ---- templates ------------------------------------------------------------

const engineering: Template = {
  id: "engineering",
  name: "Engineering knowledge base",
  icon: "🛠️",
  description: "Guides, references, decisions and runbooks with type, tags and review status. Code blocks are highlighted.",
  build() {
    const type: PropertyDef = {
      ...newProperty("Type", "select"),
      options: [option("Guide", "blue"), option("Reference", "purple"), option("Decision", "orange"), option("Runbook", "red")],
    };
    const tags: PropertyDef = { ...newProperty("Tags", "multi_select"), options: [option("backend", "green"), option("frontend", "pink"), option("infra", "brown")] };
    const status = statusProp(["Draft", "In review", "Current"]);
    const owner = newProperty("Owner", "text");
    const source = newProperty("Source", "url");
    const home = page("Engineering", "🛠️", doc());
    const kb = database("Knowledge base", "📚", {
      properties: [type, tags, status, owner, source],
      views: [
        view("All docs", "table", { sorts: [{ propertyId: "updated", direction: "desc" }] }),
        view("By type", "board", { groupBy: type.id }),
        view("Needs review", "table", { filters: [{ propertyId: status.id, op: "is_not", value: status.options![2].id }] }),
      ],
    }, home.id);
    const deploy = record(kb.id, "How we deploy", { [type.id]: type.options![3].id, [tags.id]: [tags.options![2].id], [status.id]: status.options![2].id }, doc(
      h(2, "Steps"),
      p("Build the image and start the stack:"),
      code("bash", "make build\ndocker compose --profile tailscale up -d"),
      h(2, "Rollback"),
      p("Restore the previous image tag and run the same command."),
    ));
    const adr = record(kb.id, "ADR-001: SQLite for v1", { [type.id]: type.options![2].id, [tags.id]: [tags.options![0].id], [status.id]: status.options![2].id }, doc(
      h(2, "Context"), p("One user, one server process."),
      h(2, "Decision"), p("Use SQLite with WAL; keep SQL portable so Postgres can follow."),
      h(2, "Consequences"), p("Single writer; backups are a file copy."),
    ));
    home.body = doc(
      p("Team knowledge in one place. Start with ", link(deploy.id, deploy.title), " or ", link(adr.id, adr.title), "."),
      dbView(kb.id, kb.meta.schema!.views[0].id, "Knowledge base · All docs"),
    );
    return { root: home.id, drafts: [home, kb, deploy, adr] };
  },
};

const study: Template = {
  id: "study",
  name: "Study tracker",
  icon: "🎓",
  description: "Courses and assignments with due dates, progress and a calendar of deadlines.",
  build() {
    const status = statusProp(["Not started", "Studying", "Done"]);
    const subject: PropertyDef = { ...newProperty("Subject", "select"), options: [option("Maths", "blue"), option("Computer science", "purple"), option("Languages", "green")] };
    const due = newProperty("Due", "date");
    const progress = newProperty("Progress %", "number");
    const notes = newProperty("Materials", "url");
    const home = page("Study", "🎓", doc());
    const courses = database("Assignments", "📝", {
      properties: [status, subject, due, progress, notes],
      views: [
        view("Board", "board", { groupBy: status.id }),
        view("Deadlines", "calendar", { dateProperty: due.id }),
        view("Upcoming", "table", {
          filters: [{ propertyId: status.id, op: "is_not", value: status.options![2].id }],
          sorts: [{ propertyId: due.id, direction: "asc" }],
        }),
      ],
    }, home.id);
    const today = todayLocal();
    const recs = [
      record(courses.id, "Linear algebra problem set 3", { [status.id]: status.options![1].id, [subject.id]: subject.options![0].id, [due.id]: addDays(today, 3), [progress.id]: 40 }),
      record(courses.id, "Read chapter 5: graphs", { [status.id]: status.options![0].id, [subject.id]: subject.options![1].id, [due.id]: addDays(today, 7), [progress.id]: 0 }),
      record(courses.id, "Spanish vocabulary review", { [status.id]: status.options![2].id, [subject.id]: subject.options![2].id, [due.id]: addDays(today, -2), [progress.id]: 100 }),
    ];
    home.body = doc(
      h(2, "This week"),
      tasks("Plan study sessions", "Review notes from Monday"),
      dbView(courses.id, courses.meta.schema!.views[2].id, "Assignments · Upcoming"),
    );
    return { root: home.id, drafts: [home, courses, ...recs] };
  },
};

const projects: Template = {
  id: "projects",
  name: "Project management",
  icon: "🚀",
  description: "Projects and tasks linked by a relation, with a Kanban board and a calendar of due dates.",
  build() {
    const home = page("Projects", "🚀", doc());
    const projStatus = statusProp(["Planned", "Active", "Shipped"]);
    const deadline = newProperty("Deadline", "date");
    const lead = newProperty("Lead", "text");
    const projectsDb = database("All projects", "🗂️", {
      properties: [projStatus, deadline, lead],
      views: [view("Table", "table"), view("By status", "board", { groupBy: projStatus.id })],
    }, home.id);

    const taskStatus = statusProp(["To do", "Doing", "Done"]);
    const priority: PropertyDef = { ...newProperty("Priority", "select"), options: [option("High", "red"), option("Medium", "yellow"), option("Low", "gray")] };
    const due = newProperty("Due", "date");
    const project: PropertyDef = { ...newProperty("Project", "relation"), relationDatabaseId: projectsDb.id };
    const tasksDb = database("Tasks", "✅", {
      properties: [taskStatus, priority, due, project],
      views: [
        view("Board", "board", { groupBy: taskStatus.id, sorts: [{ propertyId: priority.id, direction: "asc" }] }),
        view("Calendar", "calendar", { dateProperty: due.id }),
        view("Open", "table", { filters: [{ propertyId: taskStatus.id, op: "is_not", value: taskStatus.options![2].id }], sorts: [{ propertyId: due.id, direction: "asc" }] }),
      ],
    }, home.id);

    const today = todayLocal();
    const launch = record(projectsDb.id, "Website relaunch", { [projStatus.id]: projStatus.options![1].id, [deadline.id]: addDays(today, 21), [lead.id]: "You" });
    const t = (title: string, s: number, pr: number, d: number) =>
      record(tasksDb.id, title, { [taskStatus.id]: taskStatus.options![s].id, [priority.id]: priority.options![pr].id, [due.id]: addDays(today, d), [project.id]: [launch.id] });
    const recs = [t("Write the brief", 2, 0, -3), t("Design the home page", 1, 0, 4), t("Set up analytics", 0, 2, 10)];
    home.body = doc(
      p("Each task links to its project; open ", link(launch.id, launch.title), " to see its tasks under “Linked from”."),
      dbView(tasksDb.id, tasksDb.meta.schema!.views[0].id, "Tasks · Board"),
    );
    return { root: home.id, drafts: [home, projectsDb, tasksDb, launch, ...recs] };
  },
};

const dashboard: Template = {
  id: "dashboard",
  name: "Personal dashboard",
  icon: "🧭",
  description: "A home page with today's checklist, open to-dos and a reading list, each a live view you can rearrange.",
  build() {
    const home = page("Dashboard", "🧭", doc());
    const done = newProperty("Done", "checkbox");
    const when = newProperty("When", "date");
    const area: PropertyDef = { ...newProperty("Area", "select"), options: [option("Home", "green"), option("Work", "blue"), option("Health", "pink")] };
    const todos = database("To-dos", "☑️", {
      properties: [done, when, area],
      views: [
        view("Open", "table", { filters: [{ propertyId: done.id, op: "is_not" }], sorts: [{ propertyId: when.id, direction: "asc" }] }),
        view("By area", "board", { groupBy: area.id }),
        view("Calendar", "calendar", { dateProperty: when.id }),
      ],
    }, home.id);
    const readStatus = statusProp(["Want to read", "Reading", "Finished"]);
    const author = newProperty("Author", "text");
    const rating = newProperty("Rating", "number");
    const reading = database("Reading list", "📚", {
      properties: [readStatus, author, rating],
      views: [view("Shelf", "board", { groupBy: readStatus.id }), view("Reading now", "table", { filters: [{ propertyId: readStatus.id, op: "is", value: readStatus.options![1].id }] })],
    }, home.id);
    const today = todayLocal();
    const recs = [
      record(todos.id, "Book dentist appointment", { [when.id]: addDays(today, 1), [area.id]: area.options![2].id }),
      record(todos.id, "Pay electricity bill", { [when.id]: addDays(today, 2), [area.id]: area.options![0].id }),
      record(reading.id, "The Pragmatic Programmer", { [readStatus.id]: readStatus.options![1].id, [author.id]: "Hunt & Thomas" }),
    ];
    home.body = doc(
      h(2, "Today"),
      tasks("Write in the diary", "Move for 30 minutes", "Inbox to zero"),
      h(2, "Open to-dos"),
      dbView(todos.id, todos.meta.schema!.views[0].id, "To-dos · Open"),
      h(2, "Reading"),
      dbView(reading.id, reading.meta.schema!.views[1].id, "Reading list · Reading now"),
      h(3, "Ideas"),
      bullets("Add your own sections with + Insert → Database view"),
    );
    return { root: home.id, drafts: [home, todos, reading, ...recs] };
  },
};

export const TEMPLATES: Template[] = [engineering, study, projects, dashboard];
