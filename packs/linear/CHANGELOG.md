# linear

## 1.1.2 — 2026-11-09

- Its tests take core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does.

## 1.1.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.0 — 2026-11-09

- Agent turns (needs Dovre with pack API 1.23): once you allow them under Settings → Packs → Linear, each issue opens a page here. **Plan it** reads a repo you pick and answers with a plan; **Try it** works in a sandbox, and its commits become a draft PR when you say so (write kind `linear.try`). A ring tells you when a turn ends.

## 1.0.1 — 2026-11-09

- The old `…Crate` export alias is gone: import the `…Pack` name.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
