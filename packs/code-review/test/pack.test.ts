import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { packApp } from "dovre/packs/testing.ts";
import { codeReviewPack, ENGINE_PATH, RUNTIME_PATH } from "../index.ts";
import { ENGINE_JS, QUERIES, SHA } from "../gen.ts";
// @ts-expect-error: plain JS, no types
import { GRAMMARS, genSource } from "../gen.mjs";

test("gen.ts is what build.sh writes from vendor/ and engine.js now (run build.sh after editing either)", () => {
  assert.equal(readFileSync(new URL("../gen.ts", import.meta.url), "utf8"), genSource());
  assert.equal(ENGINE_JS, readFileSync(new URL("../engine.js", import.meta.url), "utf8"));
});

test("each module is a file kept out of the bundle, its declared hash its bytes'; load reads it", async () => {
  const wasm = codeReviewPack.wasm!;
  assert.deepEqual(Object.keys(wasm).sort(), ["runtime", ...GRAMMARS].sort());
  for (const [name, mod] of Object.entries(wasm)) {
    assert.ok(!(mod instanceof Uint8Array), `${name}: a file, not bytes in the bundle`);
    const bytes = await mod.load();
    assert.equal(createHash("sha256").update(bytes).digest("hex").slice(0, 16), mod.sha256, name);
    assert.equal(mod.sha256, SHA[name]);
  }
});

test("the manifest names the runtime and every grammar where core serves them; the scripts and queries at hashed paths", async () => {
  const { get } = packApp([codeReviewPack]);
  const res = await get("/code-review/langs.json");
  assert.equal(res.status, 200);
  const m = (await res.json()) as { runtimeJs: string; runtimeWasm: string; langs: Record<string, { wasm: string; query: string }> };
  assert.equal(m.runtimeJs, RUNTIME_PATH);
  assert.match(m.runtimeWasm, new RegExp(`^/assets/wasm/code-review\\.runtime\\.${SHA.runtime}\\.wasm$`));
  assert.deepEqual(Object.keys(m.langs).sort(), [...GRAMMARS].sort());
  const ts = m.langs.typescript!;
  assert.match(ts.wasm, new RegExp(`code-review\\.typescript\\.${SHA.typescript}\\.wasm$`));
  const wasm = await get(ts.wasm);
  assert.equal(wasm.headers.get("Content-Type"), "application/wasm");
  assert.ok(WebAssembly.validate(new Uint8Array(await wasm.arrayBuffer())));
  const q = await get(ts.query);
  assert.equal(await q.text(), QUERIES.typescript);
  assert.match(q.headers.get("Cache-Control") ?? "", /immutable/);
  for (const p of [ENGINE_PATH, RUNTIME_PATH]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("Content-Type") ?? "", /javascript/);
  }
});

test("hostile paths: a wrong hash, another file, a traversal or an inherited key aren't served", async () => {
  const { get } = packApp([codeReviewPack]);
  for (const p of ["/code-review/js/engine.0.js", "/code-review/js/..%2F..%2Fpackage.json", "/code-review/q/typescript.0.scm", "/code-review/q/constructor.x.scm", "/code-review/q/__proto__.scm", "/code-review/q/..%2Fgen.ts"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("its script only loads the engine where a diff is, and names nothing from the page", () => {
  const s = codeReviewPack.script!;
  assert.match(s, /table\.diff/);
  assert.ok(s.includes(JSON.stringify(ENGINE_PATH)));
  assert.doesNotMatch(s, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.doesNotMatch(ENGINE_JS, /innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/, "the engine writes text only");
});
