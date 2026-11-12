# wasm-canary

## 1.2.0 — 2026-11-12

- DuckDB on the page (dovre#304): 36 MB of WebAssembly, over the static assets' 25 MB, so hosted it's served from R2. It loads when Run is pressed and runs the query in your browser. The module and its worker are fetched from jsDelivr at a pinned version (@duckdb/duckdb-wasm 1.33.1-dev57.0) and checked by hash; `duckdb.js` (its browser API with Apache Arrow) is bundled by duck.build.sh. Hosted, needs core's R2 path: an R2 binding `PACK_FILES` and `node ../dovre/src/packs/assets.ts --r2 <bucket>` before deploying.

## 1.1.0 — 2026-11-11

- Runs its Rust diff on the server too (core's `Pack.server`, dovre#304): its refresh diffs the page's fixed sample through `ctx.call`, in a thread of its own locally and in a Worker of its own hosted, and the page says how that went. What's typed on the page still stays in the browser. Needs core API 2.1; hosted, run `servers.ts` and add the `SERVER_WASM_CANARY` binding.

## 1.0.2 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.0.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
