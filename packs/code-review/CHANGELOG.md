# code-review

## 1.3.1 — 2026-11-13

- "Logic only" is now a switch, "All changes | Logic only", with the view shown pressed. It sits in the file's header, which stays at the top as you scroll, so which diff you're reading stays in sight.

## 1.3.0 — 2026-11-12

- A file that changed more than formatting, where formatting is part of its diff, gets a "Logic only" button (dovre#301). It shows the diff of the two sides once both are formatted: only what changed besides formatting, highlighted as usual, without line numbers (they'd be of the formatted text). "All changes" brings the diff back. On a PR it comes with the "Only formatting?" check.

## 1.2.0 — 2026-11-12

- Python files (`.py`, `.pyi`) are checked for formatting only too, through Ruff's formatter (WebAssembly, 10 MB, loaded the first time a Python file is checked; dovre#301). A trailing comma doesn't keep a list open, so two layouts of the same code agree.

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
