# gitlab

## 1.0.3 — 2026-11-10

- Reads the owners setting with the SDK's `owners.of`, not core's `ownersOf`. Nothing changes in what it does. Needs core API 1.32.

## 1.0.2 — 2026-11-09

- Takes core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does.

## 1.0.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
