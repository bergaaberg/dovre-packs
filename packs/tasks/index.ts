/**
 * Tasks (`tasks`): a task manager of Dovre's own, for one person (a local Dovre) or a team sharing a
 * hosted cockpit. Kept in its own `tasks_*` tables in Dovre's database; no service, no settings.
 *
 * Lists (/tasks: Now, Next, Waiting, Inbox, Later), a task's page (/tasks/T-42: fields, Markdown
 * notes, links, activity and comments), a weekly review, a quick-add line read as I type, a Today
 * card, a dock, needs for what's overdue, and Bino: lines about the shared tasks, lookups (list,
 * search, one task) and acts (create, status, schedule, edit, comment) behind the confirm card.
 *
 * It takes My list's place (`replaces: ["todo"]`): while it's on, My list is held off, and what
 * reads My list (Bino, search, New work's "Also put it on My list", Slack's saved messages) reads
 * and adds to Tasks through its `list` share. My list's items come over in one click, once; other
 * packs' proposals for My list (`todo.proposals`) show on /tasks.
 *
 * Who: hosted, each request's verified email (`ctx.viewer()`); locally "" (the one person). A
 * private task is its maker's alone: never in Bino's lines, lookups, needs, the feed, the actions
 * log's detail, or anyone else's lists and search. Lookups don't know who's asking (hosted, they
 * come from Bino's Durable Object), so they never show a private task.
 */
import type { Context } from "hono";
import { type ActKind, type AppEnv, commentAct, Empty, type ListShare, type LookupKind, type Pack, type PackContext, type PackNeed, type RefRule, statusAct, strictOrigin, within, writeAct } from "dovre/pack.ts";
import { areasOf, bucketOf, filtered, isOpen, late, lineOf, listsOf, nextWeek, peopleOf, reviewOf, whenOf, type Filter } from "./lists.ts";
import { addDays, clean, dateFrom, dayOf, isoDate, isPriority, isStatus, parseQuick, STATUSES, type Parsed, type Status } from "./parse.ts";
import { SCRIPT } from "./script.ts";
import {
  activityOf, addComment, createTask, getTask, idOf, label, linkOf, loadKept, MAX_COMMENT, MAX_LINKS, MAX_NOTES, type NewTask, type Patch,
  importTodos, listItemOf, MIGRATIONS, notImported, searchTasks, shortName, type Task, updateTask, viewerOf, visibleTo,
} from "./store.ts";
import { backOf, detailPage, dockView, errorOf, listsPage, reviewPage, styles, taskHref, todayCard, type View } from "./view.ts";

const ID = "tasks";
/** How long a page waits for the database before drawing what memory has. */
const PAGE_MS = 1000;

/** The quick-add's reading, as the preview shows it. */
export function previewOf(p: Parsed, today: string): { title: string; bits: string[] } {
  const bits: string[] = [];
  if (p.status !== "inbox") bits.push(p.status);
  if (p.priority !== "normal") bits.push(`!${p.priority}`);
  if (p.area) bits.push(`#${p.area}`);
  if (p.assignee) bits.push(`@${p.assignee}`);
  if (p.scheduled) bits.push(`do ${whenOf(p.scheduled, today)}`);
  if (p.due) bits.push(`due ${whenOf(p.due, today)}`);
  if (p.waitingOn) bits.push(`waiting on ${p.waitingOn}`);
  return { title: p.title, bits };
}

/** "me" is whoever's asking: hosted their email, locally nobody in particular (the one person). */
const assigneeOf = (s: string | undefined, viewer: string) => (s === undefined ? undefined : s.toLowerCase() === "me" || s.toLowerCase() === "@me" ? viewer : s);

/** A quick-add line as a new task. */
export function newTaskOf(p: Parsed, viewer: string, o: { private?: boolean } = {}): NewTask {
  return {
    title: p.title,
    status: p.status,
    priority: p.priority,
    area: p.area,
    due: p.due ?? null,
    scheduled: p.scheduled ?? null,
    waitingOn: p.waitingOn,
    assignee: assigneeOf(p.assignee, viewer),
    private: !!o.private,
  };
}

/** What a one-click button does to a task. */
export function opPatch(op: string, t: Task, today: string): Patch | undefined {
  const later = t.status === "doing" || t.status === "inbox" ? { status: "next" as Status } : {};
  switch (op) {
    case "done": return { status: "done" };
    case "start": return { status: "doing" };
    case "next": return { status: "next" };
    case "drop": return { status: "dropped" };
    case "reopen": return { status: "next" };
    case "snooze": return { scheduled: addDays(today, 1), ...later };
    case "week": return { scheduled: nextWeek(today), ...later };
    default: return undefined;
  }
}

async function formOf(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v.slice(0, MAX_NOTES + 100);
  return out;
}

const withError = (back: string, code: string) => `${back}${back.includes("?") ? "&" : "?"}e=${code}`;

export function createTasksPack(opts: { now?: () => number } = {}): Pack & { kept(): Task[] } {
  const now = opts.now ?? Date.now;
  let kept: Task[] = [];
  const today = (ctx: PackContext) => dayOf(now(), ctx.env.TZ_NAME);
  const reload = async (ctx: PackContext) => (kept = await loadKept(ctx.db, now()));
  /** Fresh from the database within the page's budget, else what memory has. */
  const fresh = async (ctx: PackContext) => {
    const r = await within(PAGE_MS, () => reload(ctx).catch(() => kept));
    return r.ok ? r.value : kept;
  };
  /** Whom this request is for: hosted their email, locally "". */
  const viewer = (ctx: PackContext) => viewerOf(ctx.viewer());
  /** My list, while Tasks takes its place: read only to bring its items over. */
  const myList = (ctx: PackContext): ListShare | undefined => ctx.required("todo", "list");
  const shared = () => kept.filter((t) => !t.private);
  const nowOf = (ts: Task[], day: string) => listsOf(ts, day, now()).now;

  /** After a write: memory again, open pages told. */
  const wrote = async (ctx: PackContext) => {
    await reload(ctx).catch(() => {});
    ctx.publish([ID]);
  };
  /** The action log's line: the title only when everyone may see it. */
  const log = (ctx: PackContext, kind: string, t: Task | undefined, ok: boolean, error?: string) =>
    ctx.logged({ kind, target: t ? label(t.id) : "task", ...(t && !t.private ? { detail: t.title.slice(0, 200) } : {}), ok, ...(error ? { error } : {}) });

  /** The task, read again, if this viewer may see it. */
  const findFor = async (ctx: PackContext, raw: unknown, viewer: string) => {
    const id = idOf(raw);
    const t = id ? await getTask(ctx.db, id) : undefined;
    return t && visibleTo(t, viewer) ? t : undefined;
  };

  const viewOf = (ctx: PackContext, viewer: string): View => ({ today: today(ctx), viewer, team: ctx.hosted });

  // ── Bino ──

  const lookups = (ctx: PackContext): LookupKind[] => [
    {
      kind: "list",
      when: "The shared tasks in Dovre's task list, filtered: by status (open, now, inbox, next, doing, waiting, later, done, dropped), area, person, and due (overdue, today, week, or a date). One line each: id, status, area, dates, title.",
      fields: [
        { name: "status", about: "open (default), now, inbox, next, doing, waiting, later, done or dropped", max: 20 },
        { name: "area", about: "an area word, e.g. skribb", max: 40 },
        { name: "person", about: "who it's assigned to or made by: a name or an email", max: 120 },
        { name: "due", about: "overdue, today, week, or a date (due on or before it)", max: 30 },
      ],
      async run(a) {
        await reload(ctx).catch(() => {});
        const day = today(ctx);
        const status = clean(a.status, 20).toLowerCase() || "open";
        const lists = listsOf(shared(), day, now());
        let ts = shared();
        if (status === "open") ts = ts.filter(isOpen);
        else if (status === "now" || status === "later") ts = lists[status];
        else if (isStatus(status)) ts = ts.filter((t) => t.status === status);
        else return `There's no status "${status}": use open, now, inbox, next, doing, waiting, later, done or dropped.`;
        const area = clean(a.area, 40).toLowerCase().replace(/^#/, "");
        const person = clean(a.person, 120).toLowerCase().replace(/^@/, "");
        ts = filtered(ts, "", { area: area || undefined, who: person || undefined });
        const due = clean(a.due, 30).toLowerCase();
        if (due) {
          const until = due === "overdue" ? addDays(day, -1) : due === "today" ? day : due === "week" ? addDays(day, 7) : dateFrom(due, day);
          if (!until) return `"${due}" isn't a due window: use overdue, today, week or a date.`;
          ts = ts.filter((t) => t.due && t.due <= until);
        }
        if (!ts.length) return "No shared tasks match.";
        const lines = ts.slice(0, 60).map((t) => lineOf(t, day));
        return `${ts.length} shared task${ts.length === 1 ? "" : "s"} (today is ${day}):\n${lines.join("\n")}${ts.length > 60 ? `\n… and ${ts.length - 60} more` : ""}`;
      },
    },
    {
      kind: "search",
      when: "Shared tasks whose title or notes have all these words, open ones first (20 at most).",
      fields: [{ name: "q", about: "words to look for", required: true, max: 100 }],
      async run(a) {
        const found = (await searchTasks(ctx.db, a.q ?? "", 40)).filter((t) => !t.private).slice(0, 20);
        const day = today(ctx);
        return found.length ? found.map((t) => lineOf(t, day)).join("\n") : "No shared task has those words.";
      },
    },
    {
      kind: "task",
      when: "One shared task in full by its id (T-42): status, dates, who, notes, links and recent activity with comments.",
      fields: [{ name: "id", about: "the task's id, e.g. T-42", required: true, max: 20 }],
      async run(a) {
        const id = idOf(a.id);
        const t = id ? await getTask(ctx.db, id) : undefined;
        if (!t || t.private) return `No shared task ${clean(a.id, 20)}.`;
        const day = today(ctx);
        const acts = await activityOf(ctx.db, t.id, 10);
        const out = [lineOf(t, day), `Made by ${shortName(t.createdBy) || "the owner"}, ${new Date(t.createdAt).toISOString().slice(0, 10)}.`];
        if (t.notes.trim()) out.push(`Notes:\n${t.notes.trim().slice(0, 2500)}`);
        if (t.links.length) out.push(`Links:\n${t.links.map((l) => `- ${l.kind} ${l.ref}${l.label ? ` (${l.label})` : ""}`).join("\n")}`);
        if (acts.length)
          out.push(`Recent activity:\n${acts.map((x) => `- ${new Date(x.at).toISOString().slice(0, 10)} ${shortName(x.who) || "owner"} ${x.what}${x.detail ? `: ${x.detail}` : ""}${x.text ? `: ${x.text.slice(0, 300)}` : ""}`).join("\n")}`);
        return out.join("\n\n");
      },
    },
  ];

  const acts = (ctx: PackContext): ActKind[] => {
    // Core offers acts locally only, for the one person there; still, a private task stays its maker's.
    const me = () => viewer(ctx);
    const ref = { name: "task", about: "the task's id, e.g. T-42", pattern: /T-\d{1,9}/, max: 20, normalize: (s: string) => (idOf(s) ? label(idOf(s)!) : s.trim()) };
    const found = async (key: string) => {
      const t = await findFor(ctx, key, me());
      return t ? { task: t, label: label(t.id), href: taskHref(t.id), state: t.status, open: isOpen(t), states: [...STATUSES] } : null;
    };
    const dateField = (v: string | undefined, day: string): string | null | undefined | false => {
      const s = clean(v, 30).toLowerCase();
      if (!s) return undefined;
      if (s === "none" || s === "clear" || s === "-") return null;
      return isoDate(s) ?? dateFrom(s, day) ?? false;
    };
    const blank = (v: string | undefined, max = 200) => {
      const s = clean(v, max);
      return !s ? undefined : s.toLowerCase() === "none" ? "" : s;
    };
    return [
      writeAct<NewTask>({
        pack: ID,
        kind: "create",
        title: "A new task",
        when: "I want a task added to my task list. The title may use quick-add words: #area, !high or !low, @person, a date to do it on (today, fri, in 3d, 2026-12-01), due <date>.",
        fields: [
          { name: "title", about: "what to do; quick-add words allowed", required: true, max: 300 },
          { name: "area", about: "an area word, e.g. skribb", max: 40 },
          { name: "priority", about: "high, normal or low", max: 10 },
          { name: "scheduled", about: "the day to do it: a date or today, tomorrow, fri, in 3d", max: 30 },
          { name: "due", about: "the day it must be done by", max: 30 },
          { name: "assignee", about: "who does it: a name, an email or me", max: 120 },
          { name: "waiting_on", about: "who or what it waits on (makes it waiting)", max: 120 },
          { name: "notes", about: "more about it, Markdown", max: 4000, text: true },
        ],
        button: "Add",
        hint: "Adds it to Tasks.",
        question: "Add this task?",
        read(form) {
          const day = today(ctx);
          const p = parseQuick(form.title ?? "", day);
          if (!p.title) return "Give the task a title.";
          const area = clean(form.area, 40);
          if (area) p.area = area.replace(/^#/, "").toLowerCase();
          const prio = clean(form.priority, 10).toLowerCase();
          if (prio) {
            if (!isPriority(prio)) return "Priority is high, normal or low.";
            p.priority = prio;
          }
          for (const k of ["scheduled", "due"] as const) {
            const d = dateField(form[k], day);
            if (d === false) return `"${clean(form[k], 30)}" isn't a date.`;
            if (d !== undefined) p[k] = d ?? undefined;
          }
          const who = clean(form.assignee, 120);
          if (who) p.assignee = who.replace(/^@/, "");
          const waiting = clean(form.waiting_on, 120);
          if (waiting) (p.waitingOn = waiting), (p.status = "waiting");
          const t = newTaskOf(p, me());
          t.notes = (form.notes ?? "").trim().slice(0, 4000);
          return { target: "new task", value: t };
        },
        async write(t) {
          const made = await createTask(ctx.db, t, me(), now());
          await wrote(ctx);
          return { done: `Added ${label(made.id)}`, href: taskHref(made.id), detail: made.title };
        },
      }),
      statusAct({
        pack: ID,
        app: "Tasks",
        thing: "task",
        ref,
        when: "I want a task (T-42) moved to another status: inbox, next, doing, waiting, done (to complete it) or dropped.",
        find: found,
        async setStatus(f, status) {
          if (!isStatus(status)) return { refuse: `There's no status "${status}".` };
          await updateTask(ctx.db, f.task, { status }, me(), now());
          await wrote(ctx);
          return true;
        },
      }),
      writeAct<{ id: number; scheduled?: string | null; due?: string | null }, Task>({
        pack: ID,
        kind: "schedule",
        title: "A task's dates",
        when: "I want a task (T-42) rescheduled or snoozed: the day to do it on, the day it's due, or either cleared (none).",
        fields: [
          { name: "task", about: "the task's id, e.g. T-42", required: true, max: 20 },
          { name: "scheduled", about: "the day to do it: a date, today, tomorrow, fri, next week, in 3d, or none", max: 30 },
          { name: "due", about: "the day it's due: a date or a phrase as above, or none", max: 30 },
        ],
        button: "Reschedule",
        question: "Change this task's dates?",
        read(form) {
          const id = idOf(form.task);
          if (!id) return "Give the task's id, e.g. T-42.";
          const day = today(ctx);
          const scheduled = dateField(form.scheduled, day);
          const due = dateField(form.due, day);
          if (scheduled === false || due === false) return "A date is a day (2026-12-01) or today, tomorrow, fri, next week, in 3d, or none.";
          if (scheduled === undefined && due === undefined) return "Give a day to do it on or a due day.";
          return { target: label(id), value: { id, scheduled, due } };
        },
        async check(v) {
          const t = await findFor(ctx, v.id, me());
          if (!t) return { refuse: `There's no task ${label(v.id)}.`, log: "no such task" };
          if (!isOpen(t)) return { refuse: `${label(t.id)} is ${t.status}; let it be.`, log: t.status };
          return t;
        },
        async write(v, t) {
          const r = await updateTask(ctx.db, t, { ...(v.scheduled !== undefined ? { scheduled: v.scheduled } : {}), ...(v.due !== undefined ? { due: v.due } : {}) }, me(), now());
          if (!r.changed.length) return { refuse: `${label(t.id)} already has those dates.`, log: "unchanged" };
          await wrote(ctx);
          const day = today(ctx);
          const said = [r.task.scheduled ? `do ${whenOf(r.task.scheduled, day)}` : "", r.task.due ? `due ${whenOf(r.task.due, day)}` : ""].filter(Boolean).join(", ");
          return { done: `${label(t.id)}: ${said || "no dates"}`, href: taskHref(t.id) };
        },
      }),
      writeAct<{ id: number; patch: Patch }, Task>({
        pack: ID,
        kind: "edit",
        title: "A task changed",
        when: "I want a task (T-42) changed: its title, priority, area, notes, who it waits on, or assigned to someone (assignee). Leave a field empty to keep it; none clears it.",
        fields: [
          { name: "task", about: "the task's id, e.g. T-42", required: true, max: 20 },
          { name: "title", about: "a new title", max: 200 },
          { name: "priority", about: "high, normal or low", max: 10 },
          { name: "area", about: "an area word, or none", max: 40 },
          { name: "assignee", about: "who does it: a name, an email, me, or none", max: 120 },
          { name: "waiting_on", about: "who or what it waits on, or none", max: 120 },
          { name: "notes", about: "the notes in full (they replace what's there), Markdown", max: 4000, text: true },
        ],
        button: "Save",
        question: "Change this task?",
        read(form) {
          const id = idOf(form.task);
          if (!id) return "Give the task's id, e.g. T-42.";
          const patch: Patch = {};
          const title = clean(form.title, 200);
          if (title) patch.title = title;
          const prio = clean(form.priority, 10).toLowerCase();
          if (prio) {
            if (!isPriority(prio)) return "Priority is high, normal or low.";
            patch.priority = prio;
          }
          const area = blank(form.area, 40);
          if (area !== undefined) patch.area = area;
          const who = blank(form.assignee, 120);
          if (who !== undefined) patch.assignee = assigneeOf(who.replace(/^@/, ""), me());
          const waiting = blank(form.waiting_on, 120);
          if (waiting !== undefined) patch.waitingOn = waiting;
          const notes = (form.notes ?? "").trim();
          if (notes) patch.notes = notes.toLowerCase() === "none" ? "" : notes.slice(0, 4000);
          if (!Object.keys(patch).length) return "Say what to change.";
          return { target: label(id), value: { id, patch } };
        },
        async check(v) {
          const t = await findFor(ctx, v.id, me());
          return t ?? { refuse: `There's no task ${label(v.id)}.`, log: "no such task" };
        },
        async write(v, t) {
          const r = await updateTask(ctx.db, t, v.patch, me(), now());
          if (!r.changed.length) return { refuse: `${label(t.id)} is already like that.`, log: "unchanged" };
          await wrote(ctx);
          return { done: `Changed ${label(t.id)}: ${r.changed.join("; ").slice(0, 150)}`, href: taskHref(t.id) };
        },
      }),
      commentAct({
        pack: ID,
        app: "Tasks",
        thing: "task",
        ref,
        when: "I want a comment added to a task (T-42).",
        find: found,
        async comment(f, text) {
          await addComment(ctx.db, f.task, me(), text, now());
          await wrote(ctx);
          return true;
        },
      }),
    ];
  };

  return {
    kept: () => kept,
    manifest: {
      api: "2.3",
      version: "0.2.0",
      id: ID,
      name: "Tasks",
      description: "A task list of Dovre's own, for one person or a team, in My list's place: quick-add, Now/Next/Waiting/Inbox, a weekly review, comments and links, and Bino reading and proposing changes.",
      domain: "work",
      execution: "any",
      // In My list's place: what reads My list reads Tasks, and Tasks still reads it to bring its items over.
      replaces: ["todo"],
      uses: ["todo"],
      everyMs: 60_000,
      rings: [{ kind: "tasks-overdue", label: "A task is overdue", hint: "Once per task, the first time it's past its due day", off: true }],
    },
    writes: [
      { kind: "create", label: "Add a task" },
      { kind: "status", label: "Change a task's status or dates (done, start, snooze)" },
      { kind: "edit", label: "Edit a task or its links" },
      { kind: "comment", label: "Comment on a task" },
      { kind: "import", label: "Copy My list's items into Tasks" },
    ],
    migrations: MIGRATIONS,
    styles,
    script: SCRIPT,
    async init(ctx) {
      await reload(ctx).catch((e) => ctx.log(`init: ${(e as Error)?.message ?? e}`));
    },
    async refresh(ctx) {
      const before = JSON.stringify(kept.map((t) => [t.id, t.updatedAt]));
      await reload(ctx);
      // The day turns over too: what's overdue and what's for today change without a write.
      ctx.publish(before === JSON.stringify(kept.map((t) => [t.id, t.updatedAt])) ? [ID] : [ID, "snapshot"]);
    },
    nav: () => [{ href: "/tasks", title: "Tasks", icon: "tasks", group: "Plan" }],
    pages: () => [
      { title: "Tasks", href: "/tasks", icon: "☑", about: "Your tasks: now, next, waiting, inbox", also: ["todo", "to do", "tasks", "inbox"] },
      { title: "Tasks: weekly review", href: "/tasks/review", icon: "☑", about: "Triage the inbox, chase what's waiting, settle what's late", also: ["review", "weekly"] },
    ],
    // Search is asked per request: a private task shows to its maker only.
    finds: (ctx) =>
      kept
        .filter((t) => isOpen(t) && visibleTo(t, viewer(ctx)))
        .slice(0, 300)
        .map((t) => ({ title: t.title, sub: `${label(t.id)} · ${t.status}${t.area ? ` · #${t.area}` : ""}`, href: taskHref(t.id), also: [label(t.id), ...(t.area ? [t.area] : [])] })),
    refs: (): RefRule[] => [{ pattern: /\bT-\d{1,7}\b/g, href: (m) => `/tasks/${m}` }],
    glance(ctx) {
      const n = nowOf(shared(), today(ctx)).length;
      return n ? [{ label: "Tasks now", value: n }] : [];
    },
    brief(ctx) {
      const n = shared().filter((t) => late(t, today(ctx))).length;
      return n ? [{ text: `${n} ${n === 1 ? "task is" : "tasks are"} overdue.`, href: "/tasks", tone: "warn" }] : [];
    },
    needs(ctx): PackNeed[] {
      const day = today(ctx);
      return shared()
        .filter((t) => late(t, day))
        .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))
        .slice(0, 5)
        .map((t) => ({
          key: `tasks-overdue-${t.id}-${t.due}`,
          title: `${label(t.id)} is overdue: ${t.title}`.slice(0, 200),
          line: `Was due ${whenOf(t.due!, day)}`,
          href: taskHref(t.id),
          tone: "warn",
          rank: t.priority === "high" ? 1 : 2,
          at: Date.parse(`${t.due}T00:00:00Z`),
          ring: "tasks-overdue",
          label: "Tasks",
        }));
    },
    pulse(ctx) {
      const day = today(ctx);
      const asking = shared().filter((t) => isOpen(t) && t.due && t.due <= day && bucketOf(t, day) === "now").length;
      return asking ? { asking } : null;
    },
    bino(ctx) {
      const day = today(ctx);
      const l = listsOf(shared(), day, now());
      const open = l.now.length + l.next.length + l.waiting.length + l.inbox.length + l.later.length;
      if (!open && !l.done.length) return "";
      const lateNow = l.now.filter((t) => late(t, day));
      const lines = [`Tasks (shared; today is ${day}): ${l.now.length} now (${lateNow.length} overdue), ${l.next.length} next, ${l.waiting.length} waiting, ${l.inbox.length} in the inbox, ${l.later.length} later; ${l.done.length} done this week.`];
      for (const t of l.now.slice(0, 15)) lines.push(lineOf(t, day));
      if (l.now.length > 15) lines.push(`… ${l.now.length - 15} more for now.`);
      return lines.join("\n");
    },
    about(ctx, path) {
      if (path === "/tasks/review") return "Tasks: the weekly review (inbox, waiting a week, overdue, done this week).";
      if (path === "/tasks" || path.startsWith("/tasks?")) return "Tasks: the lists (now, next, waiting, inbox, later).";
      const id = idOf(path.replace(/^\/tasks\//, "").split(/[/?#]/)[0]);
      if (!path.startsWith("/tasks/") || !id) return undefined;
      const t = kept.find((x) => x.id === id);
      return t && !t.private ? `A task: ${lineOf(t, today(ctx))}` : "A task (private, or not loaded).";
    },
    dock(ctx) {
      const n = nowOf(shared(), today(ctx)).length;
      return { label: "Tasks", count: n, title: `${n} for now`, key: "T" };
    },
    async today(ctx) {
      // Fresh when it can be (hosted, another isolate may have written), else memory.
      const all = ctx.db ? await fresh(ctx) : kept;
      const who = viewer(ctx);
      const day = today(ctx);
      const mine = all.filter((t) => visibleTo(t, who));
      return [{ id: "now", render: todayCard({ today: day, viewer: who, team: ctx.hosted, now: nowOf(mine, day), inbox: mine.filter((t) => t.status === "inbox").length, overdue: mine.filter((t) => late(t, day)).length }) }];
    },
    lookups,
    acts,
    // My list as Bino, search, New work and other packs read and add to it, for whoever's asking.
    shares: (ctx): { list: ListShare } => ({
      list: {
        items: async () => {
          const who = viewer(ctx);
          return (await fresh(ctx)).filter((t) => visibleTo(t, who)).sort((a, b) => a.position - b.position || a.id - b.id).flatMap((t) => listItemOf(t) ?? []);
        },
        get: async (id) => {
          const t = await findFor(ctx, id, viewer(ctx));
          return t ? listItemOf(t) : undefined;
        },
        add: async (n) => {
          const title = clean(n?.title, 200);
          if (!title) return undefined;
          const status = n.state && isStatus(n.state) ? n.state : "next";
          const t = await createTask(ctx.db, { title, notes: String(n.notes ?? "").slice(0, MAX_NOTES), status, due: isoDate(n.due) ?? null, parent: typeof n.parent === "number" ? n.parent : null }, viewer(ctx), now());
          await log(ctx, "create", t, true);
          await wrote(ctx);
          return listItemOf(t);
        },
        href: (id) => taskHref(id),
      },
    }),
    routes(app, ctx) {
      const page = (c: Context<AppEnv>, title: string, body: Parameters<typeof ctx.page>[1]["body"]) => ctx.page(c, { title, body, current: "/tasks" });
      const who = (c: Context<AppEnv>) => viewerOf(c.get("who"));

      app.get("/tasks", async (c) => {
        const viewer = who(c);
        const all = (await fresh(ctx)).filter((t) => visibleTo(t, viewer));
        const areas = areasOf(all);
        const people = peopleOf(all, viewer);
        const area = c.req.query("area");
        const w = c.req.query("who");
        const filter: Filter = { area: area && areas.includes(area) ? area : undefined, who: w === "mine" || (w && people.includes(w)) ? w : undefined };
        const v = viewOf(ctx, viewer);
        const q = new URLSearchParams();
        if (filter.area) q.set("area", filter.area);
        if (filter.who) q.set("who", filter.who);
        const back = `/tasks${q.size ? `?${q}` : ""}`;
        // What other packs propose for My list (Slack's saved messages): added, they land here, through the share.
        const proposals = ctx.fill("todo.proposals", {}).filter((x) => x !== "");
        const old = myList(ctx);
        const fromTodo = old ? (await notImported(ctx.db, await old.items().catch(() => []))).length : 0;
        return page(c, "Tasks", listsPage({ ...v, lists: listsOf(filtered(all, viewer, filter), v.today, now()), filter, areas, people, back, error: errorOf(c.req.query("e")), fromTodo, proposals }));
      });

      app.post("/tasks/import", strictOrigin, async (c) => {
        const old = myList(ctx);
        if (!old) return c.redirect("/tasks", 303);
        const made = await importTodos(ctx.db, await old.items(), who(c), now());
        await ctx.logged({ kind: "import", target: "My list", detail: `${made.length} item${made.length === 1 ? "" : "s"}`, ok: true });
        if (made.length) await wrote(ctx);
        return c.redirect("/tasks", 303);
      });

      app.get("/tasks/parse", (c) => {
        const day = today(ctx);
        const p = parseQuick(c.req.query("q") ?? "", day);
        c.header("Cache-Control", "no-store");
        return c.json(p.title ? previewOf(p, day) : { title: "", bits: [], error: "No title yet: what's left after the #area, !priority, @person and dates." });
      });

      /** A quick-add from a form: made, logged, pages told. Undefined when it had no title. */
      const quickAdd = async (c: Context<AppEnv>) => {
        const f = await formOf(c);
        const viewer = who(c);
        const p = parseQuick(f.q ?? "", today(ctx));
        if (!p.title) return { f, made: undefined };
        const t = await createTask(ctx.db, newTaskOf(p, viewer, { private: ctx.hosted && f.private === "1" }), viewer, now());
        await log(ctx, "create", t, true);
        await wrote(ctx);
        return { f, made: t };
      };

      app.post("/tasks", strictOrigin, async (c) => {
        const { f, made } = await quickAdd(c);
        const back = backOf(f.back);
        return c.redirect(made ? back : withError(back, "title"), 303);
      });

      app.get("/tasks/review", async (c) => {
        const viewer = who(c);
        const all = (await fresh(ctx)).filter((t) => visibleTo(t, viewer));
        const v = viewOf(ctx, viewer);
        return page(c, "Weekly review", reviewPage({ ...v, ...reviewOf(all, v.today, now()) }));
      });

      app.get("/tasks/dock", async (c) => {
        const viewer = who(c);
        const v = viewOf(ctx, viewer);
        const all = (await fresh(ctx)).filter((t) => visibleTo(t, viewer));
        return ctx.dockPage(c, { title: "Tasks", body: dockView({ ...v, now: nowOf(all, v.today), error: errorOf(c.req.query("e")) }) });
      });
      app.post("/tasks/dock", strictOrigin, async (c) => {
        const { made } = await quickAdd(c);
        return c.redirect(made ? "/tasks/dock" : "/tasks/dock?e=title", 303);
      });

      app.get("/tasks/:id", async (c) => {
        const viewer = who(c);
        const t = await findFor(ctx, c.req.param("id"), viewer);
        if (!t) {
          c.status(404);
          return page(c, "No such task", Empty({ title: "There's no such task here." }));
        }
        if (c.req.param("id") !== label(t.id)) return c.redirect(taskHref(t.id), 301);
        const activity = await activityOf(ctx.db, t.id);
        return page(c, `${label(t.id)} ${t.title}`, detailPage({ ...viewOf(ctx, viewer), task: t, activity, error: errorOf(c.req.query("e")), forgeHost: ctx.forge()?.host || "github.com" }));
      });

      app.post("/tasks/:id/do", strictOrigin, async (c) => {
        const viewer = who(c);
        const f = await formOf(c);
        const back = backOf(f.back);
        const t = await findFor(ctx, c.req.param("id"), viewer);
        if (!t) return c.redirect(withError(back, "gone"), 303);
        const patch = opPatch(f.op ?? "", t, today(ctx));
        if (!patch) return c.redirect(back, 303);
        const r = await updateTask(ctx.db, t, patch, viewer, now());
        if (r.changed.length) {
          await log(ctx, "status", r.task, true);
          await wrote(ctx);
        }
        return c.redirect(back, 303);
      });

      app.post("/tasks/:id/edit", strictOrigin, async (c) => {
        const viewer = who(c);
        const f = await formOf(c);
        const t = await findFor(ctx, c.req.param("id"), viewer);
        if (!t) return c.redirect("/tasks?e=gone", 303);
        const patch: Patch = {};
        if (f.title !== undefined) {
          if (!clean(f.title, 200)) return c.redirect(withError(taskHref(t.id), "title"), 303);
          patch.title = f.title;
        }
        if (isStatus(f.status)) patch.status = f.status;
        if (isPriority(f.priority)) patch.priority = f.priority;
        if (f.area !== undefined) patch.area = f.area;
        for (const k of ["due", "scheduled"] as const) if (f[k] !== undefined) patch[k] = f[k] ? (isoDate(f[k]) ?? t[k]) : null;
        if (f.assignee !== undefined) patch.assignee = assigneeOf(clean(f.assignee, 120), viewer);
        if (f.waiting_on !== undefined) patch.waitingOn = f.waiting_on;
        if (f.notes !== undefined) patch.notes = f.notes;
        // Only its maker may make it private or share it, and only where there's a team.
        if (f.edit === "1" && ctx.hosted && t.createdBy === viewer) patch.private = f.private === "1";
        const r = await updateTask(ctx.db, t, patch, viewer, now());
        if (r.changed.length) {
          await log(ctx, "edit", r.task, true);
          await wrote(ctx);
        }
        return c.redirect(taskHref(t.id), 303);
      });

      app.post("/tasks/:id/links", strictOrigin, async (c) => {
        const viewer = who(c);
        const f = await formOf(c);
        const t = await findFor(ctx, c.req.param("id"), viewer);
        if (!t) return c.redirect("/tasks?e=gone", 303);
        let links = t.links;
        if (f.op === "remove") {
          const i = Number(f.i);
          if (!Number.isInteger(i) || i < 0 || i >= links.length) return c.redirect(taskHref(t.id), 303);
          links = links.filter((_, j) => j !== i);
        } else {
          const l = linkOf(f.ref, f.label);
          if (!l || links.length >= MAX_LINKS) return c.redirect(withError(taskHref(t.id), "link"), 303);
          links = [...links, l];
        }
        const r = await updateTask(ctx.db, t, { links }, viewer, now());
        if (r.changed.length) {
          await log(ctx, "edit", r.task, true);
          await wrote(ctx);
        }
        return c.redirect(taskHref(t.id), 303);
      });

      app.post("/tasks/:id/comment", strictOrigin, async (c) => {
        const viewer = who(c);
        const f = await formOf(c);
        const t = await findFor(ctx, c.req.param("id"), viewer);
        if (!t) return c.redirect("/tasks?e=gone", 303);
        const text = (f.text ?? "").trim().slice(0, MAX_COMMENT);
        if (!text) return c.redirect(withError(taskHref(t.id), "comment"), 303);
        await addComment(ctx.db, t, viewer, text, now());
        await log(ctx, "comment", t, true);
        await wrote(ctx);
        return c.redirect(`${taskHref(t.id)}#tasks`, 303);
      });
    },
  };
}

export const tasksPack: Pack = createTasksPack();
