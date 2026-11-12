import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assertInert, packApp, serverOf, testContext } from "dovre/pack-testing.ts";
import { createWasmCanaryPack, diffWasm } from "../index.ts";
import { serverText } from "../server.build.ts";
import { DIFF_GLUE, DIFF_SHA256 } from "../diff.wasm.ts";

/** What the page's script does, under Node: the same glue, the same module. */
function diffIn(a: string, b: string): string[] {
  const bindgen = new Function(`${DIFF_GLUE}\nreturn wasm_bindgen;`)() as { initSync(o: { module: BufferSource }): unknown; diff(a: string, b: string): string };
  bindgen.initSync({ module: diffWasm() as Uint8Array<ArrayBuffer> });
  return bindgen.diff(a, b).split("\n").slice(0, -1);
}

test("the Rust diff, as WebAssembly: same, removed and added lines, in order; UTF-8 and empty input survive", () => {
  assert.deepEqual(diffIn("a\nb\nc\n", "a\nc\nd\n"), [" a", "-b", " c", "+d"]);
  assert.deepEqual(diffIn("fjell: Dovre ⛰\n", "fjell: Dovrefjell ⛰\n"), ["-fjell: Dovre ⛰", "+fjell: Dovrefjell ⛰"]);
  assert.deepEqual(diffIn("", "x"), ["+x"], "a last line without a newline");
  assert.deepEqual(diffIn("", ""), []);
});

test("the canary's page: its module is served as WebAssembly, the page names it, and pages may compile it", async () => {
  const { get } = packApp([createWasmCanaryPack()]);
  const res = await get("/wasm-canary");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /'wasm-unsafe-eval'/);
  const page = await res.text();
  assertInert("canary page", page);
  const path = page.match(/data-wasm="([^"]+)"/)?.[1];
  assert.equal(path, `/assets/wasm/wasm-canary.diff.${DIFF_SHA256}.wasm`, "a file kept out of the bundle, at the hash build.sh wrote");
  const wasm = await get(path!);
  assert.equal(wasm.headers.get("Content-Type"), "application/wasm");
  assert.ok(WebAssembly.validate(new Uint8Array(await wasm.arrayBuffer())));
});

test("on the server: the same Rust diff through ctx.call, in a thread of its own; server.js is its glue and handler as built", async () => {
  assert.equal(readFileSync(new URL("../server.js", import.meta.url), "utf8"), serverText(), "run server.build.ts after changing server.handler.js");
  const pack = createWasmCanaryPack();
  const call = serverOf(pack);
  try {
    assert.deepEqual(await call("diff", { old: "a\nb\n", new: "a\nc\n" }), { ok: true, value: { lines: [" a", "-b", "+c"] } });
    const ctx = testContext({ call });
    await pack.refresh!(ctx);
    assert.deepEqual({ ...((await ctx.store.kv.get("server-run")) as object), at: 0 }, { ok: true, lines: 6, hosted: false, at: 0 }, "the sample: 4 lines kept, 2 added");
  } finally {
    await call.stop();
  }
});

test("the page says how the server diff went: not yet, or its error", async () => {
  const { get } = packApp([createWasmCanaryPack()]);
  assert.match(await (await get("/wasm-canary")).text(), /On the server: not run yet/);
  const pack = createWasmCanaryPack();
  const ctx = testContext({ call: async () => ({ ok: false, error: "spin took over 5 s; stopped" }) });
  await pack.refresh!(ctx);
  assert.equal(((await ctx.store.kv.get("server-run")) as { error: string }).error, "spin took over 5 s; stopped");
});

test("DuckDB: the page names its module (over 25 MB, a pinned release) and its files; duckdb.js is the bundle duck.build.sh hashed", async () => {
  const { createHash } = await import("node:crypto");
  const { DUCK_JS_SHA256, DUCK_WASM_SHA256, DUCK_WASM_URL, DUCK_WORKER_URL } = await import("../duck.ts");
  const { duckJs } = await import("../index.ts");
  assert.equal(createHash("sha256").update(duckJs()).digest("hex").slice(0, 16), DUCK_JS_SHA256, "run duck.build.sh");
  for (const u of [DUCK_WASM_URL, DUCK_WORKER_URL]) assert.match(u, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@duckdb\/duckdb-wasm@\d+\.\d+\.\d+-dev\d+\.0\/dist\//, "a pinned version");
  const { get } = packApp([createWasmCanaryPack()]);
  const page = await (await get("/wasm-canary")).text();
  assertInert("canary page", page);
  assert.match(page, new RegExp(`id="wc-duck" class="wc-duck" data-wasm="/assets/wasm/wasm-canary\\.duckdb\\.${DUCK_WASM_SHA256}\\.wasm"`));
  assert.match(page, /<button type="button" class="btn sm wc-run" disabled>Run<\/button>/, "off until its script runs");
  const js = await get(`/assets/files/wasm-canary.duckdb.${DUCK_JS_SHA256}.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /^\/\* @duckdb\/duckdb-wasm .*\(MIT\)/);
});
