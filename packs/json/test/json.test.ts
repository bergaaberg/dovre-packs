/** JSON tools (`json`): the pure tools, the routes and their guard, and hostile input staying inert. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { testContext } from "dovre/packs/testing.ts";
import { createJsonPack, decode, jsonPack } from "../index.ts";
import { b64Encode, diff, epoch, jwtDecode, keyStep, parse, query, sortKeys } from "../tools.ts";

const H = `<script>alert(1)</script>`;
const J = `javascript:alert(1)`;
const NOW = Date.UTC(2026, 9, 26, 12);

function app() {
  const a = new Hono();
  const ctx = testContext({ page: async (_c, o) => new Response(String(o.body), { headers: { "content-type": "text/html" } }) });
  createJsonPack({ now: () => NOW }).routes!(a as any, ctx);
  return a;
}
const post = (a: Hono, path: string, fields: Record<string, string>, origin = "http://localhost") =>
  a.request(`http://localhost${path}`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

const inert = (out: string) => {
  assert.ok(!out.includes("<script>"), "a script tag got through");
  assert.ok(!/href="javascript:/i.test(out), "a javascript: link got through");
  assert.ok(!/<img/i.test(out), "markup got through");
};

test("json: manifest", () => {
  assert.equal(jsonPack.manifest.id, "json");
  assert.equal(jsonPack.manifest.execution, "any");
  assert.equal(jsonPack.manifest.private, true);
});

test("json: validate says where it breaks, by line and column", () => {
  const r = parse('{\n  "a": 1,\n  "b": [1, 2,]\n}');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual([r.line, r.column], [3, 14]);
  assert.match(r.error, /Trailing comma/);
  const s = parse("{'a': 1}");
  assert.ok(!s.ok && /double quotes/.test(s.error));
  const d = parse("[".repeat(10_000));
  assert.ok(!d.ok && /deep/.test(d.error));
  assert.equal(parse('{"a":[1,{"b":null}],"c":"\\u00e9"}').ok, true);
  assert.equal(parse("1 2").ok, false);
});

test("json: query (JSONPath subset)", () => {
  const v = { store: { book: [{ title: "A", price: 8 }, { title: "B", price: 22, "it's": 1 }], bike: { price: 19 } } } as const;
  const paths = (q: string) => query(v as any, q).matches.map((m) => m.path);
  assert.deepEqual(paths("$.store.book[*].title"), ["$.store.book[0].title", "$.store.book[1].title"]);
  assert.deepEqual(paths("$..price"), ["$.store.book[0].price", "$.store.book[1].price", "$.store.bike.price"]);
  assert.deepEqual(paths("$.store.book[?(@.price > 10)]"), ["$.store.book[1]"]);
  assert.deepEqual(paths("$.store.book[?(@.title == 'A')].price"), ["$.store.book[0].price"]);
  assert.deepEqual(paths("$.store.book[-1]"), ["$.store.book[1]"]);
  assert.deepEqual(paths("$.store.book[0:1]"), ["$.store.book[0]"]);
  // A path the tree shows reads back to the same node.
  const odd = "$.store.book[1]" + keyStep("it's");
  assert.deepEqual(query(v as any, odd).matches.map((m) => m.value), [1]);
  assert.throws(() => query(v as any, "store"), /starts with \$/);
  // Prototype keys are only matched when they're the document's own.
  assert.deepEqual(paths("$.constructor"), []);
});

test("json: diff ignores key order", () => {
  assert.deepEqual(diff({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }).changes, []);
  const r = diff({ a: 1, b: [1, 2], c: { d: 1 } }, { c: { d: 2 }, b: [1], a: 1, e: true }).changes;
  assert.deepEqual(r.map((c) => `${c.kind} ${c.path}`), ["removed $.b[1]", "changed $.c.d", "added $.e"]);
  assert.deepEqual(Object.keys(sortKeys({ b: 1, a: { d: 1, c: 2 } }) as object), ["a", "b"]);
});

test("json: JWT decodes, never verifies, and says when it expires", () => {
  const tok = `${b64Encode('{"alg":"HS256","typ":"JWT"}', true)}.${b64Encode(JSON.stringify({ sub: "me", exp: NOW / 1000 - 60, iat: NOW / 1000 - 3600 }), true)}.c2ln`;
  const r = jwtDecode(`Bearer ${tok}`, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.expired, true);
  assert.deepEqual(r.header, { alg: "HS256", typ: "JWT" });
  assert.deepEqual(r.times.map((t) => t.claim), ["iat", "exp"]);
  assert.ok(!jwtDecode("not.a.jwt", NOW).ok);
  assert.ok(!jwtDecode("abc", NOW).ok);
});

test("json: base64, URL encoding and epoch", () => {
  assert.deepEqual(decode("b64d", b64Encode("hé ✓"), NOW), { op: "text", text: "hé ✓", binary: undefined, json: undefined });
  assert.deepEqual(decode("b64d", b64Encode('{"a":1}', true), NOW), { op: "text", text: '{"a":1}', binary: undefined, json: { a: 1 } });
  assert.equal((decode("b64d", "/w==", NOW) as any).binary, true);
  assert.equal(decode("b64d", "@@@", NOW).op, "error");
  assert.deepEqual(decode("urle", "a b&c=ø", NOW), { op: "text", text: "a%20b%26c%3D%C3%B8" });
  assert.equal((decode("urld", "a%20b+c", NOW) as any).text, "a b c");
  assert.equal(decode("urld", "%E0%A4%A", NOW).op, "error");
  const e = epoch("1793016000");
  assert.ok(e.ok && e.iso === "2026-10-26T12:00:00.000Z" && e.unit === "s");
  const m = epoch("1793016000000");
  assert.ok(m.ok && m.unit === "ms" && m.seconds === 1793016000);
  const d = epoch("2026-10-26T12:00:00Z");
  assert.ok(d.ok && d.seconds === 1793016000);
  assert.ok(!epoch("soon").ok);
});

test("json: routes render each tool", async () => {
  const a = app();
  for (const p of ["/json", "/json/query", "/json/diff", "/json/decode"]) assert.equal((await a.request(`http://localhost${p}`)).status, 200, p);
  const f = await (await post(a, "/json", { input: '{"b":1,"a":[1,2]}', op: "format", sort: "1" })).text();
  assert.match(f, /Valid JSON/);
  assert.ok(f.includes("{\n  &quot;a&quot;") || f.includes('{\n  "a"'), "sorted and indented");
  const m = await (await post(a, "/json", { input: '{"a": [1,2]}', op: "minify" })).text();
  assert.ok(m.includes("{&quot;a&quot;:[1,2]}") || m.includes('{"a":[1,2]}'));
  const t = await (await post(a, "/json", { input: '{"a": {"odd key": [true]}}', op: "tree" })).text();
  assert.match(t, /data-copy="\$\.a\[&#39;odd key&#39;\]\[0\]"/);
  const bad = await (await post(a, "/json", { input: '{\n"a": 1,,\n}', op: "format" })).text();
  assert.match(bad, /line 2, column 8/);
  const q = await (await post(a, "/json/query", { input: '{"xs":[{"id":1},{"id":2}]}', path: "$.xs[*].id" })).text();
  assert.match(q, /\$\.xs\[1\]\.id/);
  const qe = await (await post(a, "/json/query", { input: "{}", path: "nope" })).text();
  assert.match(qe, /Can&#39;t read that path|Can't read that path/);
  const df = await (await post(a, "/json/diff", { a: '{"a":1}', b: '{"a":2}' })).text();
  assert.match(df, /changed/);
  const ep = await (await post(a, "/json/decode", { input: "1793016000", op: "epoch" })).text();
  assert.match(ep, /2026-10-26T12:00:00\.000Z/);
  assert.match(ep, /now/);
});

test("json: posts only from Dovre's own pages", async () => {
  const a = app();
  assert.equal((await post(a, "/json", { input: "{}" }, "https://evil.example")).status, 403);
  const noOrigin = await a.request("http://localhost/json", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "input=%7B%7D" });
  assert.equal(noOrigin.status, 403);
  const crossSite = await a.request("http://localhost/json/decode", { method: "POST", headers: { origin: "http://localhost", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, body: "input=x" });
  assert.equal(crossSite.status, 404);
});

test("json: hostile input stays text on every tool", async () => {
  const a = app();
  const doc = JSON.stringify({ [H]: J, link: J, html: `<img src=x onerror=alert(1)>`, nested: [{ [J]: H }] });
  const outs = [
    await post(a, "/json", { input: doc, op: "format" }),
    await post(a, "/json", { input: doc, op: "tree" }),
    await post(a, "/json", { input: `${H}${J}`, op: "format" }),
    await post(a, "/json/query", { input: doc, path: "$..*" }),
    await post(a, "/json/query", { input: doc, path: `$.${H}` }),
    await post(a, "/json/diff", { a: doc, b: JSON.stringify({ [H]: H }) }),
    await post(a, "/json/diff", { a: H, b: J }),
    await post(a, "/json/decode", { input: `${b64Encode(JSON.stringify({ alg: H }), true)}.${b64Encode(JSON.stringify({ sub: J, exp: H }), true)}.`, op: "jwt" }),
    await post(a, "/json/decode", { input: b64Encode(H), op: "b64d" }),
    await post(a, "/json/decode", { input: H, op: "urld" }),
    await post(a, "/json/decode", { input: H, op: "epoch" }),
  ];
  for (const r of outs) {
    assert.equal(r.status, 200);
    const out = await r.text();
    inert(out);
    assert.ok(out.includes("&lt;script&gt;") || out.includes("javascript:alert(1)") || out.includes("isn"), "the input is shown, escaped");
  }
});
