// Writes gen.ts from vendor/ and engine.js (build.sh runs it; test/gen.test.ts checks gen.ts is current).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const GRAMMARS = ["typescript", "tsx", "javascript", "go", "rust", "python", "json", "yaml", "toml", "css", "csharp"];

const here = (f) => new URL(f, import.meta.url);
const sha16 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

export function genSource() {
  const sha = { runtime: sha16(readFileSync(here("vendor/runtime.wasm"))) };
  const queries = {};
  for (const g of GRAMMARS) {
    sha[g] = sha16(readFileSync(here(`vendor/${g}.wasm`)));
    queries[g] = readFileSync(here(`vendor/${g}.scm`), "utf8");
  }
  const runtime = readFileSync(here("vendor/web-tree-sitter.js"), "utf8").replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n");
  const engine = readFileSync(here("engine.js"), "utf8");
  return `// Built by build.sh (gen.mjs) from vendor/ and engine.js. Don't edit.
/** The first 16 hex digits of each module's SHA-256 (core's WasmFile). */
export const SHA: Record<string, string> = ${JSON.stringify(sha, null, 2)};
/** Each grammar's highlight queries (tree-sitter's highlights.scm). */
export const QUERIES: Record<string, string> = ${JSON.stringify(queries)};
/** web-tree-sitter's ES module, served to the page. */
export const RUNTIME_JS = ${JSON.stringify(runtime)};
/** engine.js, served to the page. */
export const ENGINE_JS = ${JSON.stringify(engine)};
`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const src = genSource();
  writeFileSync(here("gen.ts"), src);
  console.log(`gen.ts: ${(src.length / 1024).toFixed(0)} KB`);
}
