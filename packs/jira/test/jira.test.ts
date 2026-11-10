/** Jira Pack (`jira`) tests: REST with a token, or Claude Code's Atlassian MCP where tokens are locked down. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/pack-testing.ts";
import { viaOf } from "../data.ts";
import { createJiraPack } from "../index.ts";
import { CREATE, FIELDS, MCP_ASK, SEARCH, searches, TYPES } from "../mcp.ts";
import { fakeMcp, setupError } from "./fakemcp.ts";
import { Pill } from "dovre/pack.ts";
import { jiraPage, tone } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const SITE = "acme.atlassian.net";
const inert = (out: string) => assert.ok(!out.includes("<script>") && !out.includes("<img") && !out.includes('href="javascript:'), out.slice(0, 300));

// ── REST ──

test("jira (rest): mine and what moved in my projects; keys link only in those projects; hostile summaries escaped", async () => {
  const urls: string[] = [];
  const pack = createJiraPack({
    fetchFn: async (u) => {
      urls.push(String(u));
      const moving = /project%20in/.test(String(u));
      return new Response(
        JSON.stringify({
          issues: moving
            ? [{ key: "OPS-7", fields: { summary: "Disk full", status: { name: "Open", statusCategory: { key: "new" } }, assignee: { displayName: "Kari" } } }]
            : [
                { key: "PLAT-42", fields: { summary: "Add D1 migration check", status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, priority: { name: "High" } } },
                { key: "PLAT-43", fields: { summary: H, status: { name: H } } },
                { key: "not a key", fields: { summary: "dropped" } },
              ],
        }),
        { status: 200 },
      );
    },
  });
  const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_TOKEN: "tok", JIRA_PROJECTS: "OPS, x;DROP" } });
  assert.equal(pack.available!(ctx), true);
  await pack.refresh!(ctx);
  const k = pack.kept()!;
  assert.deepEqual([k.ok, k.via, k.mine.map((i) => i.key), k.moving.map((i) => i.key)], [true, "rest", ["PLAT-42", "PLAT-43"], ["OPS-7"]]);
  assert.ok(urls.some((u) => decodeURIComponent(u).includes("project in (OPS) ")), "only project keys reach the JQL");
  const [rule] = pack.refs!(ctx);
  assert.equal(rule!.href("PLAT-42"), `https://${SITE}/browse/PLAT-42`);
  assert.deepEqual("OPS-7, PLAT-42 and HR-1".match(rule!.pattern), ["OPS-7", "PLAT-42"], "keys outside my projects stay text");
  assert.equal(pack.finds!(ctx).length, 3);
  assert.match(pack.bino!(ctx), /PLAT-42 \[In Progress\]/);
  assert.match(pack.bino!(ctx), /1 moved in OPS/);
  inert(String(await jiraPage(k)));
});

test("jira: which way, and when it's on", () => {
  const pack = createJiraPack();
  const on = (env: Record<string, string>, hosted = false) => pack.available!(testContext({ env, hosted }));
  assert.equal(viaOf({}), "off");
  assert.equal(viaOf({ JIRA_TOKEN: "t" }), "rest", "a token means REST");
  assert.equal(viaOf({ JIRA_VIA: "MCP" }), "mcp");
  assert.equal(on({ JIRA_SITE: SITE }), false, "no token, no way: off");
  assert.equal(on({ JIRA_SITE: SITE, JIRA_VIA: "mcp" }), true, "the MCP needs no token");
  assert.equal(on({ JIRA_SITE: SITE, JIRA_VIA: "mcp" }, true), false, "the MCP is local only");
  assert.equal(on({ JIRA_SITE: SITE, JIRA_TOKEN: "t", JIRA_VIA: "off" }), false);
  assert.equal(on({ JIRA_SITE: "not a host", JIRA_VIA: "mcp" }), false);
});

// ── Through Claude Code's Atlassian MCP ──

const node = (key: string, f: Record<string, unknown> = {}) => ({
  key,
  webUrl: "javascript:alert(1)",
  fields: { summary: `Summary of ${key}`, status: { name: "I arbeid", statusCategory: { key: "indeterminate" } }, issuetype: { name: "Story" }, assignee: { displayName: "Kari" }, updated: "2026-10-22T06:00:00.000+0200", ...f },
});
const found = (...nodes: unknown[]) => JSON.stringify({ issues: { nodes, pageInfo: {} } });
const mcpEnv = { JIRA_SITE: SITE, JIRA_VIA: "mcp", JIRA_PROJECTS: "JSD,FS,x;DROP" };

test("jira (mcp): the manifest asks for the Atlassian MCP only, three tools that read, and the create under its write kind", () => {
  const pack = createJiraPack();
  assert.deepEqual(pack.manifest.ai, { mcp: MCP_ASK });
  assert.deepEqual([MCP_ASK.server.name, MCP_ASK.reads, MCP_ASK.writes], ["atlassian", [SEARCH, TYPES, FIELDS], { [CREATE]: "ticket-create" }]);
  assert.ok(pack.writes!.some((w) => w.kind === "ticket-create"), "the kind is one of its writes, or core leaves the tool out");
});

test("jira (mcp): both searches in one job; the pack keeps what the tools returned, checked field by field, never the model's words", async () => {
  const q = searches(SITE, ["JSD", "FS", "x;DROP"]);
  assert.match(q.moving!.jql, /^project in \(JSD,FS\) /, "only project keys reach the JQL");
  const { mcp, jobs } = fakeMcp(() => [
    { tool: SEARCH, input: q.mine, result: found(node("DEV-4"), node("<script>-1"), { key: "DEV-5" }, node("DEV-6", { summary: H, status: { name: H, statusCategory: { key: "javascript:" } } })) },
    { tool: SEARCH, input: q.moving!, result: found(node("JSD-10", { issuetype: undefined, assignee: undefined })) },
  ]);
  const pack = createJiraPack();
  const ctx = testContext({ env: mcpEnv, mcp });
  await pack.init!(ctx);
  assert.equal(pack.kept()!.setup, "waiting", "before the first answer: asking");
  await pack.refresh!(ctx);
  assert.equal(jobs.length, 1, "one job for both");
  assert.deepEqual(jobs[0], { write: false, calls: [{ tool: SEARCH, input: q.mine }, { tool: SEARCH, input: q.moving! }] }, "exactly the two searches");
  const k = pack.kept()!;
  assert.deepEqual(k.mine.map((i) => i.key), ["DEV-4", "DEV-6"], "no key, or no summary: dropped");
  assert.equal(k.mine[1]!.category, "new", "an unknown status category isn't passed on");
  assert.equal(k.mine[0]!.url, `https://${SITE}/browse/DEV-4`, "the link is built here, not taken from the result");
  assert.deepEqual([k.moving[0]!.type, k.moving[0]!.assignee], ["", null]);
  assert.equal((await ctx.store.kv.get<{ ok: boolean }>("last"))?.ok, true, "kept for the next start");
  inert(String(await jiraPage(k)));
});

test("jira (mcp): a changed call, a result that didn't come back whole, or junk is a failure, not empty", async () => {
  const q = searches(SITE, []);
  for (const result of [
    [{ tool: SEARCH, input: { ...q.mine, jql: "project = HR" }, result: found(node("HR-1")) }],
    [{ tool: SEARCH, input: q.mine, result: "<persisted-output>\nOutput too large (99.3KB)." }],
    [{ tool: SEARCH, input: q.mine, result: '{"error":"x"}', error: true }],
    [],
  ]) {
    const pack = createJiraPack();
    const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" }, mcp: fakeMcp(() => result).mcp });
    await pack.init!(ctx);
    await pack.refresh!(ctx);
    assert.deepEqual([pack.kept()!.ok, pack.kept()!.mine.length], [false, 0]);
    assert.match(pack.kept()!.error!, /searchJiraIssuesUsingJql|Output too large/);
  }
});

test("jira (mcp): not allowed yet, not signed in, or no Claude Code, says how to fix it", async () => {
  const cases = [
    { mcp: fakeMcp(() => setupError("sign-in", "Claude Code's atlassian MCP is needs-auth.")).mcp, setup: "sign-in", says: /type <code>\/mcp<\/code>, pick <strong>atlassian<\/strong>/ },
    { mcp: fakeMcp(() => setupError("no-claude", "Claude Code isn't installed here.")).mcp, setup: "no-claude", says: /Claude Code isn't installed|isn.t installed/ },
    { mcp: fakeMcp(() => [], { allowed: false }).mcp, setup: "allow", says: /href="\/settings\/packs\/jira#ai"/ },
  ];
  for (const c of cases) {
    const pack = createJiraPack();
    const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" }, mcp: c.mcp });
    await pack.init!(ctx);
    await pack.refresh!(ctx);
    assert.equal(pack.kept()!.setup, c.setup);
    assert.match(String(await jiraPage(pack.kept())), c.says);
  }
  const waiting = createJiraPack();
  await waiting.init!(testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" } }));
  assert.match(String(await jiraPage(waiting.kept())), /fills in by itself/);
});

test("jira (mcp): once per JIRA_EVERY_MIN, at once on Read now, the last good answer kept when a job fails, and kept across a restart", async () => {
  const clock = { t: 1_000_000 };
  let fail = false;
  const q = searches(SITE, []);
  const { mcp, jobs } = fakeMcp(() => (fail ? new Error("no answer (exit 1)") : [{ tool: SEARCH, input: q.mine, result: found(node(`DEV-${jobs.length}`)) }]));
  const env = { JIRA_SITE: SITE, JIRA_VIA: "mcp", JIRA_EVERY_MIN: "10" };
  const pack = createJiraPack({ now: () => clock.t });
  const ctx = testContext({ env, mcp });
  const { store } = ctx;
  await pack.init!(ctx);
  await pack.refresh!(ctx);
  clock.t += 60_000;
  await pack.refresh!(ctx);
  assert.equal(jobs.length, 1, "a minute later: nothing");
  clock.t += 600_000;
  fail = true;
  await pack.refresh!(ctx);
  assert.equal(jobs.length, 2);
  assert.deepEqual([pack.kept()!.ok, pack.kept()!.mine[0]!.key], [true, "DEV-1"], "the last good answer stays");
  clock.t += 60_000;
  await pack.refresh!(ctx);
  assert.equal(jobs.length, 2, "a failure doesn't make it ask every round");

  // A restart draws the kept answer at once, before any job.
  const again = createJiraPack({ now: () => clock.t });
  await again.init!(testContext({ env, store, mcp }));
  assert.deepEqual([again.kept()!.ok, again.kept()!.mine[0]!.key], [true, "DEV-1"]);
  // Another site's answer isn't drawn.
  const other = createJiraPack({ now: () => clock.t });
  await other.init!(testContext({ env: { ...env, JIRA_SITE: "other.atlassian.net" }, store, mcp }));
  assert.equal(other.kept()!.setup, "waiting");
});

test("jira (mcp): Read now asks at once, past the cadence, and goes back to the page", async () => {
  const { Hono } = await import("hono");
  const q = searches(SITE, []);
  const { mcp, jobs } = fakeMcp(() => [{ tool: SEARCH, input: q.mine, result: found(node("DEV-1")) }]);
  const pack = createJiraPack();
  const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" }, mcp });
  await pack.init!(ctx);
  await pack.refresh!(ctx);
  await pack.refresh!(ctx);
  assert.equal(jobs.length, 1);
  const app = new Hono();
  pack.routes!(app as never, ctx);
  const res = await app.request("/jira/refresh", { method: "POST" });
  assert.deepEqual([res.status, res.headers.get("location")], [303, "/jira"]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(jobs.length, 2);
});

// ── PR pills ──

/** A pack that has read PLAT-42 (in progress) and PLAT-50 (done). */
async function packWithTickets() {
  const issue = (key: string, summary: string, status: string, category: string) => ({ key, fields: { summary, status: { name: status, statusCategory: { key: category } } } });
  const pack = createJiraPack({
    fetchFn: async () =>
      new Response(JSON.stringify({ issues: [issue("PLAT-42", "Add D1 migration check", "In Progress", "indeterminate"), issue("PLAT-50", "Ship it", "Done", "done")] }), { status: 200 }),
  });
  const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_TOKEN: "tok" } });
  const sl = pack.slots!(ctx);
  const pr = (branch: string, title: string) => ({ repo: "shop-api", number: 7, branch, title, url: "https://ghe/shop-api/pull/7" });
  return {
    pack,
    ctx,
    lead: (branch: string, title = "x") => String(sl["pr.lead"]!(pr(branch, title))),
    facts: (branch: string, title = "x") => sl["pr.facts"]!(pr(branch, title)),
  };
}

test("jira pr slots: a lower-case key in the branch gets a pill and a Jira row", async () => {
  const { pack, ctx, lead, facts } = await packWithTickets();
  await pack.refresh!(ctx);
  assert.match(lead("feature/plat-42-migration"), /PLAT-42 In Progress/);
  assert.match(lead("feature/plat-42-migration"), /Add D1 migration check/, "the summary is the title");
  const [[label, link]] = facts("feature/plat-42-migration");
  assert.equal(label, "Jira");
  assert.match(String(link), new RegExp(`${pack.refs!(ctx)[0]!.href("PLAT-42")}`));
  assert.match(String(link), /PLAT-42 Add D1 migration check/);
});

test("jira pr slots: a key after an underscore is found", async () => {
  const { pack, ctx, lead } = await packWithTickets();
  await pack.refresh!(ctx);
  assert.match(lead("bugfix_PLAT-42"), /PLAT-42/);
  assert.match(lead("user_plat-42-foo"), /PLAT-42/);
});

test("jira pr slots: a key in the title", async () => {
  const { pack, ctx, lead } = await packWithTickets();
  await pack.refresh!(ctx);
  assert.match(lead("main", "PLAT-42: check migrations"), /PLAT-42/);
});

test("jira pr slots: the pill is toned as the ticket's status is", async () => {
  const { pack, ctx, lead } = await packWithTickets();
  await pack.refresh!(ctx);
  const [open, done] = pack.kept()!.mine;
  const pill = (i: typeof open) => String(Pill({ tone: tone(i!), children: `${i!.key} ${i!.status}`, title: i!.summary }));
  assert.equal(lead("plat-42").trim(), pill(open).trim());
  assert.equal(lead("plat-50").trim(), pill(done).trim());
  assert.notEqual(tone(open!), tone(done!), "the two statuses are toned differently");
});

test("jira pr slots: a ticket the pack doesn't keep, or a key inside a word, draws nothing", async () => {
  const { pack, ctx, lead, facts } = await packWithTickets();
  await pack.refresh!(ctx);
  assert.equal(lead("feature/plat-99-other", "other"), "");
  assert.deepEqual(facts("feature/plat-99-other", "other"), []);
  assert.equal(lead("feature/xplat-42"), "", "not the key by itself");
});

test("jira pr slots: no data yet draws nothing", async () => {
  const { lead, facts } = await packWithTickets();
  assert.equal(lead("feature/plat-42-migration"), "");
  assert.deepEqual(facts("feature/plat-42-migration"), []);
});

// ── Bino lookups ──

test("jira (rest): lookups read one issue (rich text as plain text, cut) and search summaries; JQL can't be rewritten; none without REST", async () => {
  const urls: string[] = [];
  const pack = createJiraPack({
    fetchFn: async (u) => {
      const url = String(u);
      urls.push(url);
      if (url.includes("/issue/PLAT-404")) return new Response("{}", { status: 404 });
      if (url.includes("/issue/")) {
        const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }, { type: "mention", attrs: { text: "@Kari" } }, { type: "inlineCard", attrs: { url: "https://secret.example/x" } }] }] });
        return Response.json({
          key: "PLAT-42",
          fields: {
            summary: "Add D1 migration check",
            description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Long ${"x".repeat(3000)}` }] }] },
            status: { name: "In Progress" },
            issuetype: { name: "Task" },
            priority: { name: "High" },
            assignee: { displayName: "Ola" },
            labels: ["d1"],
            comment: { comments: [{ author: { displayName: "Kari" }, created: "2026-11-09T10:00:00.000+0100", body: doc("Ping ") }] },
          },
        });
      }
      return Response.json({ issues: [{ key: "PLAT-7", fields: { summary: "Certs renew", status: { name: "To Do" }, assignee: null } }, { key: "bad key", fields: {} }] });
    },
  });
  assert.deepEqual(pack.lookups!(testContext({ env: { JIRA_SITE: SITE } })), [], "no token, no lookups");
  assert.deepEqual(pack.lookups!(testContext({ env: { JIRA_SITE: SITE, JIRA_TOKEN: "t", JIRA_VIA: "mcp" } })), [], "not through the MCP");
  const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_TOKEN: "tok" } });
  const [issue, search] = pack.lookups!(ctx);
  assert.deepEqual([issue!.kind, search!.kind], ["issue", "search"]);
  const text = await issue!.run({ key: "plat-42" }, ctx);
  assert.match(text, /^PLAT-42: Add D1 migration check/);
  assert.match(text, /Status: In Progress, type: Task, priority: High, assignee: Ola, labels: d1\./);
  assert.match(text, /- Kari \(2026-11-09\): Ping @Kari/);
  assert.ok(!text.includes("secret.example"), "links in rich text aren't handed over");
  assert.ok(text.length < 2600, "the description is cut");
  assert.ok(urls[0]!.startsWith(`https://${SITE}/rest/api/3/issue/PLAT-42?`));
  // Not a key: Jira isn't asked.
  assert.match(await issue!.run({ key: "PLAT-1 OR 1=1" }, ctx), /isn't an issue key/);
  assert.equal(urls.length, 1);
  assert.match(await issue!.run({ key: "PLAT-404" }, ctx), /no issue PLAT-404/);
  assert.equal(await search!.run({ q: 'certs" OR project = SECRET' }, ctx), 'Issues with "certs OR project SECRET" in the summary:\n- PLAT-7 [To Do] Certs renew');
  const jql = decodeURIComponent(new URL(urls.at(-1)!).searchParams.get("jql")!);
  assert.equal(jql, 'summary ~ "certs OR project SECRET" ORDER BY updated DESC', "the words stay inside one quoted string");
  assert.match(await search!.run({ q: "!!" }, ctx), /at least two/);
});
