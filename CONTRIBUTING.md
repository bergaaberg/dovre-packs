# Working on dovre-packs issues

Same process as core: follow **[bergaaberg/dovre CONTRIBUTING.md](https://github.com/bergaaberg/dovre/blob/main/CONTRIBUTING.md)** step by step. Claim the issue, work on a branch, run the gate, open a PR that links the issue, and let the arbiter review and merge it. Never commit to `main`, never merge, never deploy.

These rules are specific to this repo:

- **The gate here** is `pnpm check` (typecheck and every `packs/*/test/*.test.ts`). It needs a sibling `../dovre` checkout. If the typecheck fails on `dovre/...` imports, the `node_modules/dovre` link is stale: `ln -sfn "$(cd ../dovre && pwd)" node_modules/dovre`.
- **One pack per folder:** `packs/<id>/` with an `index.ts` that exports the Pack, and tests in `packs/<id>/test/`. Start from `packs/custom-app/` as a template.
- **The Pack contract** is `PACK_API = 1` in core's `src/packs/types.ts`. Reads (`nav`, `today`, `brief`, `glance`, `bino`, `routes`) are synchronous and read only the state that `refresh()` filled in. `refresh()` is time-boxed and must fail softly: a down upstream must never break Today or another pack.
- **Hostile-input test:** every pack's tests feed `<script>alert(1)</script>` and `javascript:alert(1)` through its upstream data and check that the rendered HTML is inert. Every external URL goes through `safeUrl()`.
- **Tests never call the real service.** Use a fake API or recorded fixtures, as `packs/gitlab/test/` does.
- **Writes to the pack's own app** re-check the current state, log to the `actions` table and use a two-click `Confirm`, unless the pack explicitly declares the write `oneClick`.
- **Settings and secrets** are declared in the pack's settings list. Never hard-code a token or a real host, and never default to a specific person's instance.
- Add the pack to the table in [README.md](README.md) in the same PR.
- If a pack needs something core doesn't offer, don't work around the contract. Comment on the issue, and open a core issue in `bergaaberg/dovre` describing the hook you need.
