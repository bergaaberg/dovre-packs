# topo

## 1.1.4 — 2026-11-09

- Lists checkouts only through `ctx.checkouts()`, without its own fallback into core's internals. Nothing changes on a core that runs it.

## 1.1.3 — 2026-11-09

- Takes `strictOrigin` and core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does. Needs core API 1.27.

## 1.1.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.1 — 2026-11-08

- Tests follow core: New work's page moved into the issues pack (dovre#402), and a proposal's `text` is optional now that one can carry `files` (API 1.17). The pack itself is unchanged.

## 1.1.0 — 2026-11-02

- Checkouts come from core (`ctx.checkouts()`, API 1.7): in a pack session only its one checkout is scanned. The scan now reads git checkouts only, as the checkout list already did (dovre#368).

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
