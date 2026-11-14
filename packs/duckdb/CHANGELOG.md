# duckdb

## 1.2.1 — 2026-11-14

- First run suggests it to analysts, to whoever keeps data in files, and where a checkout has a .duckdb or .parquet file. Nothing changes in what it does.

## 1.2.0 — 2026-11-13

- Runs hosted too (dovre#303). There's no native DuckDB in a Worker, so the hosted page runs DuckDB in your browser (duckdb-wasm 1.33.1-dev57.0, the build wasm-canary proved, on several threads as the pages are cross-origin isolated) over the Parquet, CSV and JSON lines files in an R2 bucket bound as `DUCKDB_FILES`. Each file is a view named after it. DuckDB reads a file with range requests over `/duckdb/r2/<name>`, so only the bytes a query needs leave R2, and rows go to your browser only. Files are added (95 MB at most from the page) and removed there. Locally nothing changes, except that `DUCKDB_SOURCES` is optional now: without it, only the files you add are listed. Needs core API 2.2; hosted, add the binding and run core's R2 path for the modules (`assets.ts --r2`).

## 1.1.0 — 2026-11-10

- A Bino lookup (dovre#262): `duckdb.tables` lists a source's tables and their columns with types, or the ones whose names have some words. Names only, never a row, as the pack stays private. Agent turns get it as a tool too. It reads through the same 24-hour schema cache as the query builder.

## 1.0.4 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.0.3 — 2026-11-09

- Takes `strictOrigin` and core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does. Needs core API 1.27.

## 1.0.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.0.1 — 2026-11-09

- The old `…Crate` export alias is gone: import the `…Pack` name.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
