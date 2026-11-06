/** Tasks (`tasks`): the quick-add parser, the store on a real SQLite, the lists, escaping, privacy and the acts' re-checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, type D1 } from "dovre/db.ts";
import { assertFragment, assertInert, HOSTILE, packApp, testContext } from "dovre/packs/testing.ts";
import type { PackContext } from "dovre/packs/types.ts";
import { viewingAs } from "dovre/viewer.ts";
import { html } from "dovre/ui/kit.ts";
import { createTasksPack, newTaskOf, opPatch, previewOf } from "../index.ts";
import { bucketOf, filtered, listsOf, peopleOf, reviewOf } from "../lists.ts";
import { addDays, dateFrom, dayOf, isoDate, parseQuick, readDate } from "../parse.ts";
import { activityOf, addComment, createTask, getTask, idOf, importTodos, linkOf, loadKept, searchTasks, type Task, todoLeft, updateTask } from "../store.ts";
import { detailPage, dockView, listsPage, reviewPage, todayCard } from "../view.ts";

// Friday 2026-11-06.
const TODAY = "2026-11-06";
const NOW = Date.parse("2026-11-06T09:00:00Z");
const JS = "javascript:alert(1)";

// ── The quick-add line ──

test("parse: the example line", () => {
  const p = parseQuick("fix skribb mail retries tomorrow !high #skribb @maria due fri", TODAY);
  assert.deepEqual(p, { title: "fix skribb mail retries", status: "next", priority: "high", area: "skribb", assignee: "maria", scheduled: "2026-11-07", due: TODAY });
});

test("parse: a bare title goes to the inbox", () => {
  assert.deepEqual(parseQuick("  call the dentist  ", TODAY), { title: "call the dentist", status: "inbox", priority: "normal" });
});

test("parse: dates", () => {
  const s = (line: string) => parseQuick(`x ${line}`, TODAY).scheduled;
  assert.equal(s("today"), TODAY);
  assert.equal(s("tomorrow"), "2026-11-07");
  assert.equal(s("tmr"), "2026-11-07");
  assert.equal(s("fri"), TODAY, "a weekday is the next one, today counts (as My list reads it)");
  assert.equal(s("next fri"), "2026-11-13");
  assert.equal(s("fre"), TODAY);
  assert.equal(s("i dag"), TODAY);
  assert.equal(s("i morgen"), "2026-11-07");
  assert.equal(s("imorgen"), "2026-11-07");
  assert.equal(s("!"), TODAY);
  assert.equal(s("6.11"), TODAY);
  assert.equal(s("30.10."), "2027-10-30", "the next 30 October");
  assert.equal(s("31.2"), undefined, "no such day");
  assert.equal(s("monday"), "2026-11-09");
  assert.equal(s("Sat"), "2026-11-07");
  assert.equal(s("next week"), "2026-11-09");
  assert.equal(s("next tue"), "2026-11-10");
  assert.equal(s("in 3d"), "2026-11-09");
  assert.equal(s("in 2w"), "2026-11-20");
  assert.equal(s("in 3 days"), "2026-11-09");
  assert.equal(s("in 1m"), "2026-12-06");
  assert.equal(s("2026-12-24"), "2026-12-24");
  assert.equal(parseQuick("x in 1m", "2026-01-31").scheduled, "2026-02-28", "a month on keeps to the month's end");
  assert.equal(s("2026-02-30"), undefined, "not a real day");
  assert.equal(parseQuick("x 2026-02-30", TODAY).title, "x 2026-02-30");
  assert.equal(s("in 3 boxes"), undefined);
  assert.equal(parseQuick("put it in 3 boxes", TODAY).title, "put it in 3 boxes");
  assert.equal(s("in 999d"), undefined, "too far is text");
});

test("parse: due vs do-on, and the first of each counts", () => {
  const p = parseQuick("ship it due tomorrow mon #a #b !low !high @x @y", TODAY);
  assert.equal(p.due, "2026-11-07");
  assert.equal(p.scheduled, "2026-11-09");
  assert.equal(p.area, "a");
  assert.equal(p.priority, "low");
  assert.equal(p.assignee, "x");
  assert.equal(p.title, "ship it #b !high @y");
  assert.equal(parseQuick("pay due bills", TODAY).title, "pay due bills", "due without a date is text");
  assert.deepEqual(parseQuick("a today b tomorrow", TODAY), { title: "a today b", status: "next", priority: "normal", scheduled: "2026-11-07" }, "a date alone counts only at the end");
  assert.deepEqual(parseQuick("fix man page", TODAY), { title: "fix man page", status: "inbox", priority: "normal" });
  assert.equal(parseQuick("fix man page man", TODAY).scheduled, "2026-11-09");
  assert.equal(parseQuick("review the 2026-12-01 plan due mon", TODAY).title, "review the 2026-12-01 plan", "due counts anywhere");
  assert.equal(parseQuick("x constructor", TODAY).title, "x constructor");
  assert.equal(parseQuick("x !constructor !__proto__", TODAY).priority, "normal");
  assert.equal(parseQuick("x __proto__", TODAY).scheduled, undefined);
});

test("parse: priorities, people and waiting", () => {
  assert.equal(parseQuick("x !h", TODAY).priority, "high");
  assert.equal(parseQuick("x !3", TODAY).priority, "low");
  assert.equal(parseQuick("x !urgent", TODAY).title, "x !urgent");
  assert.equal(parseQuick("x @me", TODAY).assignee, "me");
  assert.equal(parseQuick("x @maria@acme.no", TODAY).assignee, "maria@acme.no");
  assert.equal(parseQuick("x #Skribb", TODAY).area, "skribb");
  assert.equal(parseQuick("x #", TODAY).title, "x #");
  const w = parseQuick("waiting:maria the contract #legal", TODAY);
  assert.equal(w.status, "waiting");
  assert.equal(w.waitingOn, "maria");
  assert.equal(w.title, "the contract");
  assert.equal(parseQuick("Waiting: invoice from bank", TODAY).status, "waiting");
  assert.equal(parseQuick("Waiting: invoice from bank", TODAY).waitingOn, undefined);
  assert.equal(parseQuick("not waiting: here", TODAY).status, "inbox");
});

test("parse: hostile and odd input stays text, cut to size", () => {
  const p = parseQuick(`${HOSTILE} #<b> @<img !high`, TODAY);
  assert.ok(p.title.includes("<script>"), "markup is text here: the views escape it");
  assert.equal(p.area, undefined, "#<b> is no area");
  assert.equal(p.assignee, undefined);
  assert.equal(parseQuick("a\u0000b‮c\nd\te", TODAY).title, "a b c d e");
  assert.equal(parseQuick("x".repeat(5000), TODAY).title.length, 200);
  assert.equal(parseQuick("", TODAY).title, "");
  assert.equal(parseQuick("#only !high tomorrow", TODAY).title, "");
  assert.equal(parseQuick(undefined, TODAY).title, "");
  assert.equal(parseQuick({ toString: () => "obj" }, TODAY).title, "obj");
  assert.equal(parseQuick("in", TODAY).title, "in");
  assert.equal(parseQuick("next", TODAY).title, "next");
  assert.equal(parseQuick("due", TODAY).title, "due");
  assert.equal(readDate([], TODAY), undefined);
  assert.equal(parseQuick("__proto__ constructor #__proto__", TODAY).area, undefined, "an area starts with a letter or digit");
});

test("dates: helpers", () => {
  assert.equal(isoDate("2026-11-06"), "2026-11-06");
  assert.equal(isoDate("1999-01-01"), undefined);
  assert.equal(isoDate("2026-13-01"), undefined);
  assert.equal(isoDate(42), undefined);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(dateFrom("next week", TODAY), "2026-11-09");
  assert.equal(dateFrom("fri soon", TODAY), undefined);
  assert.equal(dayOf(Date.parse("2026-11-06T23:30:00Z"), "Europe/Oslo"), "2026-11-07");
  assert.equal(dayOf(Date.parse("2026-11-06T23:30:00Z"), "Not/AZone"), "2026-11-06");
});

// ── The store ──

const db = (): D1 => openDb().DB;

test("store: create, edit, status, comment, activity", async () => {
  const d = db();
  const t = await createTask(d, newTaskOf(parseQuick("fix retries tomorrow #skribb !high due fri", TODAY), ""), "", NOW);
  assert.equal(t.id, 1);
  assert.equal(idOf("T-1"), 1);
  assert.equal(idOf("t1"), 1);
  assert.equal(idOf("#1"), 1);
  assert.equal(idOf("T-0"), undefined);
  assert.equal(idOf("1; DROP TABLE"), undefined);
  assert.equal(t.status, "next");
  assert.equal(t.scheduled, "2026-11-07");
  const r = await updateTask(d, t, { status: "doing", notes: "a\r\nb" }, "", NOW + 1000);
  assert.deepEqual(r.changed, ["edited the notes", "status next → doing"]);
  assert.equal(r.task.notes, "a\nb");
  assert.equal((await updateTask(d, r.task, { status: "doing" }, "", NOW + 2000)).changed.length, 0, "nothing changed, nothing written");
  const done = (await updateTask(d, r.task, { status: "done" }, "", NOW + 3000)).task;
  assert.equal(done.doneAt, NOW + 3000);
  const back = (await updateTask(d, done, { status: "next" }, "", NOW + 4000)).task;
  assert.equal(back.doneAt, null);
  await addComment(d, back, "", "looks good", NOW + 5000);
  await assert.rejects(() => addComment(d, back, "", "   ", NOW));
  const acts = await activityOf(d, t.id);
  assert.deepEqual(acts.map((a) => a.what), ["comment", "status", "status", "edited", "created"]);
  assert.equal(acts[0]!.text, "looks good");
  await assert.rejects(() => createTask(d, { title: "  " }, "", NOW));
});

test("store: search escapes LIKE and SQL; links are checked", async () => {
  const d = db();
  await createTask(d, { title: "100% done_ish" }, "", NOW);
  await createTask(d, { title: "something else", notes: "mentions retries" }, "", NOW);
  assert.equal((await searchTasks(d, "%")).length, 1);
  assert.equal((await searchTasks(d, "_")).length, 1);
  assert.equal((await searchTasks(d, "retries")).length, 1, "notes count");
  assert.equal((await searchTasks(d, "' OR 1=1 --")).length, 0);
  assert.equal((await searchTasks(d, "")).length, 0);
  assert.deepEqual(linkOf("acme/shop#12"), { kind: "issue", ref: "acme/shop#12", label: undefined });
  assert.equal(linkOf("https://x.test/a?b=1")?.kind, "url");
  assert.equal(linkOf("signal:abc-1")?.ref, "abc-1");
  assert.equal(linkOf("/prs/acme/shop/3")?.kind, "page");
  assert.equal(linkOf(JS), undefined);
  assert.equal(linkOf("//evil.test/x"), undefined);
  assert.equal(linkOf("/\\evil.test"), undefined);
  assert.equal(linkOf("/a/../../etc"), undefined);
  assert.equal(linkOf("data:text/html,x"), undefined);
});

test("store: memory keeps open tasks and those closed lately", async () => {
  const d = db();
  const a = await createTask(d, { title: "open" }, "", NOW);
  const b = await createTask(d, { title: "old done", status: "done" }, "", NOW - 30 * 86400_000);
  await createTask(d, { title: "new done", status: "done" }, "", NOW - 86400_000);
  const kept = await loadKept(d, NOW);
  assert.deepEqual(kept.map((t) => t.title).sort(), ["new done", "open"]);
  assert.ok(await getTask(d, b.id), "never deleted");
  assert.ok(a);
});

test("store: My list's items come over once, steps keep their initiative", async () => {
  const d = db();
  assert.equal(await todoLeft(d), 0);
  const ins = (id: number, parent: number | null, title: string, state: string, due: string | null) =>
    d.prepare("INSERT INTO todo (id, parent, title, notes, state, due, pos, created_at, updated_at, done_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)").bind(id, parent, title, state, due, id, NOW, NOW, state === "done" ? NOW : null).run();
  await ins(1, null, "Launch", "doing", "2026-11-20");
  await ins(2, 1, `step ${HOSTILE}`, "next", null);
  await ins(3, null, "old", "done", null);
  assert.equal(await todoLeft(d), 3);
  const made = await importTodos(d, "", NOW);
  assert.deepEqual(made.map((t) => [t.title, t.status, t.due]), [["Launch", "doing", "2026-11-20"], ["old", "done", null], [`step ${HOSTILE}`, "next", null]]);
  assert.deepEqual(made[2]!.links, [{ kind: "page", ref: "/tasks/T-1", label: "Part of T-1" }]);
  assert.equal(await todoLeft(d), 0);
  assert.equal((await importTodos(d, "", NOW)).length, 0, "never twice");
  await ins(4, 1, "later step", "next", null);
  const more = await importTodos(d, "", NOW);
  assert.equal(more[0]!.links[0]?.ref, "/tasks/T-1", "a step added later finds its imported parent");
});

// ── The lists ──

const T = (o: Partial<Task>): Task => ({
  id: 1, title: "t", notes: "", status: "next", priority: "normal", area: "", due: null, scheduled: null, waitingOn: "", createdBy: "", assignee: "",
  private: false, links: [], position: 0, createdAt: NOW, updatedAt: NOW, statusAt: NOW, doneAt: null, ...o,
});

test("lists: which list a task is on", () => {
  assert.equal(bucketOf(T({ status: "doing" }), TODAY), "now");
  assert.equal(bucketOf(T({ due: "2026-11-01" }), TODAY), "now");
  assert.equal(bucketOf(T({ scheduled: TODAY }), TODAY), "now");
  assert.equal(bucketOf(T({ status: "waiting", scheduled: TODAY }), TODAY), "waiting");
  assert.equal(bucketOf(T({ status: "waiting", due: TODAY }), TODAY), "now");
  assert.equal(bucketOf(T({ status: "inbox" }), TODAY), "inbox");
  assert.equal(bucketOf(T({ scheduled: "2026-12-01" }), TODAY), "later");
  assert.equal(bucketOf(T({ status: "done" }), TODAY), "closed");
  const l = listsOf([T({ id: 1, priority: "low", due: TODAY }), T({ id: 2, priority: "high", due: TODAY }), T({ id: 3, status: "doing" })], TODAY, NOW);
  assert.deepEqual(l.now.map((t) => t.id), [3, 2, 1]);
  const r = reviewOf([T({ id: 1, status: "waiting", statusAt: NOW - 8 * 86400_000 }), T({ id: 2, status: "waiting" }), T({ id: 3, status: "done", doneAt: NOW - 1000 })], TODAY, NOW);
  assert.deepEqual(r.stale.map((t) => t.id), [1]);
  assert.deepEqual(r.done.map((t) => t.id), [3]);
});

test("lists: snooze and the one-click buttons", () => {
  assert.deepEqual(opPatch("snooze", T({ status: "doing" }), TODAY), { scheduled: "2026-11-07", status: "next" });
  assert.deepEqual(opPatch("week", T({ status: "waiting" }), TODAY), { scheduled: "2026-11-09" });
  assert.deepEqual(opPatch("done", T({}), TODAY), { status: "done" });
  assert.equal(opPatch("rm -rf", T({}), TODAY), undefined);
});

test("privacy: a private task is its maker's alone in every list", () => {
  const ann = "ann@acme.no", bob = "bob@acme.no";
  const ts = [T({ id: 1, title: "shared", createdBy: ann }), T({ id: 2, title: "ann's secret", createdBy: ann, private: true, assignee: "bob" })];
  assert.deepEqual(filtered(ts, bob, {}).map((t) => t.id), [1]);
  assert.deepEqual(filtered(ts, bob, { who: "mine" }).map((t) => t.id), [], "assigned to bob, still ann's alone");
  assert.deepEqual(filtered(ts, ann, {}).map((t) => t.id), [1, 2]);
  assert.deepEqual(filtered(ts, "", {}).map((t) => t.id), [1], "nobody (a background read) sees none");
  assert.deepEqual(peopleOf(ts, bob), [ann], "nor does its assignee show up through it");
  assert.deepEqual(filtered(ts, ann, { who: "mine" }).map((t) => t.id), [1]);
});

// ── Views escape everything ──

const EVIL = (o: Partial<Task> = {}): Task =>
  T({ id: 7, title: HOSTILE, notes: `${HOSTILE}\n\n[x](${JS})`, area: HOSTILE, assignee: HOSTILE, waitingOn: HOSTILE, status: "waiting", due: "2026-11-01", createdBy: HOSTILE, links: [{ kind: "url", ref: JS, label: HOSTILE }, { kind: "page", ref: "//evil.test", label: "p" }, { kind: "issue", ref: "a/b#1" }], ...o });

test("views: hostile text stays text, javascript: links don't get through", async () => {
  const v = { today: TODAY, viewer: "", team: true };
  const t = EVIL();
  const outs: [string, string][] = [
    ["lists", String(await listsPage({ ...v, lists: listsOf([t, EVIL({ id: 8, status: "doing" }), EVIL({ id: 9, status: "done", doneAt: NOW })], TODAY, NOW), filter: { area: HOSTILE, who: HOSTILE }, areas: [HOSTILE], people: [HOSTILE, "x"], back: "/tasks", error: HOSTILE }))],
    ["review", String(await reviewPage({ ...v, inbox: [t], stale: [t], overdue: [t], done: [t] }))],
    ["detail", String(await detailPage({ ...v, task: t, activity: [{ id: 1, taskId: 7, at: NOW, who: HOSTILE, what: HOSTILE, detail: HOSTILE, text: HOSTILE }], error: HOSTILE, forgeHost: "github.com" }))],
    ["card", String(await todayCard({ ...v, now: [t], inbox: 1, overdue: 1 }))],
    ["dock", String(await dockView({ ...v, now: [t], error: HOSTILE }))],
  ];
  for (const [name, out] of outs) {
    assertInert(name, out);
    assertFragment(name, out);
    assert.ok(!/href="javascript:/i.test(out), `${name}: a javascript: link got through`);
    assert.ok(!out.includes('href="//evil.test'), `${name}: a protocol-relative link got through`);
  }
  assert.match(outs[2]![1], /href="https:\/\/github\.com\/a\/b\/issues\/1"/);
});

// ── The pack ──

function ctxFor(d: D1, over: Partial<PackContext> = {}) {
  const published: string[] = [];
  return { ctx: testContext({ db: d, env: { TZ_NAME: "UTC" }, publish: (t) => void published.push(...t), ...over }), published };
}

async function seeded() {
  const d = openDb().DB;
  const pack = createTasksPack({ now: () => NOW });
  const { ctx, published } = ctxFor(d);
  await createTask(d, { title: "shared overdue", due: "2026-11-01", notes: "shared notes", status: "next" }, "", NOW);
  await createTask(d, { title: "SECRET overdue thing", due: "2026-11-01", notes: "SECRET notes", private: true, status: "doing" }, "ann@acme.no", NOW);
  await createTask(d, { title: "doing now", status: "doing", area: "skribb" }, "", NOW);
  await pack.refresh!(ctx);
  return { d, pack, ctx, published };
}

test("pack: bino, needs, pulse, finds and lookups never show a private task", async () => {
  const { pack, ctx, published } = await seeded();
  assert.ok(published.includes("tasks"));
  const bino = pack.bino!(ctx);
  assert.match(bino, /T-1 \[next, due 2026-11-01 \(overdue\)\]: shared overdue/);
  assert.match(bino, /doing now/);
  assert.ok(!bino.includes("SECRET"));
  assert.ok(!bino.includes("notes"), "never the notes");
  const needs = pack.needs!(ctx);
  assert.deepEqual(needs.map((n) => n.key), ["tasks-overdue-1-2026-11-01"]);
  assert.deepEqual(pack.pulse!(ctx), { asking: 1 });
  assert.ok(!JSON.stringify(pack.finds!(ctx)).includes("SECRET"));
  assert.ok(!JSON.stringify(pack.brief!(ctx)).includes("SECRET"));
  assert.equal(await pack.about!(ctx, "/tasks/T-2"), "A task (private, or not loaded).");
  const look = Object.fromEntries(pack.lookups!(ctx).map((l) => [l.kind, l]));
  for (const [kind, args] of [["list", {}], ["list", { status: "doing" }], ["list", { due: "overdue" }], ["search", { q: "SECRET" }], ["search", { q: "overdue" }], ["task", { id: "T-2" }]] as const) {
    const out = await look[kind]!.run({ ...args }, ctx);
    assert.ok(!out.includes("SECRET"), `${kind} ${JSON.stringify(args)}: ${out}`);
  }
  assert.match(await look.task!.run({ id: "T-1" }, ctx), /Notes:\nshared notes/);
  assert.match(await look.list!.run({ area: "skribb" }, ctx), /T-3/);
  assert.match(await look.list!.run({ status: "bogus" }, ctx), /no status/);
  assert.match(await look.list!.run({ due: "<script>" }, ctx), /isn't a due window/);
});

test("pack: Today's card is for whoever's looking", async () => {
  const { pack, ctx } = await seeded();
  const card = async (who: string | undefined) => String(await (await viewingAs(who, () => pack.today!(ctx)))[0]!.render);
  assert.ok((await card("ann@acme.no")).includes("SECRET"), "its maker sees it");
  assert.ok(!(await card("bob@acme.no")).includes("SECRET"));
  assert.ok(!(await card(undefined)).includes("SECRET"));
  assertFragment("card", await card("ann@acme.no"));
});

test("acts: each re-checks, refuses and logs", async () => {
  const { d, pack, ctx } = await seeded();
  const acts = Object.fromEntries(pack.acts!(ctx).map((a) => [a.kind, a]));
  assert.deepEqual(Object.keys(acts), ["create", "status", "schedule", "edit", "comment"]);
  const logged = async () => (await d.prepare("SELECT kind, target, ok, error, detail FROM actions ORDER BY id").all<{ kind: string; target: string; ok: number; error: string | null; detail: string | null }>()).results;

  const made = await acts.create!.run({ title: "write report fri #work !high", notes: "n" }, {}, ctx);
  assert.deepEqual(made, { ok: true, done: "Added T-4", href: "/tasks/T-4" });
  const t4 = await getTask(d, 4);
  assert.equal(t4?.scheduled, TODAY);
  assert.equal(t4?.area, "work");
  assert.equal((await acts.create!.run({ title: "x", due: "someday-ish" }, {}, ctx)).ok, false);

  assert.equal((await acts.status!.run({ task: "T-99", status: "done" }, {}, ctx)).ok, false, "no such task");
  const priv = await acts.status!.run({ task: "T-2", status: "done" }, {}, ctx);
  assert.equal(priv.ok, false, "a private task isn't the local person's when someone else made it");
  assert.equal((await getTask(d, 2))?.status, "doing", "and nothing was written");
  assert.equal((await acts.status!.run({ task: "T-3", status: "doing" }, {}, ctx)).ok, false, "already there");
  assert.equal((await acts.status!.run({ task: "T-3", status: "finished" }, {}, ctx)).ok, false, "no such status");
  assert.deepEqual(await acts.status!.run({ task: "t3", status: "done" }, {}, ctx), { ok: true, done: "Moved T-3 to done", href: "/tasks/T-3" });

  assert.equal((await acts.schedule!.run({ task: "T-3", scheduled: "tomorrow" }, {}, ctx)).ok, false, "done: let it be");
  assert.deepEqual(await acts.schedule!.run({ task: "T-1", scheduled: "next week", due: "none" }, {}, ctx), { ok: true, done: "T-1: do Mon 9 Nov", href: "/tasks/T-1" });
  assert.equal((await acts.schedule!.run({ task: "T-1", scheduled: "next week" }, {}, ctx)).ok, false, "unchanged");

  assert.equal((await acts.edit!.run({ task: "T-1" }, {}, ctx)).ok, false, "nothing to change");
  assert.equal((await acts.edit!.run({ task: "T-1", assignee: "maria", priority: "high" }, {}, ctx)).ok, true);
  assert.equal((await getTask(d, 1))?.assignee, "maria");
  assert.equal((await acts.comment!.run({ task: "T-1", text: "on it" }, {}, ctx)).ok, true);
  assert.equal((await acts.comment!.run({ task: "T-3", text: "late" }, {}, ctx)).ok, false, "done tasks take no comments");

  const log = await logged();
  assert.ok(log.some((l) => l.kind === "tasks.status" && l.target === "T-99 to done" && !l.ok));
  assert.ok(log.some((l) => l.kind === "tasks.status" && l.target === "T-2 to done" && !l.ok));
  assert.ok(log.some((l) => l.kind === "tasks.create" && l.ok && l.detail === "write report"));
  assert.ok(log.some((l) => l.kind === "tasks.comment" && l.ok));
  assert.ok(!JSON.stringify(log).includes("SECRET"));
  assert.ok(!JSON.stringify(log).includes("on it"), "never the comment's text");
});

test("routes: quick-add, a task's page, the buttons, the Origin guard, hostile titles", async () => {
  const pack = createTasksPack();
  const app = packApp([pack]);
  const list = await app.get("/tasks");
  assert.equal(list.status, 200);
  assert.match(await list.text(), /data-tasks-q/);

  const parsed = await (await app.get(`/tasks/parse?q=${encodeURIComponent("ship it tomorrow #skribb !high")}`)).json();
  assert.equal(parsed.title, "ship it");
  assert.ok(parsed.bits.includes("#skribb"));
  assert.deepEqual(previewOf(parseQuick("x", TODAY), TODAY), { title: "x", bits: [] });

  const cross = await app.post("/tasks", { q: "from elsewhere" }, { origin: "https://evil.test" });
  assert.equal(cross.status, 403);
  const noOrigin = await app.post("/tasks", { q: "no origin" }, { origin: "" });
  assert.notEqual(noOrigin.status, 303, "a write must say it comes from this app");

  const add = await app.post("/tasks", { q: `${HOSTILE} #home`, back: "https://evil.test/" });
  assert.equal(add.status, 303);
  assert.equal(add.headers.get("location"), "/tasks", "back goes only to the pack's own pages");
  const empty = await app.post("/tasks", { q: "#home !high", back: "/tasks?area=home" });
  assert.equal(empty.headers.get("location"), "/tasks?area=home&e=title");

  const page = await (await app.get("/tasks")).text();
  assertInert("lists page", page);
  assert.match(page, /T-1/);
  const detail = await app.get("/tasks/1");
  assert.equal(detail.status, 301, "the id's own spelling");
  const t1 = await app.get("/tasks/T-1");
  assert.equal(t1.status, 200);
  assertInert("detail page", await t1.text());
  assert.equal((await app.get("/tasks/T-99")).status, 404);
  assert.equal((await app.get("/tasks/%3Cscript%3E")).status, 404);

  assert.equal((await app.post("/tasks/T-1/do", { op: "start", back: "/tasks" })).status, 303);
  assert.equal(pack.kept().find((t) => t.id === 1)?.status, "doing");
  await app.post("/tasks/T-1/edit", { title: "renamed", notes: `# hi\n\n${HOSTILE}`, due: "2026-12-01", scheduled: "not-a-date", edit: "1" });
  assert.equal(pack.kept()[0]?.title, "renamed");
  assert.equal(pack.kept()[0]?.due, "2026-12-01");
  assert.equal((await app.post("/tasks/T-1/links", { op: "add", ref: JS })).headers.get("location"), "/tasks/T-1?e=link");
  await app.post("/tasks/T-1/links", { op: "add", ref: "acme/shop#3", label: HOSTILE });
  await app.post("/tasks/T-1/comment", { text: HOSTILE });
  const full = await (await app.get("/tasks/T-1")).text();
  assertInert("detail page, filled in", full);
  assert.match(full, /acme\/shop\/issues\/3/);
  assert.equal((await app.get("/tasks/review")).status, 200);
  assertInert("review", await (await app.get("/tasks/review")).text());
  assert.equal((await app.get("/tasks/dock")).status, 200);
  const acts = (await app.db.DB.prepare("SELECT kind FROM actions WHERE kind LIKE 'tasks.%' ORDER BY id").all<{ kind: string }>()).results.map((r) => r.kind);
  assert.deepEqual(acts, ["tasks.create", "tasks.status", "tasks.edit", "tasks.edit", "tasks.comment"]);
});

test("routes: copy My list here in one click, logged; other packs' proposals show", async () => {
  const proposer = { manifest: { api: "1.6", id: "proposer", name: "Proposer", description: "x", domain: "work" as const }, slots: () => ({ "todo.proposals": () => html`<p class="t3">proposed ${HOSTILE}</p>` }) };
  const app = packApp([createTasksPack(), proposer]);
  await app.db.DB.prepare("INSERT INTO todo (parent, title, notes, state, due, pos, created_at, updated_at) VALUES (NULL, 'from my list', '', 'next', NULL, 1, 1, 1)").run();
  const page = await (await app.get("/tasks")).text();
  assert.match(page, /My list has 1 item/);
  assert.match(page, /proposed /);
  assertInert("lists with proposals", page);
  assert.equal((await app.post("/tasks/import", {})).status, 303);
  const after = await (await app.get("/tasks")).text();
  assert.doesNotMatch(after, /My list has/);
  assert.match(after, /from my list/);
  const log = (await app.db.DB.prepare("SELECT kind, detail FROM actions WHERE kind = 'tasks.import'").all<{ kind: string; detail: string }>()).results;
  assert.deepEqual(log.map((l) => ({ ...l })), [{ kind: "tasks.import", detail: "1 item" }]);
});
