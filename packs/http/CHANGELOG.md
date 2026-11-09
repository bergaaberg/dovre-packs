# http

## 1.1.1 — 2026-11-09

- The old `…Crate` export alias is gone: import the `…Pack` name.

## 1.1.0 — 2026-11-02

- Checkouts come from core (`ctx.checkouts()` / `ctx.checkout()`, API 1.7): in a pack session (`node src/run.ts http <checkout>`) only that one is offered (dovre#368).

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
