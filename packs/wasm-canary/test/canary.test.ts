import assert from "node:assert/strict";
import { test } from "node:test";
import { assertInert, packApp } from "dovre/packs/testing.ts";
import { createWasmCanaryPack, diffWasm } from "../index.ts";
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
