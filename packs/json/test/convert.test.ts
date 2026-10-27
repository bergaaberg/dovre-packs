/** JSON tools (`json`): conversions (YAML both ways, TypeScript types, JSON Schema) and their route. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { testContext } from "dovre/packs/testing.ts";
import { convert, createJsonPack } from "../index.ts";
import { fromYaml, shapeOf, singular, toJsonSchema, toTypeScript, toYaml } from "../convert.ts";

const H = `<script>alert(1)</script>`;
const J = `javascript:alert(1)`;

function app() {
  const a = new Hono();
  const ctx = testContext({ page: async (_c, o) => new Response(String(o.body), { headers: { "content-type": "text/html" } }) });
  createJsonPack().routes!(a as any, ctx);
  return a;
}
const post = (a: Hono, fields: Record<string, string>, origin = "http://localhost") =>
  a.request("http://localhost/json/convert", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

test("convert: JSON → YAML → JSON round-trips", () => {
  const v = { name: "dovre", tags: ["a", "b"], n: 1.5, ok: true, none: null, nested: { "odd key": [1, { x: "yes" }] }, quoted: "123" };
  const y = toYaml(v);
  assert.match(y, /^name: dovre$/m);
  assert.match(y, /quoted: "123"/);
  const back = fromYaml(y);
  assert.ok(back.ok);
  assert.deepEqual(back.ok && back.value, v);
});

test("convert: YAML errors say where, and the risky bits are refused", () => {
  const bad = fromYaml("a: 1\nb: [1, 2\nc: 3\n");
  assert.ok(!bad.ok && bad.line >= 2, "an unclosed list is an error with a line");
  const dup = fromYaml("a: 1\na: 2\n");
  assert.ok(!dup.ok, "duplicate keys are refused");
  // A billion laughs: aliases of aliases.
  const lol = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
  for (let i = 1; i < 10; i++) lol.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(10).fill(`*${String.fromCharCode(96 + i)}`).join(", ")}]`);
  assert.ok(!fromYaml(lol.join("\n")).ok, "alias bombs are refused");
  // The core schema: no dates, no custom tags turning into objects.
  const plain = fromYaml("when: 2026-10-27\nnum: 0x1F\n");
  assert.deepEqual(plain.ok && plain.value, { when: "2026-10-27", num: 31 });
  const tagged = fromYaml("x: !!js/function 'alert(1)'\ny: !foo bar\n");
  assert.deepEqual(tagged.ok && tagged.value, { x: "alert(1)", y: "bar" }, "unknown tags stay plain strings");
  const deep = fromYaml("[".repeat(600) + "]".repeat(600));
  assert.ok(!deep.ok);
});

test("convert: TypeScript types merge array items and mark missing keys optional", () => {
  const ts = toTypeScript(shapeOf({ users: [{ id: 1, name: "a", tags: ["x"] }, { id: 2, email: null, name: "b" }], total: 2, "odd-key": true }));
  assert.match(ts, /export interface Root \{\n  users: User\[\];\n  total: number;\n  "odd-key": boolean;\n\}/);
  assert.match(ts, /export interface User \{\n  id: number;\n  name: string;\n  tags\?: string\[\];\n  email\?: null;\n\}/);
  assert.equal(toTypeScript(shapeOf([1, "a"])), "export type Root = (string | number)[];\n");
  assert.match(toTypeScript(shapeOf([{ a: 1 }]), "Event"), /^export type Event = EventItem\[\];\n\nexport interface EventItem \{\n  a: number;\n\}/);
  assert.equal(toTypeScript(shapeOf([])), "export type Root = unknown[];\n");
  assert.match(toTypeScript(shapeOf({})), /export type Root = Record<string, never>;/);
  // Two different shapes under one name each get their own.
  assert.match(toTypeScript(shapeOf({ a: { item: { x: 1 } }, b: { item: { y: "" } } })), /interface Item2/);
  assert.deepEqual(["users", "entries", "status", "data"].map(singular), ["user", "entry", "statusItem", "dataItem"]);
});

test("convert: JSON Schema from a sample", () => {
  const s = toJsonSchema(shapeOf({ id: 1, price: 2.5, xs: [{ a: "x" }, { a: "y", b: true }], maybe: null }));
  assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(s.type, "object");
  assert.deepEqual(s.required, ["id", "price", "xs", "maybe"]);
  const p = s.properties as any;
  assert.equal(p.id.type, "integer");
  assert.equal(p.price.type, "number");
  assert.equal(p.maybe.type, "null");
  assert.deepEqual(p.xs.items.required, ["a"]);
  assert.equal(p.xs.items.properties.b.type, "boolean");
  assert.deepEqual(toJsonSchema(shapeOf([1, 2.5, null])).items, { type: ["number", "null"] });
});

test("convert: the route converts, guards its origin, and keeps hostile input inert", async () => {
  const a = app();
  assert.equal((await a.request("http://localhost/json/convert")).status, 200);
  const y = await (await post(a, { input: '{"a":[1,2]}', op: "yaml" })).text();
  assert.match(y, /a:\n  - 1\n  - 2/);
  const j = await (await post(a, { input: "a:\n  - 1\n", op: "json" })).text();
  assert.match(j, /&quot;a&quot;|"a"/);
  const ts = await (await post(a, { input: '{"a":1}', op: "ts", root: "Thing" })).text();
  assert.match(ts, /interface Thing/);
  assert.match(await (await post(a, { input: "{", op: "schema" })).text(), /isn&#39;t valid JSON|isn't valid JSON/);
  assert.match(await (await post(a, { input: "a: [", op: "json" })).text(), /isn&#39;t valid YAML|isn't valid YAML/);
  assert.equal((await post(a, { input: "{}" }, "https://evil.example")).status, 403);

  const doc = JSON.stringify({ [H]: J, nested: [{ [J]: H }] });
  const cases: Record<string, string>[] = [
    { input: doc, op: "yaml" },
    { input: doc, op: "ts", root: H },
    { input: doc, op: "schema" },
    { input: `${H}: ${J}\n`, op: "json" },
    { input: H, op: "json" },
    { input: H, op: "ts" },
  ];
  for (const f of cases) {
    const r = await post(a, f);
    assert.equal(r.status, 200);
    const out = await r.text();
    assert.ok(!out.includes("<script>"), "a script tag got through");
    assert.ok(!/href="javascript:/i.test(out), "a javascript: link got through");
  }
  assert.ok("out" in convert("ts", '{"a":1}')!);
});
