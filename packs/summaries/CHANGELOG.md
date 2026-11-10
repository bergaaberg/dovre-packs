# summaries

## 1.1.1 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.1.0 — 2026-11-10

- Its table is a migration core runs before the pack starts (`Pack.migrations`), not a `CREATE TABLE` of its own on first use. Nothing moves: a database that has the table keeps it. Needs core API 1.35.

## 1.0.2 — 2026-11-09

- Takes the summary keys, `throttle` and `inFiles` and core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does. Needs core API 1.27.

## 1.0.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.0.0 — 2026-11-09

- First release: AI summaries, out of Dovre's core (dovre#466). The model is Dovre's to lend (`ctx.complete`, pack API 1.22), once it's allowed on Settings → Packs → AI summaries. The model setting is core's now (Model for packs, `AI_VIA`).
