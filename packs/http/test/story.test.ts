import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listStories, readStoryFile } from "../files.ts";
import { parseHttp, serializeReq } from "../model.ts";
import type { Resp } from "../send.ts";
import { fillValues, MAX_STEPS, MAX_STORY, parseStory, planStory, runValueCheck, type Send, serializeStory, setupFile, setupLoader, type Story, takeValue } from "../story.ts";

const SKETCH = `# A customer orders, cancels and gets the money back
# Covers the refund worker too.
given: fresh db, one customer
only: local, test

step: The customer orders two cinnamon buns
  case: orders.http#Happy path
  take: order.id = $.id, order.total = $.total

step: They cancel it
  POST {{baseUrl}}/api/orders/\${order.id}/cancel
  X-Trace: story
  body: {"reason": "changed my mind"}
  expect: json $.status == cancelled
  expect: status 200

step: Wait until the refund is paid
  GET {{baseUrl}}/api/refunds?order=\${order.id}
  until: $[0].status == paid  every 500ms  max 10s
  take: refund.amount = $[0].amount, loc = header Location, code = status

check: refund.amount == order.total

always: Remove the customer
  DELETE {{baseUrl}}/api/customers/\${customer.id}
`;

const ok = (text: string) => {
  const p = parseStory(text);
  assert.deepEqual(p.errors, []);
  return p.story;
};
const errs = (text: string) => parseStory(text).errors.map((e) => `${e.line}: ${e.message}`);
const send = (s: Story, i: number) => s.steps[i] as { t: "send" } & Send;

test("story: the sketch reads as steps, takes, checks and teardown", () => {
  const s = ok(SKETCH);
  assert.equal(s.title, "A customer orders, cancels and gets the money back");
  assert.deepEqual(s.about, ["Covers the refund worker too."]);
  assert.deepEqual(s.given, ["fresh db", "one customer"]);
  assert.deepEqual(s.only, ["local", "test"]);
  assert.equal(s.steps.length, 4);
  assert.deepEqual(send(s, 0).ask, { t: "case", ref: { file: "orders.http", name: "Happy path" } });
  assert.deepEqual(send(s, 0).take, [{ name: "order.id", from: "$.id" }, { name: "order.total", from: "$.total" }]);
  const cancel = send(s, 1);
  assert.equal(cancel.ask.t, "req");
  if (cancel.ask.t !== "req") return;
  assert.equal(cancel.ask.req.method, "POST");
  assert.equal(cancel.ask.req.url, "{{baseUrl}}/api/orders/${order.id}/cancel");
  // A JSON body without a Content-Type goes as JSON, and the header is written down.
  assert.deepEqual(cancel.ask.req.headers, [["X-Trace", "story"], ["Content-Type", "application/json"]]);
  assert.equal(cancel.ask.req.mode, "json");
  assert.equal(cancel.ask.req.name, "They cancel it");
  assert.deepEqual(cancel.expect, ["json $.status == cancelled", "status 200"]);
  const wait = send(s, 2);
  assert.deepEqual(wait.until, { check: "json $[0].status == paid", everyMs: 500, maxMs: 10_000 });
  assert.deepEqual(wait.take.map((t) => t.from), ["$[0].amount", "header Location", "status"]);
  if (wait.ask.t === "req") assert.deepEqual(wait.ask.req.query, ["order=${order.id}"]);
  assert.deepEqual(s.steps[3], { t: "check", text: "refund.amount == order.total" });
  assert.equal(s.always.length, 1);
  assert.equal(s.always[0]!.ask.t === "req" && s.always[0]!.ask.req.method, "DELETE");
});

test("story: written out and read back, it's the same story", () => {
  const s = ok(SKETCH);
  const text = serializeStory(s);
  assert.deepEqual(ok(text), s);
  assert.equal(serializeStory(ok(text)), text);
  assert.match(text, /until: json \$\[0\]\.status == paid {2}every 500ms {2}max 10s/);
});

test("story: multi-line bodies keep their shape, and a ### line in one doesn't split it", () => {
  const s = ok(`step: Make one
  PUT https://api.example.test/things/1
  Content-Type: application/json
  body:
    {
      "name": "x",

      "tags": ["a"]
    }
  expect: 2xx

step: Form
  POST https://api.example.test/form
  Content-Type: text/plain
  body:
    line one
    ### not a separator
`);
  const put = send(s, 0);
  assert.ok(put.ask.t === "req");
  if (put.ask.t === "req") assert.equal(put.ask.req.body, '{\n  "name": "x",\n\n  "tags": ["a"]\n}');
  const form = send(s, 1);
  if (form.ask.t === "req") assert.equal(form.ask.req.body, "line one\n ### not a separator");
  assert.deepEqual(ok(serializeStory(s)), s);
});

test("story: what can't be read says where and why, and nothing else is guessed", () => {
  const e = errs(`given: fresh db
bogus: line
  stray indented
step: No request
  take: x = $.a

step: Two requests
  GET https://a.test/1
  GET https://a.test/2

step: Bad bits
  case: ../etc/passwd#x
  GET https://a.test/x
  expect: status 999
  take: 1bad = $.a
  take: x = nowhere
  until: $.done == true  every 10ms
  until: $.done == true  max 999s
  frobnicate: yes
check: nonsense
always: Cleanup
  DELETE https://a.test/x
step: After always
  GET https://a.test/late
`);
  const want = [
    /^2: "bogus: line" isn't part of a story/,
    /^3: This line is indented but isn't under a step/,
    /^4: A step needs a request/,
    /^9: A step sends one request/,
    /^12: case: write file\.http#Request name/,
    /^14: expect: status takes codes/,
    /^15: "1bad = \$\.a" isn't a take/,
    /^16: x = nowhere: a take reads/,
    /^17: until: every takes 100ms/,
    /^18: until: max takes/,
    /^19: "frobnicate: yes" isn't something a step has/,
    /^20: check: write a value/,
    /^23: Steps go before the always: ones/,
  ];
  assert.equal(e.length, want.length, e.join("\n"));
  want.forEach((w, i) => assert.match(e[i]!, w));
  assert.deepEqual(errs(""), ["1: The story has no steps"]);
});

test("story: hostile input: values never reach a host, sizes are capped, odd text stays text", () => {
  for (const url of ["https://${evil}/x", "${base}/x", "{{baseUrl}}${path}", "{{baseUrl}}:${port}/x", "http${s}://a.test/"])
    assert.ok(errs(`step: s\n  GET ${url}\n`).some((m) => /host can't come from a value/.test(m)), url);
  assert.deepEqual(errs("step: s\n  GET {{baseUrl}}/a/${x}?q=${y}\n"), []);
  assert.ok(errs("step: s\n  GET https://a.test/${x-y}\n").some((m) => /isn't a value name/.test(m)));
  assert.ok(errs("step: s\n  GET https://a.test/\n  X-${h}: 1\n").length, "a header name from a value is refused");
  assert.match(errs("x".repeat(MAX_STORY + 1))[0]!, /at most 64 kB/);
  const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => `step: ${i}\n  GET https://a.test/${i}\n`).join("\n");
  assert.ok(errs(many).some((m) => /at most 50 steps/.test(m)));
  // CRLF, tabs, NULs and markup are just text: read, not run, and written back out on one line.
  const s = ok("# <script>alert(1)</script>\r\nstep: \t<b>x</b>\u0000\r\n\tGET https://a.test/\r\n");
  assert.equal(s.title, "<script>alert(1)</script>");
  assert.equal(send(s, 0).title, "<b>x</b>\u0000");
  assert.doesNotMatch(serializeStory({ ...s, title: "a\nstep: injected" }), /^step: injected/m);
});

test("story: takes read the body, a header or the status; refusing what chain.ts refuses", () => {
  const resp: Resp = { status: 201, statusText: "Created", ms: 1, size: 1, truncated: false, headers: [["Location", "/o/7"]], body: JSON.stringify({ id: 7, items: [{ a: 1 }], masked: "••••", tpl: "${x}" }), binary: false };
  assert.deepEqual(takeValue("$.id", resp), { value: "7" });
  assert.deepEqual(takeValue("$.items[0]", resp), { value: '{"a":1}' });
  assert.deepEqual(takeValue("header location", resp), { value: "/o/7" });
  assert.deepEqual(takeValue("status", resp), { value: "201" });
  assert.match((takeValue("$.nope", resp) as { error: string }).error, /^The response has nothing at/);
  assert.match((takeValue("$.masked", resp) as { error: string }).error, /secret/);
  assert.match((takeValue("$.tpl", resp) as { error: string }).error, /\$\{ there/);
});

test("story: values go into a request's path, query, headers and body, and nothing unsafe does", () => {
  const s = ok("step: s\n  POST {{baseUrl}}/o/${order.id}?a=${order.id}\n  X-Id: ${order.id}\n  body: {\"n\": ${n}}\n");
  const req = send(s, 0).ask.t === "req" ? (send(s, 0).ask as { req: import("../model.ts").Req }).req : undefined!;
  const filled = fillValues(req, new Map([["order.id", "42"], ["n", "3"]]));
  assert.ok(filled.ok);
  if (filled.ok) {
    assert.equal(filled.req.url, "{{baseUrl}}/o/42");
    assert.deepEqual(filled.req.query, ["a=42"]);
    assert.deepEqual(filled.req.headers[0], ["X-Id", "42"]);
    assert.equal(filled.req.body, '{"n": 3}');
  }
  const bad = (v: string) => (fillValues(req, new Map([["order.id", v], ["n", "1"]])) as { error: string }).error;
  assert.match(bad("{{API_TOKEN}}"), /holds \{\{/);
  assert.match(bad("${n}"), /holds \{\{ or \$\{/);
  assert.match(bad("a\r\nX-Evil: 1"), /line break/);
  assert.match(bad("Bearer ••••"), /masked secret/);
  assert.match((fillValues(req, new Map()) as { error: string }).error, /No value order\.id yet/);
  assert.match((fillValues({ ...req, url: "https://${h}/" }, new Map([["h", "evil.test"]])) as { error: string }).error, /host can't come from a value/);
});

test("story: checks on values compare numbers as numbers, words as text", () => {
  const v = new Map([["a", "10"], ["b", "10.0"], ["s", "paid"], ["name", "Ann Lee"]]);
  assert.equal(runValueCheck("a == b", v).ok, true);
  assert.equal(runValueCheck("a < 9", v).ok, false);
  assert.equal(runValueCheck("a >= 10", v).ok, true);
  assert.equal(runValueCheck("s == paid", v).ok, true);
  assert.equal(runValueCheck('s == "a"', v).ok, false);
  assert.equal(runValueCheck("name contains Lee", v).ok, true);
  assert.equal(runValueCheck("s < 3", v).ok, false);
  assert.deepEqual(runValueCheck("missing == 1", v), { text: "missing == 1", ok: false, got: "no value missing" });
});

test("story: a plan runs setups first (each once), pins hold, and loops are refused", () => {
  const setups: Record<string, Story> = {
    "fresh-db": ok("only: local\nstep: Reset\n  POST {{baseUrl}}/reset\nalways: Drop\n  POST {{baseUrl}}/drop\n"),
    "one-customer": ok("given: fresh db\nstep: Customer\n  POST {{baseUrl}}/customers\n  take: customer.id = $.id\nalways: Bye\n  DELETE {{baseUrl}}/customers/${customer.id}\n"),
    a: ok("given: b\nstep: A\n  GET {{baseUrl}}/a\n"),
    b: ok("given: a\nstep: B\n  GET {{baseUrl}}/b\n"),
  };
  const load = (n: string) => setups[setupFile(n)] ?? { error: "there's no such setup" };
  const story = ok(SKETCH);
  const p = planStory(story, "local", load);
  assert.ok(p.ok);
  if (p.ok) {
    assert.deepEqual(p.plan.setups, ["fresh db", "one customer"]);
    assert.deepEqual(p.plan.steps.map((s) => (s.t === "send" ? s.title : s.text)).slice(0, 3), ["Reset", "Customer", "The customer orders two cinnamon buns"]);
    assert.deepEqual(p.plan.always.map((s) => s.title), ["Remove the customer", "Bye", "Drop"]);
  }
  assert.match((planStory(story, "prod", load) as { error: string }).error, /only runs in local, test, not prod/);
  assert.match((planStory(story, "test", load) as { error: string }).error, /Setup fresh db only runs in local/);
  assert.match((planStory(ok("given: a\nstep: x\n  GET {{baseUrl}}/\n"), "", load) as { error: string }).error, /go round: a → b → a/);
  assert.match((planStory(ok("given: nope\nstep: x\n  GET {{baseUrl}}/\n"), "", load) as { error: string }).error, /Setup nope: there's no such setup/);
});

test("story: files: stories and setups load from .http/, and symlinks or odd names are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "story-"));
  mkdirSync(join(root, ".http", "setups"), { recursive: true });
  mkdirSync(join(root, ".http", "stories"));
  writeFileSync(join(root, ".http", "setups", "fresh-db.story"), "step: Reset\n  POST {{baseUrl}}/reset\n");
  writeFileSync(join(root, ".http", "setups", "broken.story"), "step: nothing\n");
  writeFileSync(join(root, ".http", "stories", "refund.story"), SKETCH);
  writeFileSync(join(root, "secret.txt"), "hush");
  symlinkSync(join(root, "secret.txt"), join(root, ".http", "stories", "leak.story"));
  assert.deepEqual(listStories(root, "stories"), ["refund.story"]);
  assert.deepEqual(listStories(root, "setups"), ["broken.story", "fresh-db.story"]);
  assert.equal(readStoryFile(root, "stories", "refund.story")?.text, SKETCH);
  assert.equal(readStoryFile(root, "stories", "missing.story"), undefined);
  assert.throws(() => readStoryFile(root, "stories", "leak.story"), /isn't a plain file/);
  for (const bad of ["../secret.txt", "Refund.story", "a/b.story", ".story", "x.http"]) assert.throws(() => readStoryFile(root, "stories", bad), /plain lower-case name/, bad);
  assert.throws(() => readStoryFile(root, "../" as "stories", "refund.story"), /stories\/ or setups\//);
  const load = setupLoader(root);
  assert.equal((load("Fresh DB") as Story).steps.length, 1);
  assert.match((load("broken") as { error: string }).error, /^line 1: A step needs a request/);
  assert.match((load("../../etc") as { error: string }).error, /no \.http\/setups\/etc\.story/);
  const outside = mkdtempSync(join(tmpdir(), "story-out-"));
  mkdirSync(join(outside, "setups"));
  const linked = mkdtempSync(join(tmpdir(), "story-link-"));
  symlinkSync(outside, join(linked, ".http"));
  assert.match((setupLoader(linked)("x") as { error: string }).error, /isn't a plain folder/);
});

test("model: # @given on a saved request reads and writes back", () => {
  const p = parseHttp("### Happy path\n# @given fresh db, one customer\n# @given fresh db\n# @expect status 201\nPOST {{baseUrl}}/orders\n");
  assert.deepEqual(p.reqs[0]!.given, ["fresh db", "one customer"]);
  const { span: _, ...r } = p.reqs[0]!;
  assert.match(serializeReq(r), /^### Happy path\n# @given fresh db, one customer\n# @expect status 201\n/);
  assert.deepEqual(parseHttp(serializeReq(r)).reqs[0]!.given, ["fresh db", "one customer"]);
  assert.equal(parseHttp("GET https://a.test/\n").reqs[0]!.given, undefined);
});
