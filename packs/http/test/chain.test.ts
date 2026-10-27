import assert from "node:assert/strict";
import { test } from "node:test";
import { type Refs, resolveRef } from "../chain.ts";
import { blankReq, prepare, type Req } from "../model.ts";
import type { Resp } from "../send.ts";

const resp = (body: string, o: Partial<Resp> = {}): Resp => ({ status: 200, statusText: "OK", ms: 1, size: body.length, truncated: false, headers: [["Location", "/orders/7"], ["X-Secret", "••••"]], body, binary: false, ...o });
const login = resp(JSON.stringify({ token: "abc123", user: { id: 7, roles: ["a", "b"] }, ok: true, masked: "Bearer ••••", tricky: "{{API_TOKEN}}", nl: "a\r\nX-Evil: 1" }));
const refs: Refs = (n) => (n === "login" ? login : n === "soon" ? "later" : n === "bin" ? resp("", { binary: true }) : n === "cut" ? resp('{"a":', { truncated: true }) : n === "text" ? resp("plain") : undefined);
const val = (s: string) => resolveRef(s, refs);

test("chain: body fields, JSONPaths, the whole body and headers; anything else isn't a reference", () => {
  assert.deepEqual(val("login.response.body.token"), { value: "abc123" });
  assert.deepEqual(val("login.response.body.$.user.id"), { value: "7" });
  assert.deepEqual(val("login.response.body.user.roles[1]"), { value: "b" });
  assert.deepEqual(val("login.response.body.user.roles"), { value: '["a","b"]' });
  assert.deepEqual(val("login.response.body.ok"), { value: "true" });
  assert.deepEqual(val("text.response.body.*"), { value: "plain" });
  assert.deepEqual(val("text.response.body"), { value: "plain" });
  assert.deepEqual(val("login.response.headers.location"), { value: "/orders/7" });
  assert.deepEqual(val("soon.response.body.token"), { later: true });
  assert.equal(val("baseUrl"), undefined);
  assert.equal(val("login.request.body.x"), undefined);
});

test("chain: what can't be reused says why", () => {
  const err = (s: string) => (val(s) as { error: string }).error;
  assert.match(err("nobody.response.body.x"), /No response from nobody yet/);
  assert.match(err("login.response.body.nope"), /nothing at nope/);
  assert.match(err("login.response.body.masked"), /secret there \(masked\)/);
  assert.match(err("login.response.headers.x-secret"), /secret there/);
  assert.match(err("login.response.body.tricky"), /has \{\{ there/);
  assert.match(err("login.response.headers.etag"), /no etag header/);
  assert.match(err("login.response.headers"), /needs a header name/);
  assert.match(err("bin.response.body.x"), /binary/);
  assert.match(err("cut.response.body.a"), /cut off/);
  assert.match(err("text.response.body.a"), /isn't JSON/);
  assert.match(err("login.response.body.$[?("), /isn't a path/);
});

test("chain: prepare puts response values in like typed text, refuses a broken one, and never fills them in again", () => {
  const r: Req = { ...blankReq(), method: "POST", url: "https://api.example.com/orders/{{login.response.body.user.id}}", headers: [["Authorization", "Bearer {{login.response.body.token}}"]], mode: "json", body: '{"by": "{{login.response.body.token}}"}' };
  const secrets = [{ name: "API_TOKEN", hosts: ["api.example.com"], value: "s3cr3t-value" }];
  const p = prepare(r, {}, secrets, 0, refs);
  assert.ok(p.ok);
  assert.equal(p.url, "https://api.example.com/orders/7");
  assert.deepEqual(p.headers.find(([k]) => k === "Authorization"), ["Authorization", "Bearer abc123"]);
  assert.equal(p.body, '{"by": "abc123"}');

  const bad = prepare({ ...r, headers: [["X", "{{login.response.body.nl}}"]] }, {}, secrets, 0, refs);
  assert.deepEqual(bad, { ok: false, error: "A header's value has a line break in it: nothing was sent." });
  const none = prepare(r, {}, secrets, 0, () => undefined);
  assert.ok(!none.ok && /No response from login yet.*nothing was sent/.test(none.error));
  // A plain variable of the same name wins (it's looked up first).
  assert.equal((prepare({ ...r, headers: [] }, { "login.response.body.user.id": "9" }, secrets, 0, refs) as { url: string }).url, "https://api.example.com/orders/9");
  // Without refs (the agent's send tool), a reference is just a missing value.
  const agent = prepare({ ...r, headers: [], mode: "none", body: "" }, {}, secrets, 0);
  assert.ok(!agent.ok && /No response from login/.test(agent.error));
});
