# wasm-canary

## 1.1.0 — 2026-11-11

- Runs its Rust diff on the server too (core's `Pack.server`, dovre#304): its refresh diffs the page's fixed sample through `ctx.call`, in a thread of its own locally and in a Worker of its own hosted, and the page says how that went. What's typed on the page still stays in the browser. Needs core API 2.1; hosted, run `servers.ts` and add the `SERVER_WASM_CANARY` binding.

## 1.0.2 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.0.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
