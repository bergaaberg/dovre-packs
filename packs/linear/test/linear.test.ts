/** Linear Pack (`linear`) tests: a fake Linear answers the GraphQL calls. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import type { PackContext } from "dovre/packs/types.ts";
import type { D1 } from "dovre/db.ts";
import type { Snapshot } from "dovre/gather.ts";
import { createLinearPack } from "../index.ts";
import { linearCard, linearPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const JS = "javascript:alert(1)";

/** A fake Linear: answers by the query's own words, records calls and headers. */
function fakeLinear(routes: { match: RegExp; body: unknown }[] = []) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers, body: JSON.parse(String(init?.body ?? "{}")) });
    const route = routes.find((r) => r.match.test(query));
    if (!route) return new Response(JSON.stringify({ errors: [{ message: `no route for ${query.slice(0, 40)}` }] }), { status: 200 });
    return new Response(JSON.stringify({ data: route.body }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const ISSUE = (key: string, title: string, over: Record<string, unknown> = {}) => ({
  identifier: key,
  title,
  url: `https://linear.app/issue/${key}`,
  priority: 2,
  updatedAt: "2026-10-24T10:00:00Z",
  team: { key: key.split("-")[0] },
  state: { name: "In Progress", type: "started" },
  project: { name: "Payments" },
  cycle: { number: 42 },
  ...over,
});

const READ = {
  viewer: { name: "Kari Nordmann" },
  issues: { nodes: [ISSUE("ENG-7", "Ship the pack"), ISSUE("OPS-3", H, { state: { name: H, type: "started" }, url: JS, project: { name: H } })] },
  teams: {
    nodes: [
      {
        key: "ENG",
        name: "Engineering",
        activeCycle: { number: 42, startsAt: "2026-10-20T00:00:00Z", endsAt: "2026-10-27T00:00:00Z", progress: 60, issueCount: 10, completedIssueCount: 6 },
        issues: { nodes: [ISSUE("ENG-9", "Broken login")] },
      },
      { key: "OPS", name: "Ops" },
    ],
  },
};

/** A fake D1 that records what logAction inserted. */
function fakeDb() {
  const inserts: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => ({
          run: async () => {
            inserts.push({ sql, binds });
          },
          all: async () => ({ results: [] }),
        }),
        all: async () => ({ results: [] }),
      };
    },
  } as unknown as D1;
  return { db, inserts };
}

/** A snapshot whose one PR names an issue in its branch. */
function snapshotWithPr(branch: string, title = "A change"): Snapshot {
  return {
    at: Date.now(),
    prs: { ok: true, value: { mine: [{ repo: "shop", number: 1, title, branch, url: "https://example.com/1", updatedAt: "", author: "kari", review: null, checks: "NONE" }], review: [] } },
  } as unknown as Snapshot;
}

test("linear: reads assigned issues, cycles and un-triaged; hostile titles and urls come out inert", async () => {
  const { fetchFn, calls } = fakeLinear([{ match: /viewer/, body: READ }]);
  const pack = createLinearPack({ fetchFn });
  const ctx = testContext({ env: { LINEAR_API_KEY: "lin_api_test" } });
  await pack.refresh!(ctx);
  const kept = pack.kept()!;
  assert.ok(kept.ok);
  assert.equal(kept.mine.length, 2);
  assert.equal(kept.teams.length, 2);
  assert.equal(kept.teams[0]!.untriaged.length, 1);
  assert.equal(kept.teams[0]!.cycle!.completed, 6);
  // The key goes in the Authorization header, and only ever to api.linear.app.
  assert.equal(calls[0]!.url, "https://api.linear.app/graphql");
  assert.equal(calls[0]!.headers.authorization, "lin_api_test");
  // Refs link both teams' keys.
  const refs = pack.refs!(ctx);
  assert.equal(refs[0]!.href("ENG-7"), "https://linear.app/issue/ENG-7");
  // Page and card escape the hostile title, state and project, and make the hostile url inert.
  for (const out of [String(await linearPage(kept)), String(linearCard(kept))]) {
    assert.ok(!out.includes("<script>"), "script escaped");
    assert.ok(!out.includes("<img"), "img escaped");
    assert.ok(!out.includes('href="javascript:'), "javascript: inert");
  }
});

test("linear: without a key it says so, and a bad token says that too", async () => {
  const pack = createLinearPack();
  await pack.refresh!(testContext({ env: {} }));
  assert.ok(!pack.kept()!.ok);
  assert.match(pack.kept()!.error!, /LINEAR_API_KEY/);
  const { fetchFn } = fakeLinear([]);
  const failing = createLinearPack({ fetchFn: (async () => new Response("nope", { status: 401 })) as typeof fetch });
  await failing.refresh!(testContext({ env: { LINEAR_API_KEY: "bad" } }));
  assert.ok(!failing.kept()!.ok);
  assert.match(failing.kept()!.error!, /401/);
  assert.match(String(await linearPage(failing.kept())), /401/);
});
test("linear: LINEAR_TEAM narrows teams to one; refs still link its keys", async () => {
  const { fetchFn } = fakeLinear([{ match: /viewer/, body: READ }]);
  const pack = createLinearPack({ fetchFn });
  const ctx = testContext({ env: { LINEAR_API_KEY: "k", LINEAR_TEAM: "eng" } });
  await pack.refresh!(ctx);
  const kept = pack.kept()!;
  assert.equal(kept.teams.length, 1);
  assert.equal(kept.teams[0]!.key, "ENG");
  // Even with nothing kept, the configured team's keys still link.
  const bare = createLinearPack();
  const refs = bare.refs!(testContext({ env: { LINEAR_TEAM: "ENG" } }));
  assert.equal(refs[0]!.href("ENG-123"), "https://linear.app/issue/ENG-123");
});

test("linear: a PR naming an issue in its branch gets the pill and the facts", async () => {
  const { fetchFn } = fakeLinear([{ match: /viewer/, body: READ }]);
  const pack = createLinearPack({ fetchFn });
  const snap = snapshotWithPr("feat/ENG-7-pack");
  const ctx: PackContext = testContext({ env: { LINEAR_API_KEY: "k" }, snapshot: () => snap });
  await pack.refresh!(ctx);
  const slots = pack.slots!(ctx);
  const lead = String(slots["pr.lead"]!({ repo: "shop" }));
  assert.match(lead, /ENG-7 In Progress/);
  const facts = slots["pr.facts"]!({ repo: "shop" });
  assert.deepEqual(
    facts.map(([k]) => k),
    ["Linear", "Priority", "Cycle"],
  );
  assert.match(String(facts[0]![1]), /ENG-7/);
  // A PR that names nothing gets nothing, and hostile branch text stays inert.
  const hostile = snapshotWithPr(H, H);
  const ctxH = testContext({ env: { LINEAR_API_KEY: "k" }, snapshot: () => hostile });
  const slotsH = pack.slots!(ctxH);
  assert.equal(String(slotsH["pr.lead"]!({ repo: "shop" })), "");
  const inert = String(slotsH["pr.facts"]!({ repo: "shop" }).map(([, v]) => v).join(""));
  assert.ok(!inert.includes("<script>"));
});

test("linear: bino says counts and states, never a title's raw markup", async () => {
  const { fetchFn } = fakeLinear([{ match: /viewer/, body: READ }]);
  const pack = createLinearPack({ fetchFn });
  await pack.refresh!(testContext({ env: { LINEAR_API_KEY: "k" } }));
  const bino = pack.bino!(testContext({ env: { LINEAR_API_KEY: "k" } }));
  assert.match(bino, /2 assigned open: 1 In Progress, 1 /);
  assert.match(bino, /ENG cycle 42: 6\/10 done/);
  assert.match(bino, /ENG: 1 un-triaged/);
});

test("linear: the create act re-checks the team, writes, and logs to the actions table", async () => {
  const { fetchFn } = fakeLinear([
    { match: /DovreLinearTeam/, body: { teams: { nodes: [{ key: "ENG", name: "Engineering" }] } } },
    { match: /DovreLinearCreate/, body: { issueCreate: { success: true, issue: { identifier: "ENG-77", url: "https://linear.app/issue/ENG-77" } } } },
    { match: /viewer/, body: READ },
  ]);
  const pack = createLinearPack({ fetchFn });
  const { db, inserts } = fakeDb();
  const ctx = testContext({ env: { LINEAR_API_KEY: "k" }, db });
  const create = pack.acts!(ctx)[0]!;
  assert.equal(create.kind, "create");
  const done = await create.run({ team: "eng", title: "New thing", description: "Body" }, {}, ctx);
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(done.ok && done.done, "Created ENG-77");
  assert.equal(inserts.length, 1);
  assert.match(inserts[0]!.sql, /INSERT INTO actions/);
  assert.equal(inserts[0]!.binds[1], "linear.create");
  assert.ok(inserts[0]!.binds.includes("New thing"));
  // A team that isn't there is refused and logged, never written.
  const { fetchFn: noTeam } = fakeLinear([{ match: /DovreLinearTeam/, body: { teams: { nodes: [] } } }]);
  const p2 = createLinearPack({ fetchFn: noTeam });
  const { db: db2, inserts: inserts2 } = fakeDb();
  const ctx2 = testContext({ env: { LINEAR_API_KEY: "k" }, db: db2 });
  const refused = await p2.acts!(ctx2)[0]!.run({ team: "NOPE", title: "x" }, {}, ctx2);
  assert.ok(!refused.ok);
  assert.match(refused.error, /no team "NOPE"/);
  assert.equal(inserts2.length, 1);
  assert.equal(inserts2[0]!.binds[4], 0, "logged as failed");
});

test("linear: the comment act re-checks the issue, refuses closed ones, and logs", async () => {
  const { fetchFn } = fakeLinear([
    { match: /DovreLinearIssue/, body: { issue: { id: "abc", identifier: "ENG-7", title: "Ship", state: { name: "In Progress", type: "started" } } } },
    { match: /DovreLinearComment/, body: { commentCreate: { success: true } } },
  ]);
  const pack = createLinearPack({ fetchFn });
  const { db, inserts } = fakeDb();
  const ctx = testContext({ env: { LINEAR_API_KEY: "k" }, db });
  const comment = pack.acts!(ctx)[1]!;
  assert.equal(comment.kind, "comment");
  const done = await comment.run({ issue: "eng-7", text: "On it" }, {}, ctx);
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(inserts[0]!.binds[1], "linear.comment");
  assert.equal(inserts[0]!.binds[4], 1, "logged as ok");
  // A completed issue is refused before any write.
  const { fetchFn: closed } = fakeLinear([
    { match: /DovreLinearIssue/, body: { issue: { id: "abc", identifier: "ENG-8", title: "Old", state: { name: "Done", type: "completed" } } } },
  ]);
  const p2 = createLinearPack({ fetchFn: closed });
  const { db: db2, inserts: inserts2 } = fakeDb();
  const ctx2 = testContext({ env: { LINEAR_API_KEY: "k" }, db: db2 });
  const refused = await p2.acts!(ctx2)[1]!.run({ issue: "ENG-8", text: "hi" }, {}, ctx2);
  assert.ok(!refused.ok);
  assert.match(String(refused.error), /Done/);
  assert.equal(inserts2.length, 1);
  // A missing issue too.
  const { fetchFn: gone } = fakeLinear([{ match: /DovreLinearIssue/, body: {} }]);
  const p3 = createLinearPack({ fetchFn: gone });
  const r3 = await p3.acts!(testContext({ env: { LINEAR_API_KEY: "k" }, db: fakeDb().db }))[1]!.run({ issue: "ENG-99", text: "hi" }, {}, testContext({ env: { LINEAR_API_KEY: "k" }, db: fakeDb().db }));
  assert.ok(!r3.ok);
  assert.match(String(r3.error), /ENG-99/);
});
