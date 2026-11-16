# releases

## 0.1.1 — 2026-11-16

- The page no longer waits for its first read, which takes four to six seconds: it answers at once with "Reading what shipped" and fills itself in when the read is in. An answer core already kept still shows on the first page. Hosted, the fill-in needs a Dovre with dovre#557.

## 0.1.0 — 2026-11-14

- First release: what shipped in your repos over the last 7, 14 or 30 days, by repo. Merged PRs sorted by the conventional-commit type their titles start with (Breaking, Added, Fixed, Changed, Other, Docs, Upkeep), the releases and the tags with no release, and a changelog draft per repo to copy and edit. Shipped per week on Stats; releases and tags in search. Needs core API 2.6 (`forge().shipped`); with a forge that doesn't say what shipped, the page says so. Idea: dovre-packs#132.
