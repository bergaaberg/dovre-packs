/** JSON tools (`json`): TOML, jq (vendored, run in the browser) and the dock. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HOSTILE, assertFragment, assertInert, packApp } from "dovre/packs/testing.ts";
import { convert, dockRun, jsonPack, WORKER_PATH } from "../index.ts";
import { fromToml, toToml } from "../convert.ts";
import { JQ_JS_SHA, JQ_WASM_SHA } from "../gen.ts";
import { SCRIPT, WORKER_JS } from "../script.ts";

const sha16 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const vendor = (name: string) => readFileSync(new URL(`../vendor/${name}`, import.meta.url));

test("json: TOML to JSON and back", () => {
  const t = fromToml(`title = "x"\n[owner]\nname = "Kari"\nborn = 1979-05-27T07:32:00Z\n[[items]]\nn = 1\n[[items]]\nn = 2\n`);
  assert.deepEqual(t, { ok: true, value: { title: "x", owner: { name: "Kari", born: "1979-05-27T07:32:00.000Z" }, items: [{ n: 1 }, { n: 2 }] } });
  const bad = fromToml("a = 1\nb = = 2");
  assert.ok(!bad.ok && bad.line === 2 && bad.column === 5, JSON.stringify(bad));
  assert.ok(!fromToml('"__proto__" = { polluted = true }').ok, "a __proto__ key is refused");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(!fromToml("big = 9007199254740993").ok, "an integer JSON can't hold is refused");

  assert.deepEqual(toToml({ a: 1, b: { c: [1, 2] } }), { ok: true, out: "a = 1\n\n[b]\nc = [ 1, 2 ]\n" });
  assert.deepEqual(toToml({ a: { b: [1, null] } }), { ok: false, error: "TOML has no null: $.a.b[1] is null." });
  assert.ok(!toToml([1] as never).ok, "a document is a table");
  assert.deepEqual(convert("toml", '{"a": null}'), { error: "TOML has no null: $.a is null." });
  assert.deepEqual(convert("fromtoml", "a = 1"), { out: '{\n  "a": 1\n}' });
});

test("json: the convert page takes TOML, hostile input inert", async () => {
  const { post } = packApp([jsonPack]);
  const ok = await (await post("/json/convert", { input: `k = "${HOSTILE.replace(/"/g, "'")}"`, op: "fromtoml" })).text();
  assertInert("toml", ok);
  assertFragment("toml", ok);
  const bad = await (await post("/json/convert", { input: `${HOSTILE} = 1`, op: "fromtoml" })).text();
  assert.match(bad, /Input isn&#39;t valid TOML|Input isn't valid TOML/);
  assertInert("toml error", bad);
});

test("json: vendored jq matches gen.ts and runs (here under Node; in the page, in a worker)", async () => {
  assert.equal(sha16(vendor("jq.wasm")), JQ_WASM_SHA, "run build.sh: gen.ts is stale");
  assert.equal(sha16(vendor("jq.js")), JQ_JS_SHA, "run build.sh: gen.ts is stale");
  const { loadJq } = (await import(new URL("../vendor/jq.js", import.meta.url).href)) as { loadJq: (o: { wasmBinary: Uint8Array }) => Promise<{ raw(i: string, q: string, f?: string[]): { stdout: string; stderr: string; exitCode: number }; version: string }> };
  const jq = await loadJq({ wasmBinary: vendor("jq.wasm") });
  assert.equal(jq.version, "jq-1.8.2");
  assert.deepEqual(jq.raw('{"a":[{"n":"x"},{"n":"y"}]}', ".a[].n", ["-r"]), { stdout: "x\ny", stderr: "", exitCode: 0 });
  assert.equal(jq.raw("{}", ".a |").exitCode, 3);
});

test("json: the jq tab names the worker, runtime and module; core serves them; a post without script runs nothing", async () => {
  const { get, post } = packApp([jsonPack]);
  const page = await (await get("/json/jq")).text();
  const at = (k: string) => new RegExp(`data-${k}="([^"]+)"`).exec(page)?.[1];
  assert.equal(at("worker"), WORKER_PATH);
  assert.equal(at("core"), `/assets/files/json.jq.${JQ_JS_SHA}.js`);
  assert.equal(at("wasm"), `/assets/wasm/json.jq.${JQ_WASM_SHA}.wasm`);
  const w = await get(WORKER_PATH);
  assert.equal(w.headers.get("Content-Type"), "text/javascript; charset=utf-8");
  assert.equal(await w.text(), WORKER_JS);
  assert.equal((await get(at("core")!)).headers.get("Content-Type"), "text/javascript; charset=utf-8");
  assert.equal((await get(at("wasm")!)).headers.get("Content-Type"), "application/wasm");

  const posted = await (await post("/json/jq", { input: `{"a": "${HOSTILE.replace(/"/g, "'")}"}`, filter: HOSTILE })).text();
  assert.match(posted, /this page&#39;s script didn&#39;t run|this page's script didn't run/);
  assertInert("jq post", posted);
  assertFragment("jq post", posted);
  assert.equal((await post("/json/jq", { input: "{}" }, { origin: "https://evil.example" })).status, 403);
});

test("json: the jq script and worker", () => {
  assert.match(WORKER_JS, /const FLAGS = new Set\(\["-c", "-r", "-s", "-S", "-n"\]\)/, "only the flags the page offers");
  assert.match(SCRIPT, /setTimeout\(\(\) => \{[\s\S]*stop\(\);[\s\S]*5 seconds/, "a filter that runs on is stopped");
  assert.match(SCRIPT, /textContent = r\.stdout/, "output is text");
  assert.doesNotMatch(SCRIPT + WORKER_JS, /innerHTML|dovre:change/);
  new Function(SCRIPT);
  new Function(WORKER_JS);
});

test("json: the dock", async () => {
  assert.deepEqual(jsonPack.dock!({} as never), { label: "JSON", key: "J", title: "Format JSON, decode a JWT, base64 or a Unix time" });
  assert.deepEqual(dockRun("format", '{"a":1}', 0), { out: '{\n  "a": 1\n}' });
  assert.deepEqual(dockRun("minify", '{ "a" : [1, 2] }', 0), { out: '{"a":[1,2]}' });
  assert.match(dockRun("format", "{", 0).error ?? "", /^Not valid JSON: .*line 1/);
  assert.deepEqual(dockRun("b64d", "eyJhIjoxfQ==", 0), { out: '{\n  "a": 1\n}' });
  assert.match(dockRun("epoch", "0", 0).out ?? "", /^1970-01-01T00:00:00.000Z/);
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ sub: "x", exp: 1 })).toString("base64url"), "sig"].join(".");
  assert.match(dockRun("jwt", jwt, 10_000).out ?? "", /^\(expired; signature not checked\)\n\{\n {2}"header"/);

  const { get, post } = packApp([jsonPack]);
  const dock = await (await get("/json/dock")).text();
  assert.match(dock, /<form method="post" action="\/json\/dock" class="json-dock"/);
  const out = await (await post("/json/dock", { input: `{"x": "${HOSTILE.replace(/"/g, "'")}"}`, op: "format" })).text();
  assertInert("dock", out);
  assertFragment("dock", out);
  assert.match(out, /<pre class="code json-dock-out" data-copy>/);
  const bad = await (await post("/json/dock", { input: HOSTILE, op: "jwt" })).text();
  assertInert("dock error", bad);
});
