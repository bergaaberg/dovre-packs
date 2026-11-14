/**
 * The tasks' own tables in Dovre's database (SQLite locally, D1 hosted), made by core from the
 * pack's `migrations` (prefixed `tasks_`). Nothing is ever deleted: a task is done or dropped.
 *
 * `parent_id`: the task it's a step of, one level, as My list's initiatives (`ListShare`).
 * `source`: where an imported task came from ("todo:12", My list's item), so each comes in once.
 *
 * Who: hosted, the verified email of whoever asks (lowercased); locally "" (the one person this
 * Dovre is). A private task is seen only by whoever made it.
 */
import type { D1, D1Value, ListItem, ListState } from "dovre/pack.ts";
import { clean, isPriority, isStatus, MAX_TITLE, type Priority, type Status } from "./parse.ts";

export type LinkKind = "issue" | "url" | "signal" | "page";
export type TaskLink = { kind: LinkKind; ref: string; label?: string };

export type Task = {
  id: number;
  title: string;
  notes: string;
  status: Status;
  priority: Priority;
  area: string;
  due: string | null;
  scheduled: string | null;
  waitingOn: string;
  createdBy: string;
  assignee: string;
  /** When it was last given to its assignee, and by whom (null and "": to no one, or before 0.3.0). */
  assignedAt: number | null;
  assignedBy: string;
  private: boolean;
  links: TaskLink[];
  /** The task it's a step of (one level). */
  parent: number | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  /** When its status last changed. */
  statusAt: number;
  doneAt: number | null;
};

export type Activity = { id: number; taskId: number; at: number; who: string; what: string; detail: string; text: string | null };

export const MAX_NOTES = 20_000;
export const MAX_COMMENT = 4000;
export const MAX_LINKS = 20;
/** What memory keeps: every open task, and those done or dropped in the last `DONE_KEPT_MS`. */
export const DONE_KEPT_MS = 14 * 86400_000;
export const MAX_KEPT = 5000;

/** Append-only (core runs each once, in order): never edit one that has shipped, add another. */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'inbox', priority TEXT NOT NULL DEFAULT 'normal', area TEXT NOT NULL DEFAULT '', due TEXT, scheduled TEXT, waiting_on TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', assignee TEXT NOT NULL DEFAULT '', private INTEGER NOT NULL DEFAULT 0, links TEXT NOT NULL DEFAULT '[]', position REAL NOT NULL DEFAULT 0, parent_id INTEGER, source TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status_at INTEGER NOT NULL, done_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS tasks_items_status ON tasks_items (status, done_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tasks_items_source ON tasks_items (source) WHERE source IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS tasks_items_parent ON tasks_items (parent_id)`,
  `CREATE TABLE IF NOT EXISTS tasks_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL DEFAULT '', what TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', text TEXT)`,
  `CREATE INDEX IF NOT EXISTS tasks_activity_task ON tasks_activity (task_id, at)`,
  `ALTER TABLE tasks_items ADD COLUMN assigned_at INTEGER`,
  `ALTER TABLE tasks_items ADD COLUMN assigned_by TEXT NOT NULL DEFAULT ''`,
];

// ── Ids: T-42 ──

export const label = (id: number) => `T-${id}`;
/** "T-42", "t42", "42", "#42" → 42; anything else undefined. */
export function idOf(s: unknown): number | undefined {
  const m = /^\s*(?:t-?|#)?(\d{1,9})\s*$/i.exec(String(s ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// ── Who sees what ──

/** Who a request is for: an email, lowercased; "" locally. */
export const viewerOf = (who: string | undefined | null): string => (who ?? "").trim().toLowerCase();

/** A private task only for whoever made it; the rest for everyone. */
export const visibleTo = (t: Pick<Task, "private" | "createdBy">, viewer: string): boolean => !t.private || t.createdBy === viewer;

/** The person, for lists and for Bino: an email's name part ("maria@acme.no" → "maria"). */
export const shortName = (who: string): string => (who.includes("@") ? who.split("@")[0]! : who);

/** Assigned to the viewer: by email, by its name part, or nobody's and theirs. */
export function isMine(t: Pick<Task, "assignee" | "createdBy">, viewer: string): boolean {
  const a = t.assignee.trim().toLowerCase();
  if (!a) return t.createdBy === viewer;
  return a === viewer || (!!viewer && a === shortName(viewer)) || a === "me";
}

/** Given to its assignee by someone else: who, else "". Taking a task yourself isn't that. */
export function givenBy(t: Pick<Task, "assignee" | "assignedAt" | "assignedBy">): string {
  if (!t.assignee || !t.assignedAt || !t.assignedBy) return "";
  return isMine({ assignee: t.assignee, createdBy: "" }, t.assignedBy) ? "" : t.assignedBy;
}

// ── Links ──

const ISSUE = /^[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,9}$/;
const SIGNAL = /^signal:[\w.:-]{1,120}$/i;

/** What someone typed as a link, checked: a repo's issue or PR, an http(s) URL, a signal, a page here. */
export function linkOf(ref: unknown, labelText?: unknown): TaskLink | undefined {
  const r = clean(ref, 500);
  const l = clean(labelText, 120) || undefined;
  if (!r) return undefined;
  if (ISSUE.test(r)) return { kind: "issue", ref: r, label: l };
  if (SIGNAL.test(r)) return { kind: "signal", ref: r.slice(7), label: l };
  if (/^\/(?![/\\])[\w\-./?=&%~+:#]*$/.test(r) && !r.includes("..")) return { kind: "page", ref: r, label: l };
  try {
    const u = new URL(r);
    if (u.protocol === "https:" || u.protocol === "http:") return { kind: "url", ref: u.href, label: l };
  } catch {}
  return undefined;
}

function linksFrom(json: string): TaskLink[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => {
      const kind = x?.kind;
      if (kind !== "issue" && kind !== "url" && kind !== "signal" && kind !== "page") return [];
      const ref = typeof x.ref === "string" ? x.ref.slice(0, 500) : "";
      return ref ? [{ kind, ref, ...(typeof x.label === "string" && x.label ? { label: x.label.slice(0, 120) } : {}) }] : [];
    }).slice(0, MAX_LINKS);
  } catch {
    return [];
  }
}

// ── Rows ──

type Row = {
  id: number; title: string; notes: string; status: string; priority: string; area: string; due: string | null; scheduled: string | null;
  waiting_on: string; created_by: string; assignee: string; assigned_at?: number | null; assigned_by?: string | null; private: number; links: string; parent_id: number | null; position: number;
  created_at: number; updated_at: number; status_at: number; done_at: number | null;
};

const taskOf = (r: Row): Task => ({
  id: Number(r.id),
  title: r.title,
  notes: r.notes ?? "",
  status: isStatus(r.status) ? r.status : "inbox",
  priority: isPriority(r.priority) ? r.priority : "normal",
  area: r.area ?? "",
  due: r.due || null,
  scheduled: r.scheduled || null,
  waitingOn: r.waiting_on ?? "",
  createdBy: r.created_by ?? "",
  assignee: r.assignee ?? "",
  assignedAt: r.assigned_at == null ? null : Number(r.assigned_at),
  assignedBy: r.assigned_by ?? "",
  private: !!r.private,
  links: linksFrom(r.links ?? "[]"),
  parent: r.parent_id == null ? null : Number(r.parent_id),
  position: Number(r.position) || 0,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  statusAt: Number(r.status_at),
  doneAt: r.done_at == null ? null : Number(r.done_at),
});

/** Every open task and the ones closed lately, for memory. */
export async function loadKept(db: D1, now: number): Promise<Task[]> {
  const { results } = await db
    .prepare("SELECT * FROM tasks_items WHERE status NOT IN ('done', 'dropped') OR done_at >= ? OR status_at >= ? ORDER BY id DESC LIMIT ?")
    .bind(now - DONE_KEPT_MS, now - DONE_KEPT_MS, MAX_KEPT)
    .all<Row>();
  return results.map(taskOf);
}

export async function getTask(db: D1, id: number): Promise<Task | undefined> {
  const r = await db.prepare("SELECT * FROM tasks_items WHERE id = ?").bind(id).first<Row>();
  return r ? taskOf(r) : undefined;
}

/** Tasks whose title or notes have every word, newest first, `limit` at most (open and closed). */
export async function searchTasks(db: D1, q: string, limit = 20): Promise<Task[]> {
  const words = clean(q, 200).toLowerCase().split(" ").filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = words.map(() => "(lower(title) LIKE ? ESCAPE '\\' OR lower(notes) LIKE ? ESCAPE '\\')").join(" AND ");
  const { results } = await db
    .prepare(`SELECT * FROM tasks_items WHERE ${where} ORDER BY (status IN ('done', 'dropped')), updated_at DESC LIMIT ?`)
    .bind(...words.flatMap((w) => [like(w), like(w)]), limit)
    .all<Row>();
  return results.map(taskOf);
}

export async function activityOf(db: D1, id: number, limit = 100): Promise<Activity[]> {
  const { results } = await db.prepare("SELECT * FROM tasks_activity WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?").bind(id, limit).all<{ id: number; task_id: number; at: number; who: string; what: string; detail: string; text: string | null }>();
  return results.map((r) => ({ id: Number(r.id), taskId: Number(r.task_id), at: Number(r.at), who: r.who ?? "", what: r.what, detail: r.detail ?? "", text: r.text ?? null }));
}

// ── Writes ──

export type NewTask = {
  title: string;
  notes?: string;
  status?: Status;
  priority?: Priority;
  area?: string;
  due?: string | null;
  scheduled?: string | null;
  waitingOn?: string;
  assignee?: string;
  private?: boolean;
  links?: TaskLink[];
  /** The task it's a step of: one level, so a step's own steps go under its parent. */
  parent?: number | null;
};

const areaOf = (s: unknown) => clean(s, 40).toLowerCase().replace(/^#/, "").replace(/[^\p{L}\p{N}_-]/gu, "");
const personOf = (s: unknown) => clean(s, 120).replace(/^@/, "");

export async function createTask(db: D1, t: NewTask, who: string, now: number): Promise<Task> {
  const title = clean(t.title, MAX_TITLE);
  if (!title) throw new Error("A task needs a title.");
  const status = t.status ?? "inbox";
  const done = status === "done" || status === "dropped" ? now : null;
  const top = await db.prepare("SELECT MAX(position) AS p FROM tasks_items").first<{ p: number | null }>();
  const parent = t.parent ? await db.prepare("SELECT id, parent_id FROM tasks_items WHERE id = ?").bind(t.parent).first<{ id: number; parent_id: number | null }>() : null;
  const r = await db
    .prepare(
      "INSERT INTO tasks_items (title, notes, status, priority, area, due, scheduled, waiting_on, created_by, assignee, private, links, position, parent_id, created_at, updated_at, status_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(
      title,
      String(t.notes ?? "").slice(0, MAX_NOTES),
      status,
      t.priority ?? "normal",
      areaOf(t.area),
      t.due ?? null,
      t.scheduled ?? null,
      clean(t.waitingOn, 120),
      who,
      personOf(t.assignee),
      t.private ? 1 : 0,
      JSON.stringify((t.links ?? []).slice(0, MAX_LINKS)),
      (Number(top?.p) || 0) + 1,
      parent ? Number(parent.parent_id ?? parent.id) : null,
      now,
      now,
      now,
      done,
    )
    .first<{ id: number }>();
  const id = Number(r!.id);
  if (personOf(t.assignee)) await db.prepare("UPDATE tasks_items SET assigned_at = ?, assigned_by = ? WHERE id = ?").bind(now, who, id).run();
  await addActivity(db, id, who, "created", title, null, now);
  return (await getTask(db, id))!;
}

/** What may change on a task, each optional; null clears a date. */
export type Patch = Partial<{
  title: string;
  notes: string;
  status: Status;
  priority: Priority;
  area: string;
  due: string | null;
  scheduled: string | null;
  waitingOn: string;
  assignee: string;
  private: boolean;
  links: TaskLink[];
}>;

const COLUMN: Record<keyof Patch, string> = {
  title: "title", notes: "notes", status: "status", priority: "priority", area: "area", due: "due", scheduled: "scheduled",
  waitingOn: "waiting_on", assignee: "assignee", private: "private", links: "links",
};

/** The patch, cleaned, keeping only what differs from the task as it is. */
export function changesOf(t: Task, p: Patch): Patch {
  const out: Patch = {};
  const put = <K extends keyof Patch>(k: K, v: Patch[K]) => {
    if (v === undefined) return;
    const was = t[k as keyof Task];
    if (JSON.stringify(was) !== JSON.stringify(v)) out[k] = v;
  };
  if (p.title !== undefined) {
    const title = clean(p.title, MAX_TITLE);
    if (title) put("title", title);
  }
  if (p.notes !== undefined) put("notes", String(p.notes).replace(/\r\n?/g, "\n").slice(0, MAX_NOTES));
  if (p.status !== undefined && isStatus(p.status)) put("status", p.status);
  if (p.priority !== undefined && isPriority(p.priority)) put("priority", p.priority);
  if (p.area !== undefined) put("area", areaOf(p.area));
  if (p.due !== undefined) put("due", p.due);
  if (p.scheduled !== undefined) put("scheduled", p.scheduled);
  if (p.waitingOn !== undefined) put("waitingOn", clean(p.waitingOn, 120));
  if (p.assignee !== undefined) put("assignee", personOf(p.assignee));
  if (p.private !== undefined) put("private", !!p.private);
  if (p.links !== undefined) put("links", p.links.slice(0, MAX_LINKS));
  return out;
}

/** A line per change for the activity: "status next → doing", "due 2026-11-07". Never the notes' text. */
export function describe(t: Task, c: Patch): string[] {
  const out: string[] = [];
  for (const k of Object.keys(c) as (keyof Patch)[]) {
    if (k === "notes") out.push("edited the notes");
    else if (k === "links") out.push("changed the links");
    else if (k === "private") out.push(c.private ? "made it private" : "shared it");
    else if (k === "title") out.push(`renamed it`);
    else {
      const was = t[k as keyof Task];
      const now = c[k];
      const name = k === "waitingOn" ? "waiting on" : k === "scheduled" ? "do on" : k;
      out.push(`${name} ${was || "–"} → ${now || "–"}`);
    }
  }
  return out;
}

/**
 * Changes a task (only what differs), with its activity. Returns the task after, and what changed
 * (empty: nothing did). The caller has checked the task exists and the viewer may see it.
 */
export async function updateTask(db: D1, t: Task, p: Patch, who: string, now: number): Promise<{ task: Task; changed: string[] }> {
  const c = changesOf(t, p);
  const keys = Object.keys(c) as (keyof Patch)[];
  if (!keys.length) return { task: t, changed: [] };
  const sets: string[] = [];
  const binds: D1Value[] = [];
  for (const k of keys) {
    sets.push(`${COLUMN[k]} = ?`);
    const v = c[k];
    binds.push(k === "links" ? JSON.stringify(v) : k === "private" ? (v ? 1 : 0) : ((v ?? null) as D1Value));
  }
  if (c.status) {
    sets.push("status_at = ?", "done_at = ?");
    binds.push(now, c.status === "done" || c.status === "dropped" ? now : null);
  }
  if (c.assignee !== undefined) {
    sets.push("assigned_at = ?", "assigned_by = ?");
    binds.push(c.assignee ? now : null, c.assignee ? who : "");
  }
  sets.push("updated_at = ?");
  binds.push(now);
  await db.prepare(`UPDATE tasks_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, t.id).run();
  const changed = describe(t, c);
  const what = keys.length === 1 && keys[0] === "status" ? "status" : "edited";
  await addActivity(db, t.id, who, what, changed.join("; ").slice(0, 500), null, now);
  return { task: (await getTask(db, t.id))!, changed };
}

export async function addActivity(db: D1, taskId: number, who: string, what: string, detail: string, text: string | null, now: number): Promise<void> {
  await db.prepare("INSERT INTO tasks_activity (task_id, at, who, what, detail, text) VALUES (?, ?, ?, ?, ?, ?)").bind(taskId, now, who, what, detail.slice(0, 500), text).run();
}

// ── My list (core's `todo` pack), which Tasks takes the place of ──

/** My list's items that aren't tasks yet, parents first. */
export async function notImported(db: D1, items: ListItem[]): Promise<ListItem[]> {
  const { results } = await db.prepare("SELECT source FROM tasks_items WHERE source LIKE 'todo:%'").all<{ source: string }>();
  const had = new Set(results.map((r) => r.source));
  return items.filter((i) => Number.isSafeInteger(i?.id) && !had.has(`todo:${i.id}`)).sort((a, b) => Number(a.parent != null) - Number(b.parent != null));
}

/**
 * Copies My list's items (read through its share) that aren't tasks yet; My list keeps them. Its
 * states are the same words, its date a due date, and a step keeps its initiative as its parent.
 * Returns the tasks made.
 */
export async function importTodos(db: D1, items: ListItem[], who: string, now: number): Promise<Task[]> {
  const made: Task[] = [];
  for (const i of await notImported(db, items)) {
    const title = clean(i.title, MAX_TITLE);
    if (!title) continue;
    const status: Status = isStatus(i.state) ? i.state : "next";
    const parent = i.parent == null ? null : await db.prepare("SELECT id FROM tasks_items WHERE source = ?").bind(`todo:${i.parent}`).first<{ id: number }>();
    const res = await db
      .prepare(
        "INSERT OR IGNORE INTO tasks_items (title, notes, status, priority, area, due, scheduled, waiting_on, created_by, assignee, private, links, position, parent_id, source, created_at, updated_at, status_at, done_at) VALUES (?, ?, ?, 'normal', '', ?, NULL, '', ?, '', 0, '[]', ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(title, String(i.notes ?? "").slice(0, MAX_NOTES), status, isoDateOf(i.due), who, made.length + 1, parent ? Number(parent.id) : null, `todo:${i.id}`, now, now, now, status === "done" ? Number(i.doneAt) || now : null)
      .first<{ id: number }>();
    if (!res) continue;
    const id = Number(res.id);
    await addActivity(db, id, who, "created", `from My list (item ${i.id})`, null, now);
    made.push((await getTask(db, id))!);
  }
  return made;
}

/** A task as My list's readers see it (Bino, search, New work): the inbox reads as next, dropped isn't there. */
export function listItemOf(t: Task): ListItem | undefined {
  if (t.status === "dropped") return undefined;
  const state: ListState = t.status === "inbox" ? "next" : t.status;
  return { id: t.id, parent: t.parent, title: t.title, notes: t.notes, state, due: t.due, doneAt: t.doneAt };
}

const isoDateOf = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function addComment(db: D1, t: Task, who: string, text: string, now: number): Promise<void> {
  const body = String(text).replace(/\r\n?/g, "\n").trim().slice(0, MAX_COMMENT);
  if (!body) throw new Error("A comment needs some text.");
  await addActivity(db, t.id, who, "comment", "", body, now);
  await db.prepare("UPDATE tasks_items SET updated_at = ? WHERE id = ?").bind(now, t.id).run();
}
