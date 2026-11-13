// Writes gen.ts from vendor/ and engine.js (build.sh runs it; test/gen.test.ts checks gen.ts is current).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const GRAMMARS = ["typescript", "tsx", "javascript", "go", "rust", "python", "json", "yaml", "toml", "css", "csharp"];
/** Formatters (vendor/fmt-<name>.wasm), served as `fmt-<name>`: dprint plugins, and Ruff for Python. */
export const FORMATTERS = ["typescript", "json", "toml", "markdown", "css", "python"];

const here = (f) => new URL(f, import.meta.url);
const sha16 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

export function genSource() {
  const sha = { runtime: sha16(readFileSync(here("vendor/runtime.wasm"))) };
  const queries = {};
  const tags = {};
  for (const g of GRAMMARS) {
    sha[g] = sha16(readFileSync(here(`vendor/${g}.wasm`)));
    queries[g] = readFileSync(here(`vendor/${g}.scm`), "utf8");
    if (existsSync(here(`vendor/${g}.tags.scm`))) tags[g] = readFileSync(here(`vendor/${g}.tags.scm`), "utf8");
  }
  for (const f of FORMATTERS) sha[`fmt-${f}`] = sha16(readFileSync(here(`vendor/fmt-${f}.wasm`)));
  const engine = readFileSync(here("engine.js"), "utf8");
  return `// Built by build.sh (gen.mjs) from vendor/ and engine.js. Don't edit.
/** The first 16 hex digits of each module's SHA-256 (core's WasmFile). */
export const SHA: Record<string, string> = ${JSON.stringify(sha, null, 2)};
/** The first 16 hex digits of web-tree-sitter.js's SHA-256 (core's Pack.files). */
export const RUNTIME_JS_SHA = ${JSON.stringify(sha16(readFileSync(here("vendor/web-tree-sitter.js"))))};
/** The first 16 hex digits of dprint.js's SHA-256 (dprint's host, bundled). */
export const DPRINT_JS_SHA = ${JSON.stringify(sha16(readFileSync(here("vendor/dprint.js"))))};
/** The first 16 hex digits of ruff.js's SHA-256 (Ruff's wasm-bindgen glue). */
export const RUFF_JS_SHA = ${JSON.stringify(sha16(readFileSync(here("vendor/ruff.js"))))};
/** Each grammar's highlight queries (tree-sitter's highlights.scm). */
export const QUERIES: Record<string, string> = ${JSON.stringify(queries)};
/** Each grammar's definition queries (tags.scm, and ours from tags/), where it has them. */
export const TAGS: Record<string, string> = ${JSON.stringify(tags)};
/** engine.js, served to the page. */
export const ENGINE_JS = ${JSON.stringify(engine)};
`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const src = genSource();
  writeFileSync(here("gen.ts"), src);
  console.log(`gen.ts: ${(src.length / 1024).toFixed(0)} KB`);
}
