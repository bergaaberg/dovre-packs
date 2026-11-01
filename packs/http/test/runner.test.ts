/**
 * HTTP client: the story runner (runner.ts) with a fake send. Takes feed later steps, until: tries
 * again, the first failure stops the rest and always: steps still run; kept runs hold no values.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "dovre/db.ts";
import type { Req } from "../model.ts";
import { keepRun, keptOf, keptRun, keptRuns, MAX_KEPT, MAX_TRIES, newRun, type RunIo, runStory, runSummary, type StoryRun } from "../runner.ts";
import type { Resp } from "../send.ts";
import { type Plan, parseStory, planStory, type Story } from "../story.ts";

const resp = (status: number, body: unknown, headers: [string, string][] = []): Resp => ({ status, statusText: "", ms: 3, size: 0, truncated: false, headers: [["content-type", "application/json"], ...headers], body: JSON.stringify(body), binary: false });

function storyOf(text: string, setups: Record<string, string> = {}, env = "local"): Plan {
  const p = parseStory(text);
  assert.deepEqual(p.errors, []);
  const load = (n: string): Story | { error: string } => {
    const t = setups[n];
    return t ? parseStory(t).story : { error: "missing" };
  };
  const planned = planStory(p.story, env, load);
  assert.ok(planned.ok, !planned.ok ? planned.error : "");
  return planned.plan;
}

/** A fake io: `answer` gives each request's response (or an error string); every send is recorded. */
function io(answer: (req: Req, n: number) => Resp | string, cases: Record<string, Req> = {}) {
  const sent: Req[] = [];
  let clock = 1000;
  const io: RunIo = {
    caseOf: (ref) => {
      const r = cases[`${ref.file}#${ref.name}`];
      return r ? { req: r, file: ref.file, n: 0 } : { error: "no such case" };
    },
    async send(req) {
      sent.push(req);
      const a = answer(req, sent.length);
      if (typeof a === "string") return { ok: false, error: a };
      return { ok: true, sentId: `s${sent.length}`, resp: a, url: req.url.split("?")[0]! };
    },
    wait: async (ms) => void (clock += ms),
    now: () => clock,
    publish: () => {},
  };
  return { io, sent };
}

const run = (plan: Plan): StoryRun => newRun({ id: "r1", at: 1, repo: "shop", story: "order.story", title: "Order", env: "local" }, plan);

const ORDER = `# Order and cancel
given: one customer

step: Order
  POST https://api.test/orders?customer=\${customer.id}
  body: {"buns": 2}
  expect: 201
  take: order.id = $.id, order.total = $.total

step: Cancel
  POST https://api.test/orders/\${order.id}/cancel
  expect: $.status == cancelled

step: Refund
  GET https://api.test/refunds/\${order.id}
  until: $.status == paid  every 500ms  max 5s
  take: refund.amount = $.amount

check: refund.amount == order.total

always: Clean up
  DELETE https://api.test/customers/\${customer.id}
`;
const SETUPS = { "one customer": "step: Customer\n  POST https://api.test/customers\n  take: customer.id = $.id\nalways: Bye\n  POST https://api.test/bye\n" };

test("runner: values flow from step to step, until: tries again, always: runs last", async () => {
  const plan = storyOf(ORDER, SETUPS);
  let polls = 0;
  const f = io((req) => {
    if (req.url.endsWith("/customers")) return resp(201, { id: "c7" });
    if (req.url.endsWith("/orders")) return resp(201, { id: "o9", total: 148 });
    if (req.url.endsWith("/cancel")) return resp(200, { status: "cancelled" });
    if (req.url.includes("/refunds/")) return resp(200, ++polls < 3 ? { status: "pending" } : { status: "paid", amount: 148 });
    return resp(204, {});
  });
  const r = run(plan);
  assert.deepEqual(r.steps.map((s) => s.lane), ["given", "story", "story", "story", "story", "always", "always"]);
  await runStory(r, plan, f.io);
  assert.equal(r.state, "passed", JSON.stringify(r.steps.map((s) => [s.title, s.state, s.error])));
  assert.deepEqual(
    f.sent.map((q) => `${q.method} ${q.url}${q.query.length ? `?${q.query.join("&")}` : ""}`),
    ["POST https://api.test/customers", "POST https://api.test/orders?customer=c7", "POST https://api.test/orders/o9/cancel", "GET https://api.test/refunds/o9", "GET https://api.test/refunds/o9", "GET https://api.test/refunds/o9", "DELETE https://api.test/customers/c7", "POST https://api.test/bye"],
  );
  const refund = r.steps[3]!;
  assert.equal(refund.tries, 3);
  assert.deepEqual(refund.took, ["refund.amount"]);
  assert.equal(r.steps[4]!.checks[0]!.ok, true);
  assert.deepEqual(new Map(r.values).get("order.id"), "o9");
  assert.equal(runSummary(r), "all 7 passed");
  assert.equal(r.ms, 1000);
});

test("runner: the first failure skips the rest; always: still runs, and a missing value fails without a send", async () => {
  const plan = storyOf(ORDER, SETUPS);
  const f = io((req) => (req.url.endsWith("/customers") ? resp(201, { id: "c7" }) : req.url.endsWith("/orders") ? resp(500, { error: "boom" }) : resp(204, {})));
  const r = run(plan);
  await runStory(r, plan, f.io);
  assert.equal(r.state, "failed");
  assert.deepEqual(r.steps.map((s) => s.state), ["passed", "failed", "skipped", "skipped", "skipped", "passed", "passed"]);
  assert.match(r.steps[1]!.error!, /1 of 1 checks failed/);
  assert.equal(runSummary(r), "failed at Order");
  assert.equal(f.sent.length, 4);

  // Without the setup's value, the always step can't fill ${customer.id}: it fails, nothing goes out.
  const lone = storyOf("step: Order\n  GET https://api.test/x\nalways: Clean up\n  DELETE https://api.test/customers/${customer.id}\n");
  const g = io(() => resp(200, {}));
  const r2 = run(lone);
  await runStory(r2, lone, g.io);
  assert.equal(r2.steps[1]!.state, "failed");
  assert.match(r2.steps[1]!.error!, /No value customer\.id yet/);
  assert.equal(g.sent.length, 1);
});

test("runner: until: gives up at its max (and at MAX_TRIES); a refused send and a bad take fail the step", async () => {
  const plan = storyOf("step: Wait\n  GET https://api.test/job\n  until: $.done == true  every 1s  max 3s\n");
  const f = io(() => resp(200, { done: false }));
  const r = run(plan);
  await runStory(r, plan, f.io);
  assert.equal(r.state, "failed");
  assert.equal(r.steps[0]!.tries, 4);
  assert.match(r.steps[0]!.error!, /Still not json \$\.done == true after 4 tries \(3 s\)/);
  assert.ok(r.steps[0]!.checks.some((k) => k.text.startsWith("until") && !k.ok));

  const many = storyOf("step: Wait\n  GET https://api.test/job\n  until: $.done == true  every 100ms  max 300s\n");
  const g = io(() => resp(200, { done: false }));
  await runStory(run(many), many, g.io);
  assert.equal(g.sent.length, MAX_TRIES);

  const refused = storyOf("step: A\n  GET https://api.test/a\n");
  const h = io(() => "Not sent: no such host");
  const r3 = run(refused);
  await runStory(r3, refused, h.io);
  assert.equal(r3.steps[0]!.error, "Not sent: no such host");

  const badTake = storyOf("step: A\n  GET https://api.test/a\n  take: x = $.nope\n");
  const r4 = run(badTake);
  await runStory(r4, badTake, io(() => resp(200, { a: 1 })).io);
  assert.match(r4.steps[0]!.error!, /Couldn't take x/);
});

test("runner: a case step sends the saved request with its own checks and the step's", async () => {
  const plan = storyOf("step: Happy\n  case: orders.http#Happy path\n  expect: $.ok == true\n  take: id = $.id\nstep: Missing\n  case: orders.http#Nope\n");
  const saved: Req = { name: "Happy path", method: "GET", url: "https://api.test/orders/1", headers: [], query: [], mode: "none", body: "", expect: ["status 200"] };
  const f = io(() => resp(200, { ok: true, id: "1" }), { "orders.http#Happy path": saved });
  const r = run(plan);
  await runStory(r, plan, f.io);
  assert.deepEqual(r.steps[0]!.checks.map((k) => k.text), ["status 200", "json $.ok == true"]);
  assert.equal(r.steps[0]!.state, "passed");
  assert.equal(r.steps[1]!.error, "Not sent: no such case");
  assert.equal(f.sent.length, 1);
});

test("runner: a kept run has no values and no check says what it got; each story keeps its newest MAX_KEPT", async () => {
  const db = openDb().DB;
  const plan = storyOf("step: A\n  GET https://api.test/a\n  take: token = $.token\n");
  const r = run(plan);
  await runStory(r, plan, io(() => resp(200, { token: "tok_secret_42" })).io);
  const k = keptOf(r);
  assert.deepEqual(k.values, []);
  assert.equal(k.steps[0]!.checks.every((c) => c.got === undefined), true);
  assert.equal(k.steps[0]!.sentId, undefined);
  assert.equal(k.steps[0]!.url, undefined);
  await keepRun(db, r);
  const back = await keptRun(db, "r1");
  assert.equal(back?.state, "passed");
  assert.ok(!JSON.stringify(back).includes("tok_secret_42"));
  for (let i = 0; i < MAX_KEPT + 5; i++) await keepRun(db, { ...r, id: `x${i}`, at: 10 + i });
  const all = await keptRuns(db, "shop", "order.story", 500);
  assert.equal(all.length, MAX_KEPT);
  assert.equal(all[0]!.id, `x${MAX_KEPT + 4}`);
  assert.equal(await keptRun(db, "r1"), undefined);
});
