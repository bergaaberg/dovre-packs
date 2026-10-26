/** Jira Pack (`jira`) tests: REST with a token, or Claude Code's Atlassian MCP where tokens are locked down. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Kept } from "dovre/issues/templates.ts";
import { testContext } from "dovre/packs/testing.ts";
import { viaOf } from "../data.ts";
import { createJiraPack } from "../index.ts";
import { agentArgs, type Agent, readStream, type RunOff, SEARCH, searches, WRITES } from "../mcp.ts";
import { jiraPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const SITE = "acme.atlassian.net";
const inert = (out: string) => assert.ok(!out.includes("<script>") && !out.includes("<img") && !out.includes('href="javascript:'), out.slice(0, 300));
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";

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

/** A stream as `claude -p --output-format stream-json` writes it: init, the calls and their results, the result. */
function stream(o: { mcp?: string; calls?: { name: string; input: Record<string, unknown>; result: string; error?: boolean }[]; cost?: number }): string {
  const lines: unknown[] = [{ type: "system", subtype: "init", mcp_servers: [{ name: "atlassian", status: o.mcp ?? "connected", source: "dynamic" }], tools: [] }];
  (o.calls ?? []).forEach((c, i) => {
    lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: c.input }] } });
    lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: c.result }], is_error: c.error ?? false }] } });
  });
  lines.push({ type: "result", subtype: "success", is_error: false, total_cost_usd: o.cost ?? 0.004, result: "done" });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json at all\n";
}

/** A fake runOff that answers each job, and remembers every one. */
function fakeAgent(answer: (prompt: string) => string | Error): { agent: Agent; jobs: { args: string[]; prompt: string }[] } {
  const jobs: { args: string[]; prompt: string }[] = [];
  const run: RunOff = async (_bin, args, opts) => {
    jobs.push({ args, prompt: opts.input ?? "" });
    const a = answer(opts.input ?? "");
    if (a instanceof Error) throw a;
    return { code: 0, stdout: a, stderr: "" };
  };
  return { agent: { run, cwd: "x" }, jobs };
}

const node = (key: string, f: Record<string, unknown> = {}) => ({
  key,
  webUrl: "javascript:alert(1)",
  fields: { summary: `Summary of ${key}`, status: { name: "I arbeid", statusCategory: { key: "indeterminate" } }, issuetype: { name: "Story" }, assignee: { displayName: "Kari" }, updated: "2026-10-22T06:00:00.000+0200", ...f },
});
const found = (...nodes: unknown[]) => JSON.stringify({ issues: { nodes, pageInfo: {} } });
const memory = (): Kept & { all: Record<string, { at: number; value: unknown }> } => {
  const all: Record<string, { at: number; value: unknown }> = {};
  return { all, get: (k) => all[k], set: (k, v) => void (all[k] = v) };
};
const mcpEnv = { JIRA_SITE: SITE, JIRA_VIA: "mcp", JIRA_PROJECTS: "JSD,FS,x;DROP" };

test("jira (mcp): a read may call the search only; nothing built in; only the Atlassian MCP; every write tool denied", () => {
  const args = agentArgs([SEARCH]);
  assert.equal(argOf(args, "--allowedTools"), SEARCH);
  assert.equal(argOf(args, "--tools"), "", "no Bash, no files, no web");
  assert.equal(argOf(args, "--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence") && args.includes("--disable-slash-commands"));
  assert.deepEqual(Object.keys(JSON.parse(argOf(args, "--mcp-config")).mcpServers), ["atlassian"]);
  assert.deepEqual(argOf(args, "--disallowedTools").split(","), WRITES);
  assert.equal(argOf(args, "--model"), "haiku");
});

test("jira (mcp): both searches in one job; the pack keeps what the tools returned, checked field by field, never the model's words", async () => {
  const q = searches(SITE, ["JSD", "FS", "x;DROP"]);
  assert.match(q.moving!.jql, /^project in \(JSD,FS\) /, "only project keys reach the JQL");
  const { agent, jobs } = fakeAgent(() =>
    stream({
      calls: [
        { name: SEARCH, input: q.mine, result: found(node("DEV-4"), node("<script>-1"), { key: "DEV-5" }, node("DEV-6", { summary: H, status: { name: H, statusCategory: { key: "javascript:" } } })) },
        { name: SEARCH, input: q.moving!, result: found(node("JSD-10", { issuetype: undefined, assignee: undefined })) },
      ],
    }),
  );
  const kept = memory();
  const pack = createJiraPack({ agent, kept });
  const ctx = testContext({ env: mcpEnv });
  pack.init!(ctx);
  assert.equal(pack.kept()!.setup, "waiting", "before the first answer: asking");
  await pack.refresh!(ctx);
  assert.equal(jobs.length, 1, "one job for both");
  const k = pack.kept()!;
  assert.deepEqual(k.mine.map((i) => i.key), ["DEV-4", "DEV-6"], "no key, or no summary: dropped");
  assert.equal(k.mine[1]!.category, "new", "an unknown status category isn't passed on");
  assert.equal(k.mine[0]!.url, `https://${SITE}/browse/DEV-4`, "the link is built here, not taken from the result");
  assert.deepEqual([k.moving[0]!.type, k.moving[0]!.assignee], ["", null]);
  assert.ok(kept.all.jira, "kept for the next start");
  inert(String(await jiraPage(k)));
});

test("jira (mcp): a changed call, a result that didn't come back whole, or junk is a failure, not empty", async () => {
  const q = searches(SITE, []);
  for (const result of [
    stream({ calls: [{ name: SEARCH, input: { ...q.mine, jql: "project = HR" }, result: found(node("HR-1")) }] }),
    stream({ calls: [{ name: SEARCH, input: q.mine, result: "<persisted-output>\nOutput too large (99.3KB)." }] }),
    stream({ calls: [{ name: SEARCH, input: q.mine, result: '{"error":"x"}', error: true }] }),
  ]) {
    const pack = createJiraPack({ agent: fakeAgent(() => result).agent, kept: memory() });
    const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" } });
    pack.init!(ctx);
    await pack.refresh!(ctx);
    assert.deepEqual([pack.kept()!.ok, pack.kept()!.mine.length], [false, 0]);
    assert.match(pack.kept()!.error!, /searchJiraIssuesUsingJql|Output too large/);
  }
  assert.deepEqual(readStream("garbage\n{]\n").calls, []);
});

test("jira (mcp): not signed in, or no Claude Code, says how to fix it", async () => {
  const cases = [
    { answer: () => stream({ mcp: "needs-auth" }), setup: "sign-in", says: /type <code>\/mcp<\/code>, pick <strong>atlassian<\/strong>/ },
    { answer: () => new Error("spawn claude ENOENT"), setup: "no-claude", says: /Claude Code isn't installed|isn.t installed/ },
  ];
  for (const c of cases) {
    const pack = createJiraPack({ agent: fakeAgent(c.answer).agent, kept: memory() });
    const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" } });
    pack.init!(ctx);
    await pack.refresh!(ctx);
    assert.equal(pack.kept()!.setup, c.setup);
    assert.match(String(await jiraPage(pack.kept())), c.says);
  }
  const waiting = createJiraPack({ kept: memory() });
  waiting.init!(testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" } }));
  assert.match(String(await jiraPage(waiting.kept())), /fills in by itself/);
});

test("jira (mcp): once per JIRA_EVERY_MIN, at once on Read now, the last good answer kept when a job fails, and kept across a restart", async () => {
  const clock = { t: 1_000_000 };
  let fail = false;
  const q = searches(SITE, []);
  const { agent, jobs } = fakeAgent(() => (fail ? stream({ mcp: "failed" }) : stream({ calls: [{ name: SEARCH, input: q.mine, result: found(node(`DEV-${jobs.length}`)) }] })));
  const kept = memory();
  const env = { JIRA_SITE: SITE, JIRA_VIA: "mcp", JIRA_EVERY_MIN: "10" };
  const pack = createJiraPack({ agent, kept, now: () => clock.t });
  const ctx = testContext({ env });
  pack.init!(ctx);
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
  const again = createJiraPack({ agent, kept, now: () => clock.t });
  again.init!(testContext({ env }));
  assert.deepEqual([again.kept()!.ok, again.kept()!.mine[0]!.key], [true, "DEV-1"]);
  // Another site's answer isn't drawn.
  const other = createJiraPack({ agent, kept, now: () => clock.t });
  other.init!(testContext({ env: { ...env, JIRA_SITE: "other.atlassian.net" } }));
  assert.equal(other.kept()!.setup, "waiting");
});

test("jira (mcp): Read now asks at once, past the cadence, and goes back to the page", async () => {
  const { Hono } = await import("hono");
  const q = searches(SITE, []);
  const { agent, jobs } = fakeAgent(() => stream({ calls: [{ name: SEARCH, input: q.mine, result: found(node("DEV-1")) }] }));
  const pack = createJiraPack({ agent, kept: memory() });
  const ctx = testContext({ env: { JIRA_SITE: SITE, JIRA_VIA: "mcp" } });
  pack.init!(ctx);
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
