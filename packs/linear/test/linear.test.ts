/** Linear Pack (`linear`) tests: a fake Linear answers the GraphQL calls. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import type { D1 } from "dovre/db.ts";
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
  url: `https://linear.app/acme/issue/${key}/some-slug`,
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
  organization: { urlKey: "acme" },
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
  assert.equal(refs[0]!.href("ENG-7"), "https://linear.app/acme/issue/ENG-7");
  // Linear's own link (workspace, key, slug) is kept as given.
  assert.equal(kept.mine.find((i) => i.key === "ENG-7")!.url, "https://linear.app/acme/issue/ENG-7/some-slug");
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
  assert.equal(pack.refs!(ctx)[0]!.href("ENG-123"), "https://linear.app/acme/issue/ENG-123");
  // Before the first refresh there's no workspace to link into, so nothing links yet.
  assert.deepEqual(createLinearPack().refs!(testContext({ env: { LINEAR_TEAM: "ENG" } })), []);
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

test("linear: glance counts my issues; the opening line speaks only for urgent ones", async () => {
  const urgent = { ...READ, issues: { nodes: [ISSUE("ENG-7", "Ship the pack", { priority: 1 }), ISSUE("ENG-8", "Tidy up")] } };
  for (const [body, line] of [[READ, undefined], [urgent, "1 urgent Linear issue is yours."]] as const) {
    const { fetchFn } = fakeLinear([{ match: /viewer/, body }]);
    const pack = createLinearPack({ fetchFn });
    const ctx = testContext({ env: { LINEAR_API_KEY: "k" } });
    assert.deepEqual(pack.glance!(ctx), [], "nothing before the first read");
    await pack.refresh!(ctx);
    assert.deepEqual(pack.glance!(ctx), [{ label: "Linear", value: 2 }]);
    const brief = pack.brief!(ctx);
    if (line) assert.deepEqual(brief, [{ text: line, href: "/linear", tone: "warn" }]);
    else assert.deepEqual(brief, []);
  }
});

test("linear: issueHref points every issue link (and refs) elsewhere", async () => {
  const { fetchFn } = fakeLinear([{ match: /viewer/, body: READ }]);
  const pack = createLinearPack({ fetchFn, issueHref: (key) => `/elsewhere/linear.app/acme/issue/${key}` });
  const ctx = testContext({ env: { LINEAR_API_KEY: "k" } });
  await pack.refresh!(ctx);
  const kept = pack.kept()!;
  for (const i of [...kept.mine, ...kept.teams.flatMap((t) => t.untriaged)]) assert.equal(i.url, `/elsewhere/linear.app/acme/issue/${i.key}`);
  assert.equal(pack.refs!(ctx)[0]!.href("ENG-1"), "/elsewhere/linear.app/acme/issue/ENG-1");
  assert.ok(!String(await linearPage(kept)).includes("https://linear.app"));
});

test("linear: the create act re-checks the team, writes, and logs to the actions table", async () => {
  const { fetchFn, calls } = fakeLinear([
    { match: /DovreLinearTeam/, body: { teams: { nodes: [{ id: "team-uuid", key: "ENG", name: "Engineering" }] } } },
    { match: /DovreLinearCreate/, body: { issueCreate: { success: true, issue: { identifier: "ENG-77", url: "https://linear.app/acme/issue/ENG-77/new-thing" } } } },
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
  assert.equal(done.ok && done.href, "https://linear.app/acme/issue/ENG-77/new-thing");
  // Linear's issueCreate takes the team's id, not its key.
  const created = calls.find((c) => String((c.body as { query?: string }).query).includes("DovreLinearCreate"))!;
  assert.equal((created.body as { variables: { teamId: string } }).variables.teamId, "team-uuid");
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
  const { fetchFn, calls } = fakeLinear([
    { match: /DovreLinearIssue/, body: { issue: { id: "abc", identifier: "ENG-7", title: "Ship", state: { name: "In Progress", type: "started" } } } },
    { match: /DovreLinearComment/, body: { commentCreate: { success: true } } },
  ]);
  const pack = createLinearPack({ fetchFn });
  const { db, inserts } = fakeDb();
  const ctx = testContext({ env: { LINEAR_API_KEY: "k" }, db });
  const comment = pack.acts!(ctx)[1]!;
  assert.equal(comment.kind, "comment");
  // The card posts what it shows: a box per field.
  assert.match(String(comment.inputs({ issue: "ENG-7" }, undefined, ctx)), /name="issue" value="ENG-7".*name="text"/s);
  const done = await comment.run({ issue: "eng-7", text: "On it" }, {}, ctx);
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(inserts[0]!.binds[1], "linear.comment");
  const asked = calls.find((c) => String((c.body as { query?: string }).query).includes("DovreLinearIssue"))!;
  assert.match(String((asked.body as { query: string }).query), /issue\(id: \$key\) \{ id identifier/, "asks Linear for the issue's id");
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
