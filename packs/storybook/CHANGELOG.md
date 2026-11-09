# storybook

## 1.0.0 — 2026-11-09

- Core's Storybook pack moves here (dovre: Storybook out of core). It reads a PR through `ctx.forge().pr`, `.dir` and `.file` (pack API 1.21), not GitHub directly. Builds here go in Dovre's data folder and are served on `STORYBOOK_PORT` (default: the port after Dovre's).
