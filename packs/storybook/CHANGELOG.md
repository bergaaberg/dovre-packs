# storybook

## 1.0.5 — 2026-11-09

- Takes `strictOrigin`, `later` and `Reading` and core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does. Needs core API 1.27.

## 1.0.4 — 2026-11-09

- Runs git, pnpm and npm through `ctx.run`, not core's `runOff` and `findTool`, and names them in its manifest (`binaries`). Builds move to the pack's own folder, `packs/storybook` next to the database: the ones in `data/storybook` are built again when asked for, and that folder can be deleted. Needs core API 1.26.

## 1.0.3 — 2026-11-09

- Logs a build with `ctx.logged`, not core's `logAction`. Same name in the actions log. Needs core API 1.25.

## 1.0.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.0.1 — 2026-11-09

- The old `…Crate` export alias is gone: import the `…Pack` name.

## 1.0.0 — 2026-11-09

- Core's Storybook pack moves here (dovre: Storybook out of core). It reads a PR through `ctx.forge().pr`, `.dir` and `.file` (pack API 1.21), not GitHub directly. Builds here go in Dovre's data folder and are served on `STORYBOOK_PORT` (default: the port after Dovre's).
