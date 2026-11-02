# Working on dovre-packs issues

Same process as core: follow **[bergaaberg/dovre CONTRIBUTING.md](https://github.com/bergaaberg/dovre/blob/main/CONTRIBUTING.md)** step by step. Claim the issue, work on a branch, run the gate, open a PR that links the issue, and let the arbiter review and merge it. Never commit to `main`, never merge, never deploy.

These rules are specific to this repo:

- **The gate here** is `pnpm check` (typecheck and every `packs/*/test/*.test.ts`). It needs a sibling `../dovre` checkout. If the typecheck fails on `dovre/...` imports, the `node_modules/dovre` link is stale: `ln -sfn "$(cd ../dovre && pwd)" node_modules/dovre`.
- **In a Dovre sandbox** (`/siblings/dovre` exists), the runner has already set up `../dovre` before you start (`setup` in `.dovre/sandbox.json`). If `/dovre` is empty or `pnpm check` can't find `dovre/...`, read `/tmp/dovre-setup.log` and say so in your last message. Don't repoint `node_modules/dovre` somewhere else.
- **One pack per folder:** `packs/<id>/` with an `index.ts` that exports the Pack, and tests in `packs/<id>/test/`. Start from `packs/custom-app/` as a template.
- **The Pack contract** is `PACK_API` (`"major.minor"`) in core's `src/packs/types.ts`; core's docs/ARCHITECTURE.md lists what each minor added. A pack's manifest names the oldest core API it works with as a literal, `api: "1.6"` (never `api: PACK_API`, which claims whatever core it links). Raise it when the pack starts using something a newer minor added. Reads (`nav`, `today`, `brief`, `glance`, `bino`, `routes`) are synchronous and read only the state that `refresh()` filled in. `refresh()` is time-boxed and must fail softly: a down upstream must never break Today or another pack.
- **Hostile-input test:** every pack's tests feed `<script>alert(1)</script>` and `javascript:alert(1)` through its upstream data and check that the rendered HTML is inert. Every external URL goes through `safeUrl()`.
- **Tests never call the real service.** Use a fake API or recorded fixtures, as `packs/gitlab/test/` does.
- **Writes to the pack's own app** re-check the current state, log to the `actions` table and use a two-click `Confirm`, unless the pack explicitly declares the write `oneClick`.
- **Settings and secrets** are declared in the pack's settings list. Never hard-code a token or a real host, and never default to a specific person's instance.
- **Versions and releases:** each pack has its own semver in its manifest (`version: "1.2.0"`) and a `packs/<id>/CHANGELOG.md`, newest first. Any change to a pack outside its `test/` folder is a release:
  1. Add a line for it under `## Unreleased` at the top of the pack's CHANGELOG.md (what changed, for someone updating their copy; say if they must do anything).
  2. Run `pnpm release <id> patch|minor|major` (patch: a fix; minor: something new; major: a copy's settings, routes or data change incompatibly). It moves the Unreleased lines under the new version and writes it into the manifest. Commit that with the change.
  3. `pnpm check` fails while a pack changed since its last tag without a bump, or has lines left under Unreleased.
  4. After the merge, the arbiter runs `pnpm tags --push` on main, which tags `<id>@x.y.z` at the commit that set it. Core's `packs update` follows those tags. Don't tag on your branch: a squash merge drops it.
- New packs start at `version: "0.1.0"` (or `1.0.0` when finished) with a CHANGELOG.md entry for it.
- Add the pack to the table in [README.md](README.md) in the same PR.
- If a pack needs something core doesn't offer, don't work around the contract. Comment on the issue, and open a core issue in `bergaaberg/dovre` describing the hook you need.
