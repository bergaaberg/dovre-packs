# code-review

## 1.1.0 — 2026-11-11

- Files that changed only formatting are marked "formatting only" and closed (dovre#301). Both sides go through dprint (WebAssembly, in your browser: TypeScript and JavaScript, JSON, TOML, Markdown, CSS) and come out the same. The old side isn't read: it's rebuilt from the new one and the diff.
- On a checkout's own diff every such file is checked. On a PR's, each file has an "Only formatting?" button: it reads that file at the PR's head from the forge, once.
- Runs `git` (when it's on PATH) to read a file at a ref in a checkout.

## 1.0.2 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.0.1 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
