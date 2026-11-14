# slack

## 1.1.6 — 2026-11-14

- First run suggests it to whoever is reached on Slack. Nothing changes in what it does.

## 1.1.5 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.1.4 — 2026-11-10

- Needs core API 1.27 (it declared 1.24): It uses the `D1` type, which core's SDK gained at 1.27, so it says so. Nothing changes in what it does.

## 1.1.3 — 2026-11-09

- Its tests take core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does.

## 1.1.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.1 — 2026-11-09

- Its pulse is `pulse` (`PulseFeed`), core's name for it; `avatar` was the old one.
- The old `…Crate` export alias is gone: import the `…Pack` name.

## 1.1.0 — 2026-11-09

- A saved message's Add goes on My list through the todo pack's `list` share (API 1.11, `uses: ["todo"]`) and lands on the item. With todo off, nothing is added.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
