/**
 * Tasks (`tasks`) views: the lists (/tasks), one task (/tasks/T-42), the weekly review, Today's
 * card and the dock. Every value goes through `html`; links a person typed go through safeUrl.
 * Each one-click button is a Confirm of its write kind: one click unless set to ask twice.
 */
import { html } from "hono/html";
import { Ago, BulkBar, Card, type Child, Confirm, ConfirmSubmit, Empty, Grid2, type Html, Item, KeyValues, List, markdown, Notice, PageHeader, Panel, Pick, Pill, safeUrl, Tabs } from "dovre/pack.ts";
import { type Filter, type Lists, overdue, whenOf } from "./lists.ts";
import { PRIORITIES, STATUSES } from "./parse.ts";
import { type Activity, givenBy, label, shortName, type Task, type TaskLink } from "./store.ts";

export const taskHref = (id: number) => `/tasks/${label(id)}`;

/** Where the task's forms go back to: one of this pack's pages, else the lists. */
export function backOf(v: unknown): string {
  const s = String(v ?? "");
  return /^\/tasks(?:[/?][\w\-./?=&%+:]*)?$/.test(s) && !s.includes("..") && !s.startsWith("//") ? s.slice(0, 300) : "/tasks";
}

const STATUS_WORD: Record<string, string> = { inbox: "Inbox", next: "Next", doing: "Doing", waiting: "Waiting", done: "Done", dropped: "Dropped" };

/** Who as a person reads it: "you", or a name. */
const whoText = (who: string, viewer: string) => (who === viewer ? "you" : shortName(who) || "someone");

export type View = { today: string; viewer: string; /** Hosted: a team may share this cockpit, so tasks can be private. */ team: boolean };

// ── A task's row ──

function dueBit(t: Task, today: string): Child {
  if (!t.due) return "";
  const late = overdue(t, today);
  const tone = late ? "bad" : t.due === today ? "warn" : "neutral";
  return Pill({ tone, children: `${late ? "overdue " : "due "}${whenOf(t.due, today)}`, title: t.due });
}

function metaOf(t: Task, v: View): Child {
  const bits: Child[] = [html`<span class="tasks-id">${label(t.id)}</span>`];
  if (t.area) bits.push(html`<a class="tasks-area" href="/tasks?area=${encodeURIComponent(t.area)}">#${t.area}</a>`);
  if (t.assignee) bits.push(`@${shortName(t.assignee)}${givenBy(t) ? ` from ${whoText(givenBy(t), v.viewer)}` : ""}`);
  if (t.scheduled && t.status !== "done") bits.push(`do ${whenOf(t.scheduled, v.today)}`);
  if (t.status === "waiting" && t.waitingOn) bits.push(`waiting on ${t.waitingOn}`);
  if (t.private) bits.push("private");
  if (t.notes) bits.push("notes");
  return html`<span class="tasks-meta">${bits.map((b, i) => html`${i ? " · " : ""}${b}`)}</span>`;
}

/** One-click buttons on a row: done, start, snooze. */
function rowActs(t: Task, back: string, o: { compact?: boolean } = {}): Html {
  const go = (op: string, lbl: string, q: string) => Confirm({ action: `${taskHref(t.id)}/do`, fields: { op, back }, label: lbl, question: q, kind: "tasks.status" });
  if (t.status === "done" || t.status === "dropped") return html`<span class="tasks-acts">${go("reopen", "Reopen", "Open it again?")}</span>`;
  return html`<span class="tasks-acts">${go("done", "Done", `Mark ${label(t.id)} done?`)}${
    o.compact ? "" : html`${t.status === "doing" ? "" : go("start", "Start", `Start ${label(t.id)}?`)}${go("snooze", "+1d", "Do it tomorrow?")}${go("week", "Next wk", "Do it next week?")}`
  }</span>`;
}

const BULK = "tasks-bulk";
/** A row's tickbox for the review's bulk buttons. */
const pickOf = (t: Task) => Pick({ form: BULK, value: String(t.id), label: `Pick ${label(t.id)}` });

export function taskRow(t: Task, v: View, back: string, o: { compact?: boolean; pick?: boolean } = {}): Html {
  const pills = html`${t.status === "doing" ? Pill({ tone: "accent", children: "doing" }) : ""}${t.priority === "high" ? Pill({ tone: "neutral", children: "!high" }) : ""}${dueBit(t, v.today)}`;
  return Item({
    id: `task-${t.id}`,
    ...(o.pick ? { lead: pickOf(t) } : {}),
    quiet: t.priority === "low" || t.status === "done" || t.status === "dropped",
    title: html`<a href="${taskHref(t.id)}">${t.title}</a>`,
    line: metaOf(t, v),
    trail: html`${pills}${rowActs(t, back, o)}`,
  });
}

const rows = (ts: Task[], v: View, back: string) => List(ts.map((t) => taskRow(t, v, back)));

// ── Quick-add ──

export function quickAdd(o: { action: string; back: string; team: boolean; value?: string; dock?: boolean }): Html {
  return html`<form method="post" action="${o.action}" class="tasks-add" autocomplete="off">
<input type="hidden" name="back" value="${o.back}">
<div class="tasks-add-line"><input type="text" name="q" value="${o.value ?? ""}" maxlength="500" required aria-label="A new task" placeholder="fix mail retries tomorrow !high #skribb @maria due fri" data-tasks-q${o.dock ? "" : " id=\"tasks-q\""}><button type="submit" class="primary">Add</button></div>
<p class="tasks-preview t3 sm" data-tasks-preview aria-live="polite">${o.dock ? "" : html`#area · !high or !low · @person · today, fri, in 3d, 2026-12-01 (do on) · due fri · waiting: first`}</p>
${o.team ? html`<label class="check sm"><input type="checkbox" name="private" value="1"> Only I see it</label>` : ""}
</form>`;
}

// ── /tasks ──

export type ListsModel = View & {
  lists: Lists; filter: Filter; areas: string[]; people: string[]; back: string; error?: string;
  /** My list's items not copied here yet. */
  fromTodo?: number;
  /** Other packs' proposals for My list (the "todo.proposals" slot), already guarded by core. */
  proposals?: Child[];
};

function fromTodoNote(n: number): Html | "" {
  if (!n) return "";
  return Notice({
    tone: "neutral",
    children: html`<span class="tasks-import">Tasks takes My list's place, and My list has ${n} item${n === 1 ? "" : "s"} that aren't tasks yet. ${Confirm({ action: "/tasks/import", label: "Copy them here", question: `Copy ${n} item${n === 1 ? "" : "s"} from My list? My list keeps them.`, kind: "tasks.import" })}</span>`,
  });
}

function filterHref(f: Filter): string {
  const q = new URLSearchParams();
  if (f.area) q.set("area", f.area);
  if (f.who) q.set("who", f.who);
  const s = q.toString();
  return `/tasks${s ? `?${s}` : ""}`;
}

const pageTabs = (at: "lists" | "review") =>
  Tabs({ label: "Tasks", items: [{ href: "/tasks", label: "Lists", current: at === "lists" }, { href: "/tasks/review", label: "Weekly review", current: at === "review" }] });

const ERRORS: Record<string, string> = {
  title: "A task needs a title: what's left after the #area, !priority, @person and dates.",
  gone: "That task isn't here (or isn't yours to see).",
  link: "That isn't a link it knows: owner/repo#12, an http(s) URL, signal:<id> or a path here (/prs).",
  comment: "A comment needs some text.",
  pick: "Tick the tasks first, then press what to do with them.",
};
export const errorOf = (code: unknown) => (typeof code === "string" && code in ERRORS ? ERRORS[code] : undefined);

export function listsPage(m: ListsModel): Html {
  const areaTabs = m.areas.length
    ? Tabs({ label: "Area", items: [{ href: filterHref({ ...m.filter, area: undefined }), label: "All areas", current: !m.filter.area }, ...m.areas.map((a) => ({ href: filterHref({ ...m.filter, area: a }), label: `#${a}`, current: m.filter.area === a }))] })
    : "";
  const whoTabs =
    m.people.length > 1
      ? Tabs({
          label: "Person",
          items: [
            { href: filterHref({ ...m.filter, who: undefined }), label: "Everyone", current: !m.filter.who },
            { href: filterHref({ ...m.filter, who: "mine" }), label: "Mine", current: m.filter.who === "mine" },
            ...m.people.filter((p) => p !== m.viewer).map((p) => ({ href: filterHref({ ...m.filter, who: p }), label: shortName(p), current: m.filter.who === p })),
          ],
        })
      : "";
  const l = m.lists;
  const section = (title: string, ts: Task[], empty?: string) =>
    ts.length || empty ? Panel({ title, meta: String(ts.length), flush: true, children: ts.length ? rows(ts, m, m.back) : html`<p class="t3 tasks-none">${empty}</p>` }) : "";
  const open = l.now.length + l.next.length + l.waiting.length + l.inbox.length + l.later.length;
  return html`${PageHeader({ title: "Tasks", sub: `${l.now.length} now · ${l.inbox.length} in the inbox · ${open} open`, tabs: pageTabs("lists") })}
${m.error ? Notice({ tone: "warn", children: m.error }) : ""}
${fromTodoNote(m.fromTodo ?? 0)}
${quickAdd({ action: "/tasks", back: m.back, team: m.team })}
${m.proposals?.length ? html`<details class="tasks-proposals"><summary>Proposed for My list (${m.proposals.length})</summary><p class="t3 sm">Added, they become tasks here.</p>${m.proposals}</details>` : ""}
${areaTabs ? html`<div class="tasks-filters">${areaTabs}${whoTabs}</div>` : whoTabs ? html`<div class="tasks-filters">${whoTabs}</div>` : ""}
<div data-live id="tasks">
${open ? "" : Empty({ title: "Nothing to do", children: html`<p class="t2">Add one above: what's left after the #area, !priority, @person and dates is its title.</p>` })}
${section("Now", l.now, open ? "Nothing for today." : undefined)}
${section("Next", l.next)}
${section("Waiting", l.waiting)}
${section("Inbox", l.inbox)}
${section("Later", l.later)}
${l.done.length ? html`<details class="tasks-done"><summary>Done this week (${l.done.length})</summary>${List(l.done.map((t) => taskRow(t, m, m.back, { compact: true })))}</details>` : ""}
</div>`;
}

// ── /tasks/review ──

export type ReviewModel = View & { inbox: Task[]; stale: Task[]; overdue: Task[]; done: Task[]; error?: string };

function triageActs(t: Task): Html {
  const back = "/tasks/review";
  const go = (op: string, lbl: string, q: string) => Confirm({ action: `${taskHref(t.id)}/do`, fields: { op, back }, label: lbl, question: q, kind: "tasks.status" });
  return html`<span class="tasks-acts">${go("next", "Next", "Put it on Next?")}${go("start", "Start", "Start it?")}${go("week", "Next wk", "Do it next week?")}${go("drop", "Drop", "Drop it?")}</span>`;
}

export function reviewPage(m: ReviewModel): Html {
  const back = "/tasks/review";
  const panel = (title: string, ts: Task[], empty: string, acts?: (t: Task) => Html) =>
    Panel({
      title,
      meta: String(ts.length),
      flush: true,
      children: ts.length
        ? List(ts.map((t) => (acts ? Item({ id: `task-${t.id}`, lead: pickOf(t), title: html`<a href="${taskHref(t.id)}">${t.title}</a>`, line: metaOf(t, m), trail: html`${dueBit(t, m.today)}${acts(t)}` }) : taskRow(t, m, back, { pick: true }))))
        : html`<p class="t3 tasks-none">${empty}</p>`,
    });
  const n = m.inbox.length + m.stale.length + m.overdue.length;
  const press = (value: string, lbl: string, question: string) => ({ name: "op", value, label: lbl, question, kind: "tasks.status" });
  return html`${PageHeader({ title: "Weekly review", sub: "Empty the inbox, chase what's waiting, settle what's late, see what got done.", tabs: pageTabs("review") })}
${m.error ? Notice({ tone: "warn", children: m.error }) : ""}
${n ? BulkBar({ id: BULK, action: "/tasks/bulk", label: "The ticked ones (x ticks a row):", fields: { back }, buttons: [press("next", "Next", "Put the ticked tasks on Next?"), press("week", "Next wk", "Do the ticked tasks next week?"), press("done", "Done", "Mark the ticked tasks done?"), press("drop", "Drop", "Drop the ticked tasks?")] }) : ""}
<div data-live id="tasks">
${panel("Inbox to triage", m.inbox, "The inbox is empty.", triageActs)}
${panel("Waiting a week or more", m.stale, "Nothing has waited a week.")}
${panel("Overdue", m.overdue, "Nothing is overdue.")}
${Panel({ title: "Done this week", meta: String(m.done.length), flush: true, children: m.done.length ? List(m.done.map((t) => taskRow(t, m, back, { compact: true }))) : html`<p class="t3 tasks-none">Nothing done yet this week.</p>` })}
</div>`;
}

// ── /tasks/T-42 ──

export type DetailModel = View & { task: Task; activity: Activity[]; error?: string; /** Where a link of kind "issue" points (the forge's host). */ forgeHost: string };

export function linkHref(l: TaskLink, forgeHost: string): string {
  if (l.kind === "issue") {
    const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(l.ref);
    return m ? safeUrl(`https://${forgeHost}/${m[1]}/${m[2]}/issues/${m[3]}`) : "#";
  }
  if (l.kind === "page") return /^\/(?![/\\])/.test(l.ref) ? l.ref : "#";
  if (l.kind === "url") return safeUrl(l.ref);
  return "#";
}

const option = (value: string, text: string, on: boolean) => html`<option value="${value}"${on ? " selected" : ""}>${text}</option>`;

function editForm(m: DetailModel): Html {
  const t = m.task;
  const field = (name: string, lbl: string, value: string, extra: Child = "") => html`<label class="field"><span class="label">${lbl}</span><input type="text" name="${name}" value="${value}" maxlength="200"${extra}></label>`;
  const dateField = (name: string, lbl: string, value: string | null) => html`<label class="field"><span class="label">${lbl}</span><input type="date" name="${name}" value="${value ?? ""}"></label>`;
  return html`<form method="post" action="${taskHref(t.id)}/edit" class="tasks-edit">
<label class="field"><span class="label">Title</span><input type="text" name="title" value="${t.title}" maxlength="200" required></label>
<div class="fields">
<label class="field"><span class="label">Status</span><select name="status">${STATUSES.map((s) => option(s, STATUS_WORD[s]!, s === t.status))}</select></label>
<label class="field"><span class="label">Priority</span><select name="priority">${PRIORITIES.map((p) => option(p, p, p === t.priority))}</select></label>
${field("area", "Area", t.area)}
</div>
<div class="fields">
${dateField("scheduled", "Do on", t.scheduled)}
${dateField("due", "Due", t.due)}
${field("assignee", "Assignee", t.assignee)}
${field("waiting_on", "Waiting on", t.waitingOn)}
</div>
<label class="field"><span class="label">Notes (Markdown)</span><textarea name="notes" rows="8" maxlength="20000">\n${t.notes}</textarea></label>
${m.team && t.createdBy === m.viewer ? html`<label class="check sm"><input type="checkbox" name="private" value="1"${t.private ? " checked" : ""}> Only I see it</label>` : ""}
<input type="hidden" name="edit" value="1">
<div class="buttons">${ConfirmSubmit({ label: "Save", question: `Save ${label(t.id)}?`, kind: "tasks.edit", primary: true })}</div>
</form>`;
}

function linksPanel(m: DetailModel): Html {
  const t = m.task;
  const items = t.links.map((l, i) => {
    const href = linkHref(l, m.forgeHost);
    const text = l.label || (l.kind === "signal" ? `signal ${l.ref}` : l.ref);
    return Item({
      title: href === "#" ? text : html`<a href="${href}"${/^https?:/i.test(href) ? html` target="_blank" rel="noopener noreferrer"` : ""}>${text}</a>`,
      line: l.label ? `${l.kind} · ${l.ref}` : l.kind,
      trail: Confirm({ action: `${taskHref(t.id)}/links`, fields: { op: "remove", i: String(i) }, label: "Remove", question: "Remove this link?", kind: "tasks.edit" }),
    });
  });
  return Panel({
    title: "Links",
    meta: String(t.links.length),
    children: html`${items.length ? List(items) : ""}<form method="post" action="${taskHref(t.id)}/links" class="tasks-link-add fields">
<input type="hidden" name="op" value="add">
<label class="field"><span class="label">Link</span><input type="text" name="ref" maxlength="500" placeholder="owner/repo#12, https://…, signal:id or /prs" required></label>
<label class="field"><span class="label">Label</span><input type="text" name="label" maxlength="120" placeholder="optional"></label>
<div class="buttons">${ConfirmSubmit({ label: "Add link", question: "Add this link?", kind: "tasks.edit" })}</div>
</form>`,
  });
}

function activityPanel(m: DetailModel): Html {
  const items = m.activity.map((a) =>
    Item({
      title: html`<strong>${whoText(a.who, m.viewer)}</strong> ${a.what === "comment" ? "commented" : a.what === "status" ? "changed the status" : a.what}`,
      line: html`${Ago(a.at)}${a.detail ? html` · ${a.detail}` : ""}`,
      more: a.text ? html`<span class="tasks-comment">${a.text}</span>` : "",
    }),
  );
  return Panel({
    title: "Activity",
    meta: String(m.activity.length),
    children: html`<form method="post" action="${taskHref(m.task.id)}/comment" class="tasks-comment-add" data-ctrl-enter>
<label class="field"><span class="label">Comment</span><textarea name="text" rows="3" maxlength="4000" required></textarea></label>
<div class="buttons">${ConfirmSubmit({ label: "Comment", question: "Add this comment?", kind: "tasks.comment" })}</div>
</form>${items.length ? List(items) : ""}`,
  });
}

export function detailPage(m: DetailModel): Html {
  const t = m.task;
  const facts: [Child, Child][] = [
    ["Status", STATUS_WORD[t.status] ?? t.status],
    ["Made by", whoText(t.createdBy, m.viewer)],
    ["Made", Ago(t.createdAt)],
  ];
  if (t.doneAt) facts.push([t.status === "dropped" ? "Dropped" : "Done", Ago(t.doneAt)]);
  return html`${PageHeader({
    title: t.title,
    sub: html`${label(t.id)}${t.area ? ` · #${t.area}` : ""}${t.private ? " · private" : ""}`,
    crumbs: [{ href: "/tasks", label: "Tasks" }, { label: label(t.id) }],
    actions: html`${dueBit(t, m.today)}${rowActs(t, taskHref(t.id))}`,
  })}
${m.error ? Notice({ tone: "warn", children: m.error }) : ""}
<div data-live id="tasks">
${Grid2(html`<div>
${t.notes.trim() ? Panel({ title: "Notes", children: html`<div class="tasks-notes md">${markdown(t.notes)}</div>` }) : ""}
${Panel({ title: "Edit", children: editForm(m) })}
</div>
<div>
${Panel({ title: "About", children: KeyValues(facts) })}
${linksPanel(m)}
${activityPanel(m)}
</div>`)}
</div>`;
}

// ── Today and the dock ──

export function todayCard(o: View & { now: Task[]; inbox: number; overdue: number }): Html {
  const top = o.now.slice(0, 7);
  return Card({
    id: "tasks-now",
    title: "Tasks",
    meta: html`${o.overdue ? html`<span class="tasks-late">${o.overdue} overdue</span> · ` : ""}<a href="/tasks">${o.inbox} in the inbox</a>`,
    children: top.length ? List(top.map((t) => taskRow(t, o, "/tasks", { compact: true }))) : html`<p class="t2">Nothing due, late or doing.</p>`,
    foot: o.now.length > top.length ? html`<a href="/tasks">${o.now.length - top.length} more for now</a>` : "",
  });
}

export function dockView(o: View & { now: Task[]; error?: string }): Html {
  return html`<div class="tasks-dock">${quickAdd({ action: "/tasks/dock", back: "/tasks/dock", team: o.team, dock: true })}
${o.error ? Notice({ tone: "warn", children: o.error }) : ""}
<div data-live id="tasks">${o.now.length ? List(o.now.slice(0, 20).map((t) => taskRow(t, o, "/tasks/dock", { compact: true }))) : html`<p class="t3">Nothing for now.</p>`}</div>
<p class="t3 sm"><a href="/tasks" target="_top">All tasks</a></p></div>`;
}

export const styles = `
.tasks-add { margin: 0 0 14px; }
.tasks-add-line { display: flex; gap: 8px; }
.tasks-add-line input { flex: 1 1 auto; min-width: 0; }
.tasks-preview { margin: 6px 0 0; min-height: 1.4em; }
.tasks-preview .tasks-chip { display: inline-block; margin: 0 6px 0 0; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-s); color: var(--ink-2); font-size: var(--fs-xs); }
.tasks-preview .tasks-chip.tasks-chip-title { color: var(--ink); border-color: transparent; padding-left: 0; }
.tasks-filters { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 12px; }
.tasks-meta { color: var(--ink-3); font-size: var(--fs-xs); }
.tasks-id { font-family: var(--mono); }
.tasks-area { color: inherit; }
.tasks-acts { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 8px; vertical-align: middle; }
.tasks-acts button, .tasks-acts summary { font-size: var(--fs-xs); padding: 2px 7px; }
.tasks-none { margin: 10px 14px; }
.tasks-done { margin: 8px 0 0; }
.tasks-done > summary { cursor: pointer; color: var(--ink-2); font-size: var(--fs-s); padding: 6px 0; }
.tasks-comment { display: block; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); margin-top: 4px; }
.tasks-notes { overflow-wrap: anywhere; }
.tasks-edit textarea, .tasks-comment-add textarea { width: 100%; resize: vertical; }
.tasks-link-add { margin-top: 10px; }
.tasks-late { color: var(--bad); }
.tasks-import form.post, .tasks-import details { margin-left: 8px; }
.tasks-proposals { margin: 0 0 12px; }
.tasks-proposals > summary { cursor: pointer; color: var(--ink-2); font-size: var(--fs-s); }
.tasks-dock .tasks-add { margin-bottom: 8px; }
.tasks-dock .tasks-acts { margin-left: 4px; }
`;
