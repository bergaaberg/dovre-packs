# markdown

## 1.1.3 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.1.2 — 2026-11-09

- Takes `strictOrigin` and core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does. Needs core API 1.27.

## 1.1.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.0 — 2026-11-02

- Checkouts come from core (`ctx.checkouts()` / `ctx.checkout()`, API 1.7): in a pack session only its one checkout is listed (dovre#368).

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
