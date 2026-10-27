/**
 * HTTP client (`http`): a response held to `# @expect` checks, and the checks kept in .http files.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLines, parseCheck, runCheck, runChecks } from "../checks.ts";
import { blankReq, parseHttp, reqOfForm, serializeReq, withReq } from "../model.ts";
import type { Resp } from "../send.ts";

const resp = (over: Partial<Resp> = {}): Resp => ({
  status: 200,
  statusText: "OK",
  ms: 120,
  size: 10,
  truncated: false,
  headers: [["content-type", "application/json; charset=utf-8"], ["etag", "abc"]],
  body: JSON.stringify({ items: [{ id: 3, name: "kari" }, { id: 4 }], total: 2, tags: ["a", "b"], ok: true }),
  binary: false,
  ...over,
});
const ok = (t: string, r = resp()) => runCheck(t, r).ok;

test("status: codes, classes and lists", () => {
  assert.ok(ok("status 200"));
  assert.ok(ok("status 2xx"));
  assert.ok(ok("status 201 200"));
  assert.ok(!ok("status 201"));
  assert.ok(!ok("status 4xx"));
  assert.equal(runCheck("status 404", resp()).got, "200");
});

test("time, header, body", () => {
  assert.ok(ok("time < 800"));
  assert.ok(ok("time <= 120ms"));
  assert.ok(!ok("time < 120"));
  assert.ok(ok("header content-type"));
  assert.ok(ok("header Content-Type contains JSON"));
  assert.ok(ok('header etag == "abc"'));
  assert.ok(!ok("header etag == abd"));
  assert.deepEqual(runCheck("header x-missing", resp()), { text: "header x-missing", ok: false, got: "not there" });
  assert.ok(ok('body contains "kari"'));
  assert.ok(!ok("body contains nobody"));
  assert.ok(!ok("body contains x", resp({ binary: true, body: "" })));
});

test("json: exists, equals, contains, numbers, no match, not JSON", () => {
  assert.ok(ok("json $.items[0].id"));
  assert.ok(ok("json $.items[0].id exists"));
  assert.ok(ok("json $.items[0].id == 3"));
  assert.ok(ok('json $.items[0].name == "kari"'));
  assert.ok(ok("json $.items[0].name == kari"));
  assert.ok(ok("json $.ok == true"));
  assert.ok(ok('json $.items[1] == {"id": 4}'));
  assert.ok(ok("json $.total != 3"));
  assert.ok(ok("json $.tags contains a"));
  assert.ok(ok("json $.items[0].name contains ar"));
  assert.ok(ok("json $.total >= 2"));
  assert.ok(!ok("json $.total > 2"));
  assert.ok(!ok("json $.items[0].name < 3"));
  assert.deepEqual(runCheck("json $.nope", resp()), { text: "json $.nope", ok: false, got: "no match" });
  assert.equal(runCheck("json $.a", resp({ body: "<html>" })).got, "the body isn't JSON");
  assert.equal(runCheck("json $.a", resp({ truncated: true })).got, "the body was cut off");
});

test("checks that can't be read fail, and say why", () => {
  for (const t of ["", "status", "status 99", "time > 3", "header", "body has x", "json items", "json $.a ==", "json $.a exists 3", "json $.a < big", "json $[", "launch rockets"]) {
    const p = parseCheck(t);
    assert.ok("error" in p, t);
    const r = runCheck(t, resp());
    assert.equal(r.ok, false, t);
    assert.match(r.got!, /^not understood: /);
  }
});

test("no checks: any status below 400 passes", () => {
  assert.deepEqual(runChecks(undefined, resp({ status: 302 })), [{ text: "status below 400", ok: true, got: "302" }]);
  assert.equal(runChecks([], resp({ status: 500 }))[0]!.ok, false);
  assert.equal(runChecks(["status 2xx", "json $.total == 2"], resp()).length, 2);
});

test(".http files keep checks: read from # @expect lines, written back, kept when a request is replaced", () => {
  const text = `### List
# @expect status 200
GET https://api.example.com/items
Accept: application/json
// @expect json $.total == 2

### Plain
GET https://api.example.com/health
`;
  const p = parseHttp(text);
  assert.deepEqual(p.reqs[0]!.expect, ["status 200", "json $.total == 2"]);
  assert.deepEqual(p.reqs[0]!.headers, [["Accept", "application/json"]]);
  assert.equal(p.reqs[1]!.expect, undefined);
  const { span: _s, ...first } = p.reqs[0]!;
  const out = serializeReq(first);
  assert.match(out, /^### List\n# @expect status 200\n# @expect json \$\.total == 2\nGET /);
  assert.deepEqual(parseHttp(out).reqs[0]!.expect, ["status 200", "json $.total == 2"]);
  const replaced = withReq(text, { ...first, url: "https://api.example.com/items2" }, 0)!;
  assert.deepEqual(parseHttp(replaced).reqs[0]!.expect, ["status 200", "json $.total == 2"]);
  assert.equal(parseHttp(replaced).reqs[1]!.url, "https://api.example.com/health");
  // A check can't break out of its comment line.
  assert.equal(serializeReq({ ...blankReq(), url: "https://h", expect: ["status 200\nDELETE https://h"] }).split("\n").filter((l) => l.startsWith("DELETE")).length, 0);
});

test("the editor's Checks box: one per line, # @expect prefixes dropped, capped", () => {
  assert.deepEqual(checkLines("status 200\n\n# @expect json $.a\n  @expect time < 5  \n"), ["status 200", "json $.a", "time < 5"]);
  assert.equal(checkLines(Array.from({ length: 80 }, () => "status 200").join("\n")).length, 30);
  assert.deepEqual(reqOfForm({ url: "https://h", expect: "status 201\r\njson $.id" }).expect, ["status 201", "json $.id"]);
  assert.equal(reqOfForm({ url: "https://h", expect: "  " }).expect, undefined);
});
