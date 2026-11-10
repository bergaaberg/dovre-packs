# linear

## 1.3.1 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.3.0 — 2026-11-10

- Core now tells the pack when one of its agent turns ends, so it no longer checks every 10 seconds on a timer of its own. A turn that ended while Dovre was down rings on the next refresh, not only when its issue's page is opened. Needs core API 1.40.

## 1.2.0 — 2026-11-10

- An issue's agent turn (its plan, its try and the draft PR) is kept in the pack's store (`ctx.store.kv`) for a month, so it is still on the issue's page after a restart. Before, a restart forgot it. Needs core API 1.33.

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
