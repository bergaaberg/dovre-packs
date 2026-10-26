/** Jira Pack (`jira`): filing tickets. Jira's create screen read live, a preview, a fresh check, one create, logged; through REST or the Atlassian MCP; hostile text stays text. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { html } from "hono/html";
import { recentActions } from "dovre/actions/deploys.ts";
import { openDb } from "dovre/db.ts";
import { testContext } from "dovre/packs/testing.ts";
import type { PackContext } from "dovre/packs/types.ts";
import { listTodos } from "dovre/todo/store.ts";
import { createJiraPack } from "../index.ts";
import { type Agent, CREATE, createInput, FIELDS, type RunOff, TYPES } from "../mcp.ts";
import { adf, readTicket, ticketFields, ticketPayload, validateTicket } from "../tickets.ts";

const SITE = "example.atlassian.net";
const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const inert = (out: string) => assert.ok(!out.includes("<script>") && !out.includes("<img") && !out.includes('href="javascript:'), out.slice(0, 300));
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";

// ── Jira's createmeta for DEV, as read 2026-10-22 (from the old Dovre's tests) ──
const STORY_FIELDS = [
  { fieldId: "assignee", name: "Assignee", required: false, schema: { type: "user", system: "assignee" } },
  { fieldId: "attachment", name: "Attachment", required: false, schema: { type: "array", items: "attachment", system: "attachment" } },
  { fieldId: "customfield_10473", name: "GitHub", required: false, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" } },
  { fieldId: "customfield_10475", name: "Dev tasks", required: false, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" } },
  {
    fieldId: "customfield_10476", name: "Område", required: true, hasDefaultValue: true, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
    allowedValues: [{ id: "10596", value: "Skade" }, { id: "10597", value: "Salg" }, { id: "10602", value: "Ikke valgt" }], defaultValue: { id: "10602", value: "Ikke valgt" },
  },
  { fieldId: "customfield_10477", name: "Estimat", required: false, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: [{ id: "10603", value: "XL" }, { id: "10606", value: "S" }] },
  { fieldId: "customfield_10478", name: "Prodsatt", required: false, schema: { type: "date", custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker" } },
  { fieldId: "customfield_10021", name: "Flagged", required: false, schema: { type: "array", items: "option", custom: "multicheckboxes" }, allowedValues: [{ id: "10019", value: "Impediment" }] },
  { fieldId: "description", name: "Description", required: false, schema: { type: "string", system: "description" } },
  { fieldId: "issuetype", name: "Issue Type", required: false, schema: { type: "issuetype", system: "issuetype" }, allowedValues: [{ id: "10255", name: "Story" }] },
  { fieldId: "priority", name: "Priority", required: false, hasDefaultValue: true, schema: { type: "priority", system: "priority" }, allowedValues: [{ id: "10000", name: "Critical" }, { id: "10006", name: "High " }, { id: "10008", name: "None" }], defaultValue: { id: "10008", name: "None" } },
  { fieldId: "project", name: "Project", required: true, schema: { type: "project", system: "project" } },
  { fieldId: "reporter", name: "Reporter", required: true, hasDefaultValue: true, schema: { type: "user", system: "reporter" } },
  { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
];
const DEV_TYPES = { issueTypes: [{ id: "10253", name: "Epic", description: "A collection" }, { id: "10254", name: "Deloppgave", subtask: true }, { id: "10255", name: "Story", description: "A user story" }] };

// ── A pack mounted on its own: its routes, a real database, a fake Jira ──

type Call = { method: string; path: string; body?: unknown; auth: string };
/** A fake fetch for Jira's REST API: "METHOD path" → an answer, or a function of the body (which may throw). */
function fakeRest(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (u: string | URL, init?: RequestInit) => {
    const url = new URL(String(u));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, auth: String((init?.headers as Record<string, string>)?.authorization ?? "") });
    const a = answers[`${method} ${url.pathname}${url.search}`];
    if (a === undefined) return new Response("not found", { status: 404 });
    try {
      return new Response(JSON.stringify(typeof a === "function" ? a(body) : a), { status: 200 });
    } catch (e) {
      return new Response(String((e as Error).message), { status: 400 });
    }
  }) as typeof fetch;
  return { fetchFn, calls };
}

const devRest = (extra: Record<string, unknown> = {}) => ({
  "GET /rest/api/3/issue/createmeta/DEV/issuetypes?maxResults=50": DEV_TYPES,
  "GET /rest/api/3/issue/createmeta/DEV/issuetypes/10255?maxResults=100": { fields: STORY_FIELDS },
  "GET /rest/api/3/issue/createmeta/DEV/issuetypes/10253?maxResults=100": { fields: [{ fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } }, { fieldId: "customfield_9", name: "Team", required: true, schema: { type: "user" } }] },
  ...extra,
});

function mounted(o: { env?: Record<string, string>; fetchFn?: typeof fetch; agent?: Agent; hosted?: boolean } = {}) {
  const db = openDb();
  const published: string[][] = [];
  const ctx: PackContext = testContext({
    env: { JIRA_SITE: SITE, TICKET_PROJECTS: "DEV", ...o.env },
    db: db.DB,
    hosted: o.hosted ?? false,
    publish: (t) => void published.push(t),
    page: async (c, p) => c.html(html`${p.head ?? ""}${p.body}`),
  });
  const pack = createJiraPack({ fetchFn: o.fetchFn, agent: o.agent, kept: { get: () => undefined, set: () => {} } });
  pack.init?.(ctx);
  const app = new Hono();
  pack.routes!(app as never, ctx);
  const get = (p: string) => app.request(`http://localhost${p}`);
  const post = (p: string, body: [string, string][] | Record<string, string>) => app.request(`http://localhost${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  return { pack, ctx, db, get, post, published };
}

const restOn = { JIRA_EMAIL: "me@example.com", JIRA_TOKEN: "t0k" };
const tick = () => new Promise((r) => setTimeout(r, 5));
/** Waits for the background work a page started (a create screen read, a create) to land. */
async function landed(get: (p: string) => Response | Promise<Response>, path: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const out = await (await get(path)).text();
    if (!out.includes("data-pending")) return out;
    await tick();
  }
  throw new Error(`${path} never landed`);
}

const hiddenOf = (page: string, action: string): [string, string][] => {
  const at = page.indexOf(`action="${action}"`);
  assert.ok(at >= 0, `no form posting to ${action}`);
  const form = page.slice(at, page.indexOf("</form>", at));
  const un = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return [...form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map((m) => [un(m[1]!), un(m[2]!)]);
};
const withMyList = (pairs: [string, string][]): [string, string][] => [...pairs, ["mylist", "1"]];

// ── The form, pure ──

test("tickets: createmeta → the form: summary, description, priority, the project's selects; sync-owned text, dates, users and links left out", () => {
  const { fields, blocked } = ticketFields(STORY_FIELDS as never);
  assert.deepEqual(fields.map((f) => [f.id, f.kind, f.required, f.default]), [
    ["summary", "line", true, undefined],
    ["description", "paragraph", false, undefined],
    ["priority", "select", false, "10008"],
    ["customfield_10476", "select", true, "10602"],
    ["customfield_10477", "select", false, undefined],
  ]);
  assert.deepEqual(fields[2]!.options.map((o) => o.label), ["Critical", "High", "None"], "labels trimmed");
  assert.deepEqual(blocked, [], "the reporter has a default; project and type are ours");
  assert.deepEqual(ticketFields([{ fieldId: "customfield_9", name: "Team", required: true, schema: { type: "user" } }] as never).blocked, ["Team"], "a required field the form can't fill blocks it");
  assert.deepEqual(ticketFields([{ fieldId: 'x"><b', name: "Evil", required: false, schema: { type: "option", custom: "c" }, allowedValues: [{ id: "1", value: "a" }] }] as never).fields, [], "an odd field id is never a form name");
});

test("tickets: plain text becomes Atlassian Document Format: blank lines split paragraphs, line breaks stay", () => {
  assert.deepEqual(adf("Første avsnitt\nlinje to\r\n\r\n\nAndre"), {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Første avsnitt" }, { type: "hardBreak" }, { type: "text", text: "linje to" }] },
      { type: "paragraph", content: [{ type: "text", text: "Andre" }] },
    ],
  });
  assert.deepEqual(adf("  ").content, []);
});

test("tickets: the payload: project and type by id, selects by option id, empty optional fields left to Jira", () => {
  const { fields } = ticketFields(STORY_FIELDS as never);
  const type = { id: "10255", name: "Story", description: "" };
  const t = readTicket("DEV", type, fields, { j_summary: "Se bilene\nmine", j_description: "Hvorfor", j_priority: "10006", j_customfield_10476: "10597", j_customfield_10477: "999" });
  assert.equal(t.values.summary, "Se bilene mine", "a summary is one line");
  assert.equal(t.values.customfield_10477, "", "an option the field doesn't offer is dropped");
  assert.deepEqual(ticketPayload(t, fields), {
    fields: { project: { key: "DEV" }, issuetype: { id: "10255" }, summary: "Se bilene mine", description: adf("Hvorfor"), priority: { id: "10006" }, customfield_10476: { id: "10597" } },
  });
  assert.equal(validateTicket(readTicket("DEV", type, fields, {}), fields).summary, "Required.");
  assert.equal(validateTicket(readTicket("DEV", type, fields, { j_summary: "x", j_customfield_10476: "" }), fields).customfield_10476, "Pick one.", "a required select left on None");
  const fromCard = readTicket("DEV", type, fields, { j_summary: "x" });
  for (const f of fields) if (f.default) assert.equal(fromCard.values[f.id], f.default, `a field not posted at all (Bino's card) takes Jira's default: ${f.name}`);
});

test("tickets: createInput puts the payload's fields onto createJiraIssue's arguments", () => {
  assert.deepEqual(createInput(SITE, { fields: { project: { key: "DEV" }, issuetype: { id: "1" }, summary: "s", priority: { id: "3" } } }, "Bug"), { cloudId: SITE, projectKey: "DEV", issueTypeName: "Bug", summary: "s", additional_fields: { priority: { id: "3" } } });
});

// ── Through REST ──

test("tickets (rest): the screen reads in the background; then the type's live fields, a preview, and Create files once, re-checked, logged, on My list", async () => {
  const rest = fakeRest(devRest({ "POST /rest/api/3/issue": { id: "1", key: "DEV-13" } }));
  const { get, post, db, published } = mounted({ env: restOn, fetchFn: rest.fetchFn });
  const first = await (await get("/jira/new")).text();
  assert.match(first, /data-pending/, "nothing kept yet: the page says it's reading, and fills in");
  assert.match(first, /<meta name="u-topics" content="jira">/);
  const form = await landed(get, "/jira/new?project=DEV&type=10255");
  assert.ok(published.some((t) => t.includes("jira")), "open pages hear when the screen lands");
  assert.match(form, />Story</);
  assert.ok(!form.includes("Deloppgave"), "sub-tasks need a parent: not offered");
  assert.match(form, /<option value="10602" selected>Ikke valgt<\/option>/, "Område starts on Jira's default");
  for (const gone of ["GitHub", "Dev tasks", "Prodsatt", "Flagged", "Assignee"]) assert.ok(!form.includes(`>${gone}`), gone);
  assert.equal(rest.calls[0]!.auth, `Basic ${Buffer.from("me@example.com:t0k").toString("base64")}`);

  const sent = { project: "DEV", type: "10255", j_summary: "Se bilene mine", j_description: "Kunden vil se bilene.", j_priority: "10006", j_customfield_10476: "10597", j_customfield_10477: "" };
  assert.equal((await post("/jira/new/preview", { ...sent, j_summary: "" })).status, 422);
  assert.equal((await post("/jira/new/preview", { project: "DEV", type: "nope", j_summary: "x" })).status, 400, "a type id that isn't one is refused");
  const preview = await (await post("/jira/new/preview", sent)).text();
  assert.match(preview, /<strong>Se bilene mine<\/strong>/);
  assert.match(preview, /<dt>Område<\/dt><dd>Salg<\/dd>/);
  assert.ok(!rest.calls.some((c) => c.method === "POST"), "the preview creates nothing");

  const res = await post("/jira/new/create", withMyList(hiddenOf(preview, "/jira/new/create")));
  assert.equal(res.status, 303);
  const job = res.headers.get("location")!;
  assert.match(job, /^\/jira\/new\/job\/[0-9a-f-]{36}$/, "Create goes at once to a page that fills itself in");
  const done = await landed(get, job);
  assert.match(done, /Created <a [^>]*href="https:\/\/example\.atlassian\.net\/browse\/DEV-13"/);
  const writes = rest.calls.filter((c) => c.method === "POST");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.body, { fields: { project: { key: "DEV" }, issuetype: { id: "10255" }, summary: "Se bilene mine", description: adf("Kunden vil se bilene."), priority: { id: "10006" }, customfield_10476: { id: "10597" } } });
  assert.equal(rest.calls.filter((c) => c.path.startsWith("/rest/api/3/issue/createmeta/DEV/issuetypes?")).length, 2, "the type is checked against Jira again right before the write");
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.kind, a.target, a.ok, a.detail]), [["ticket.create", "DEV-13", 1, "Story · Se bilene mine"]], "logged with type and summary, never the description");
  assert.deepEqual((await listTodos(db.DB)).map((t) => [t.title, t.notes]), [["Se bilene mine", "DEV-13 in Jira: https://example.atlassian.net/browse/DEV-13"]]);

  const twice = await post("/jira/new/create", hiddenOf(preview, "/jira/new/create"));
  assert.deepEqual([twice.status, twice.headers.get("location")], [303, job], "pressed twice: the same job");
  assert.equal(rest.calls.filter((c) => c.method === "POST").length, 1, "created once");
  assert.equal((await post("/jira/new/create", { ...sent, nonce: "x" })).status, 400, "Create only from the preview");
});

test("tickets (rest): a type with a required field the form can't fill says so; a type Jira stopped offering, or a failed create, files nothing and says why", async () => {
  const blocked = mounted({ env: restOn, fetchFn: fakeRest(devRest()).fetchFn });
  const blockedPage = await landed(blocked.get, "/jira/new?project=DEV&type=10253");
  assert.match(blockedPage, /Jira requires Team for a Epic/);
  assert.ok(!blockedPage.includes('action="/jira/new/preview"'));

  let types: unknown = DEV_TYPES;
  const rest = fakeRest(devRest({ "GET /rest/api/3/issue/createmeta/DEV/issuetypes?maxResults=50": () => types, "POST /rest/api/3/issue": () => { throw new Error("field Område is required"); } }));
  const { get, post, db } = mounted({ env: restOn, fetchFn: rest.fetchFn });
  await landed(get, "/jira/new");
  const sent = { project: "DEV", type: "10255", j_summary: "x", j_customfield_10476: "10597" };
  const preview = await (await post("/jira/new/preview", sent)).text();
  types = { issueTypes: [DEV_TYPES.issueTypes[0]!] };
  const refused = await landed(get, (await post("/jira/new/create", hiddenOf(preview, "/jira/new/create"))).headers.get("location")!);
  assert.match(refused, /no longer creates a Story: nothing was created/);
  assert.match(refused, /action="\/jira\/new\/create"/, "back on the preview, to try again");
  assert.ok(!rest.calls.some((c) => c.method === "POST"));
  assert.equal((await post("/jira/new/preview", sent)).status, 400, "what Jira said at the check is what the form knows now");
  assert.deepEqual(await recentActions(db.DB), [], "a refused check wrote nothing, so there's nothing to log");

  const failing = fakeRest(devRest({ "POST /rest/api/3/issue": () => { throw new Error("field Område is required"); } }));
  const f = mounted({ env: restOn, fetchFn: failing.fetchFn });
  await landed(f.get, "/jira/new");
  const again = await (await f.post("/jira/new/preview", sent)).text();
  const first = (await f.post("/jira/new/create", hiddenOf(again, "/jira/new/create"))).headers.get("location")!;
  const failed = await landed(f.get, first);
  assert.equal((await f.get(first)).status, 502);
  assert.match(failed, /Couldn(&#39;|')t create the ticket in DEV: .*field Område is required/);
  assert.deepEqual((await recentActions(f.db.DB)).map((a) => [a.kind, a.target, a.ok]), [["ticket.create", "DEV", 0]]);
  // Create again on the same preview: one that failed may be tried again.
  await landed(f.get, (await f.post("/jira/new/create", hiddenOf(again, "/jira/new/create"))).headers.get("location")!);
  assert.equal(failing.calls.filter((c) => c.method === "POST").length, 2);
});

test("tickets: only TICKET_PROJECTS; none set says how; a failed read says why and tries again; an unknown job is a 404", async () => {
  const { get, post } = mounted({ env: { ...restOn, TICKET_PROJECTS: "DEV, ops, x;DROP" }, fetchFn: fakeRest({}).fetchFn });
  assert.equal((await get("/jira/new?project=EVIL")).status, 400);
  assert.match(await (await get("/jira/new")).text(), /Which project\?.*href="\/jira\/new\?project=DEV".*href="\/jira\/new\?project=OPS"/s, "two projects: pick one");
  assert.equal((await post("/jira/new/preview", { project: "EVIL", j_summary: "x" })).status, 400);
  const failed = await landed(get, "/jira/new?project=DEV");
  assert.match(failed, /Jira.s work types for DEV didn.t load/);
  assert.match(failed, /href="\/jira\/new\?project=DEV"/);
  assert.equal((await get("/jira/new/job/00000000-0000-0000-0000-000000000000")).status, 404);
  const none = mounted({ env: { ...restOn, TICKET_PROJECTS: "" } });
  assert.match(await (await none.get("/jira/new")).text(), /Set <code>TICKET_PROJECTS<\/code>/);
});

test("tickets: hostile names and options from Jira, and hostile text typed in, stay text on the form, the preview and the job page", async () => {
  const evilTypes = { issueTypes: [{ id: "10255", name: H, description: H }] };
  const evilFields = { fields: [...STORY_FIELDS, { fieldId: "customfield_1", name: H, required: false, schema: { type: "option", custom: "c" }, allowedValues: [{ id: '1"><b', value: H }] }] };
  const rest = fakeRest({ "GET /rest/api/3/issue/createmeta/DEV/issuetypes?maxResults=50": evilTypes, "GET /rest/api/3/issue/createmeta/DEV/issuetypes/10255?maxResults=100": evilFields, "POST /rest/api/3/issue": { key: "DEV-1" } });
  const { get, post } = mounted({ env: restOn, fetchFn: rest.fetchFn });
  inert(await landed(get, "/jira/new?project=DEV"));
  const preview = await (await post("/jira/new/preview", { project: "DEV", type: "10255", j_summary: H, j_description: H, j_customfield_10476: "10597", j_customfield_1: '1"><b' })).text();
  inert(preview);
  const job = (await post("/jira/new/create", hiddenOf(preview, "/jira/new/create"))).headers.get("location")!;
  inert(await (await get(job)).text());
  inert(await landed(get, job));
});

test("tickets: an agent drafts it from a note, its prompt shown on /agents/new before anything starts", async () => {
  const { post } = mounted({ env: restOn });
  const res = await post("/jira/new/draft", { project: "DEV", note: "knapp" });
  assert.equal(res.status, 303);
  const prompt = new URL(res.headers.get("location")!, "http://localhost").searchParams.get("prompt")!;
  assert.match(prompt, /Jira ticket in project DEV on example\.atlassian\.net with the Atlassian MCP/);
  assert.match(prompt, /wait for my go before you create anything\.\n\nNote: knapp$/);
  assert.equal((await post("/jira/new/draft", { project: "EVIL", note: "x" })).status, 400);
  assert.equal((await post("/jira/new/draft", { project: "DEV", note: " " })).status, 400);
});

// ── Through Claude Code's Atlassian MCP ──

/** A stream as `claude -p --output-format stream-json` writes it. */
function stream(calls: { name: string; input: Record<string, unknown>; result: string }[]): string {
  const lines: unknown[] = [{ type: "system", subtype: "init", mcp_servers: [{ name: "atlassian", status: "connected" }], tools: [] }];
  calls.forEach((c, i) => {
    lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: c.input }] } });
    lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: c.result }] }] } });
  });
  lines.push({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, result: "done" });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function mcpJira(answerCreate: (input: Record<string, unknown>) => string) {
  const jobs: { args: string[]; prompt: string }[] = [];
  const typesIn = { cloudId: SITE, projectIdOrKey: "DEV" };
  const fieldsIn = { cloudId: SITE, projectIdOrKey: "DEV", issueTypeId: "10255", requiredFieldsOnly: false };
  const run: RunOff = async (_bin, args, o) => {
    const prompt = o.input ?? "";
    jobs.push({ args, prompt });
    if (argOf(args, "--allowedTools") === CREATE) {
      const input = JSON.parse(prompt.slice(prompt.indexOf("{")));
      return { code: 0, stdout: stream([{ name: CREATE, input, result: answerCreate(input) }]), stderr: "" };
    }
    return { code: 0, stdout: stream([{ name: TYPES, input: typesIn, result: JSON.stringify(DEV_TYPES) }, { name: FIELDS, input: fieldsIn, result: JSON.stringify({ fields: STORY_FIELDS }) }]), stderr: "" };
  };
  return { agent: { run, cwd: "x" } as Agent, jobs };
}

test("tickets (mcp): the create screen from one job, a preview, a fresh check, then one job allowed createJiraIssue only, with exactly the preview's fields", async () => {
  const { agent, jobs } = mcpJira(() => JSON.stringify({ key: "DEV-14", id: "1" }));
  const { get, post, db } = mounted({ env: { JIRA_VIA: "mcp" }, agent });
  const form = await landed(get, "/jira/new?project=DEV&type=10255");
  assert.match(form, />Story</);
  assert.match(form, /<option value="10602" selected>Ikke valgt<\/option>/);
  assert.equal(argOf(jobs[0]!.args, "--allowedTools"), `${TYPES},${FIELDS}`, "reading the screen may only read");
  const sent = { project: "DEV", type: "10255", j_summary: "Se bilene mine", j_description: "Kunden vil se bilene.", j_customfield_10476: "10597" };
  const preview = await (await post("/jira/new/preview", sent)).text();
  assert.ok(!jobs.some((j) => argOf(j.args, "--allowedTools").includes(CREATE)), "the preview creates nothing");
  const done = await landed(get, (await post("/jira/new/create", hiddenOf(preview, "/jira/new/create"))).headers.get("location")!);
  assert.match(done, /DEV-14/);
  const creates = jobs.filter((j) => argOf(j.args, "--allowedTools") === CREATE);
  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(creates[0]!.prompt.slice(creates[0]!.prompt.indexOf("{"))), {
    cloudId: SITE, projectKey: "DEV", issueTypeName: "Story", summary: "Se bilene mine",
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Kunden vil se bilene." }] }] }, contentFormat: "adf",
    additional_fields: { priority: { id: "10008" }, customfield_10476: { id: "10597" } },
  }, "a select the form didn't post goes as Jira's default");
  assert.equal(jobs.filter((j) => argOf(j.args, "--allowedTools") === `${TYPES},${FIELDS}`).length, 2, "the create screen, then a fresh check right before the write");
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.kind, a.target, a.ok]), [["ticket.create", "DEV-14", 1]]);
});

test("tickets (mcp): a create whose answer has no ticket key is a failure, logged, not a made-up key", async () => {
  const { agent } = mcpJira(() => JSON.stringify({ errorMessages: ["Område is required"] }));
  const { get, post, db } = mounted({ env: { JIRA_VIA: "mcp" }, agent });
  await landed(get, "/jira/new");
  const preview = await (await post("/jira/new/preview", { project: "DEV", type: "10255", j_summary: "x", j_customfield_10476: "10597" })).text();
  const out = await landed(get, (await post("/jira/new/create", hiddenOf(preview, "/jira/new/create"))).headers.get("location")!);
  assert.match(out, /no ticket key/);
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.kind, a.ok]), [["ticket.create", 0]]);
});

// ── Elsewhere in Dovre: New work, search, the actions log, Bino ──

test("tickets: New work lists where a ticket can go, search offers New ticket, the actions log names it; none of it without TICKET_PROJECTS", () => {
  const { pack, ctx } = mounted({ env: { ...restOn, TICKET_PROJECTS: "DEV,OPS" } });
  const slots = pack.slots!(ctx);
  const panel = String(slots["work.new"]!({}));
  assert.match(panel, /href="\/jira\/new\?project=DEV"/);
  assert.match(panel, /href="\/jira\/new\?project=OPS"/);
  assert.deepEqual(pack.finds!(ctx).filter((f) => f.kind === "actions").map((f) => [f.title, f.href]), [["New ticket in DEV", "/jira/new?project=DEV"], ["New ticket in OPS", "/jira/new?project=OPS"]]);
  assert.equal(slots["actions.what"]!({ kind: "ticket.create" }), "Created a Jira ticket");
  assert.equal(slots["actions.what"]!({ kind: "teams.send" }), undefined);
  assert.match(pack.bino!(ctx), /Jira tickets can be filed in DEV, OPS\./);
  assert.match("DEV-3 and OPS-4".match(pack.refs!(ctx)[0]!.pattern)!.join(" "), /DEV-3 OPS-4/, "ticket projects' keys are links");

  const none = mounted({ env: { ...restOn, TICKET_PROJECTS: "" } });
  assert.equal(String(none.pack.slots!(none.ctx)["work.new"]!({})), "");
  assert.deepEqual(none.pack.finds!(none.ctx), []);
  assert.deepEqual(none.pack.acts!(none.ctx), []);
});

test("tickets: Bino's card asks before it creates, files through the same checks with Jira's defaults, and says when the form is needed", async () => {
  const rest = fakeRest(devRest({ "POST /rest/api/3/issue": { key: "DEV-20" } }));
  const { pack, ctx, db } = mounted({ env: restOn, fetchFn: rest.fetchFn });
  const [act] = pack.acts!(ctx);
  assert.equal(act!.kind, "ticket");
  assert.ok(!act!.oneClick, "a write to Jira asks again first");
  assert.match(act!.when, /one of DEV/);
  const card = String(act!.inputs({ project: "dev", type: "story", summary: H, description: H }, undefined, ctx));
  inert(card);
  assert.match(card, /<option value="DEV" selected>DEV<\/option>/);

  const r = await act!.run({ project: "DEV", type: "story", summary: "Fra Bino", description: "Kort." }, {}, ctx);
  assert.deepEqual(r, { ok: true, done: "Created DEV-20", href: `https://${SITE}/browse/DEV-20` });
  assert.deepEqual(rest.calls.find((c) => c.method === "POST")!.body, {
    fields: { project: { key: "DEV" }, issuetype: { id: "10255" }, summary: "Fra Bino", description: adf("Kort."), priority: { id: "10008" }, customfield_10476: { id: "10602" } },
  }, "the type found by name; the rest on Jira's defaults");
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.kind, a.target, a.ok]), [["ticket.create", "DEV-20", 1]]);

  assert.deepEqual(await act!.run({ project: "EVIL", summary: "x" }, {}, ctx), { ok: false, error: "Tickets go to DEV." });
  const epic = await act!.run({ project: "DEV", type: "Epic", summary: "x" }, {}, ctx);
  assert.equal(epic.ok, false);
  assert.match((epic as { error: string }).error, /Jira requires Team for a Epic/);
  assert.equal(rest.calls.filter((c) => c.method === "POST").length, 1, "nothing more was created");
  assert.deepEqual(mounted({ env: restOn, hosted: true }).pack.acts!(mounted({ env: restOn, hosted: true }).ctx), [], "hosted, Bino proposes nothing");
});
