/** The stories overview's pure parts (dovre-packs#65 H-05): who runs, pips, what kept runs show, gaps. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { failedAt, noticedIn, pipsOf, uncovered, usesOf, whoRuns } from "../board.ts";
import { buildCatalog } from "../catalog.ts";
import { agentEnvsOf, parseHttp } from "../model.ts";
import type { StepRun, StoryRun } from "../runner.ts";

const step = (o: Partial<StepRun> = {}): StepRun => ({ lane: "story", from: "", title: "Order", kind: "send", what: "POST {{baseUrl}}/orders", state: "passed", checks: [], took: [], ms: 50, status: 201, ...o });
let n = 0;
const run = (o: Partial<StoryRun> = {}): StoryRun => ({ id: `r${n++}`, at: n * 1000, repo: "shop", story: "buy.story", title: "Buy", env: "local", state: "passed", ms: 100, steps: [step()], values: [], ...o });

test("who runs: reads only, or an env that lets an agent write; a method we can't tell is a write", () => {
  assert.equal(whoRuns(["GET", "HEAD"], false), "agent");
  assert.equal(whoRuns([], false), "agent");
  assert.equal(whoRuns(["GET", "POST"], false), "you");
  assert.equal(whoRuns(["GET", "?"], false), "you");
  assert.equal(whoRuns(["DELETE"], true), "agent");
});

test("the $agent mark: only \"writes\" on an environment counts; $shared and junk don't", () => {
  assert.deepEqual([...agentEnvsOf('{"local": {"$agent": "writes", "baseUrl": "x"}, "staging": {"$agent": "reads"}, "$shared": {"$agent": "writes"}, "bad name!": {"$agent": "writes"}}')], ["local"]);
  for (const t of ["", "nope", "[]", '{"local": "writes"}', undefined]) assert.equal(agentEnvsOf(t).size, 0);
});

test("uses: each ${name} once, in order", () => {
  assert.deepEqual(usesOf("/orders/${order.id}/lines/${ line.id }?again=${order.id}"), ["order.id", "line.id"]);
  assert.deepEqual(usesOf("{{baseUrl}}/x"), []);
});

test("pips: one environment's last runs, oldest first, padded in front", () => {
  const runs = [run({ state: "failed" }), run(), run({ env: "staging" }), run({ story: "other.story" }), run()];
  assert.deepEqual(pipsOf(runs, "buy.story", "local", 5), ["none", "none", "failed", "passed", "passed"]);
  assert.deepEqual(pipsOf(runs, "buy.story", "local", 2), ["passed", "passed"]);
  assert.deepEqual(pipsOf(runs, "buy.story", "dev", 2), ["none", "none"]);
});

test("failed at: the step's number and the check that failed, else its error", () => {
  const r = run({ state: "failed", steps: [step(), step({ title: "Pay", state: "failed", checks: [{ text: "status 201", ok: true }, { text: "json $.total == 15900", ok: false }] }), step({ state: "skipped" })] });
  assert.deepEqual(failedAt(r), { n: 2, title: "Pay", why: "json $.total == 15900" });
  assert.deepEqual(failedAt(run({ state: "failed", steps: [step({ state: "failed", error: "Nothing came back: refused." })] })), { n: 1, title: "Order", why: "Nothing came back: refused." });
  assert.equal(failedAt(run()), undefined);
});

test("noticed: flaky needs two of each; slower needs twice the time and 100 ms more", () => {
  const fail = (title: string) => run({ state: "failed", steps: [step({ title, state: "failed", checks: [{ text: "status 200", ok: false }] })] });
  const flaky = [run(), fail("Wait for the refund"), run(), fail("Wait for the refund"), run()];
  const got = noticedIn(flaky);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.kind, "flaky");
  assert.match(got[0]!.text, /Buy failed 2 of its last 5 runs on local, each time at "Wait for the refund"\./);
  // One failure isn't flaky; nor are failures on two environments with one each.
  assert.deepEqual(noticedIn([run(), fail("x"), run(), run()]), []);
  assert.deepEqual(noticedIn([fail("x"), run(), run({ env: "staging" }), { ...fail("x"), env: "staging" }]), []);

  const timed = (ms: number) => run({ steps: [step({ ms })] });
  const slow = noticedIn([80, 90, 84, 250, 260, 270].map(timed));
  assert.equal(slow.length, 1);
  assert.equal(slow[0]!.kind, "slower");
  assert.match(slow[0]!.text, /"Order" in Buy went from about 84 ms to 260 ms over its last 6 runs on local\./);
  // Twice as slow but only 40 ms more is noise; so are fewer than 6 runs.
  assert.deepEqual(noticedIn([20, 20, 20, 60, 60, 60].map(timed)), []);
  assert.deepEqual(noticedIn([80, 90, 250, 260, 270].map(timed)), []);
  // Running runs don't count.
  assert.deepEqual(noticedIn([run({ state: "running" }), fail("x"), fail("x"), run(), run({ state: "running" })]), []);
});

test("uncovered: spec endpoints with no case; those a story's own request reaches say so", () => {
  const spec = JSON.stringify({ openapi: "3.0.0", info: { title: "Shop" }, paths: { "/orders": { get: {}, post: {} }, "/refunds": { post: {} } } });
  const cat = buildCatalog(spec, [{ name: "orders.http", reqs: parseHttp("### List\nGET {{baseUrl}}/orders\n").reqs }]);
  assert.deepEqual(
    uncovered(cat, new Set(["POST /refunds"])).map((g) => `${g.ep.method} ${g.ep.path} ${g.inStory}`),
    ["POST /orders false", "POST /refunds true"],
  );
});
