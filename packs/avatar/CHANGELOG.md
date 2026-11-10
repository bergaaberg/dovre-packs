# avatar

## 1.1.4 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does. Its manifest now says `db: "raw"`, shown on its card: it keeps its own tables in Dovre's database.

## 1.1.3 — 2026-11-10

- Needs core API 1.28 (it declared 1.27): Its tests use what core's testing door gained at 1.28 (`assertStyled`, `activePacks`, `ON_JS`, `setWhen`, `resetWhen`), so it says so. Nothing changes in what it does.

## 1.1.2 — 2026-11-09

- Takes `needsOf`, `hourAt` and `hashOf` and core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does. Needs core API 1.27.

## 1.1.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.0 — 2026-11-08

- My list's "doing" count comes from the todo pack's `list` share (API 1.11, `uses: ["todo"]`), not core's old store, which moved into that pack (dovre#393). With todo off it counts none.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
