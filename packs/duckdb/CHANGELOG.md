# duckdb

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
