# jira

## 1.3.2 — 2026-11-14

- Settings shows the defaults beside their fields: the JQL for Mine, and the minutes between reads through the MCP, now a number field from 2 to 240 (pack API 2.5).

## 1.3.1 — 2026-11-14

- First run suggests it to whoever keeps tasks in Jira. Nothing changes in what it does.

## 1.3.0 — 2026-11-10

- Bino lookups (dovre#262), with `JIRA_VIA=rest`: `jira.issue` reads one issue by key (status, type, priority, assignee, description and the latest five comments, cut to size), and `jira.search` finds issues by words in their summary (15 at most). Agent turns get them as tools too. Not through the MCP: a job there takes longer than a lookup may.

## 1.2.1 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does.

## 1.2.0 — 2026-11-10

- `JIRA_VIA=mcp` goes through core's MCP calls (`ctx.mcp`), not a Claude Code the pack starts itself. **After updating, tick "MCP calls" on Settings → Packs → Jira**: until then the page says so and nothing is read. Each job now counts against the pack's dollars a day there.
- A project's create screen is read in two jobs (its work types, then their fields), so the first form of a project takes a little longer.
- A create the agent made with other arguments than asked says to check Jira before trying again.
- Needs core API 1.34. With this, the pack imports core only through the SDK.

## 1.1.6 — 2026-11-10

- Keeps its last answer over MCP in the pack's store (`ctx.store.kv`), not a file of its own through core's `keptFile`. `data/jira-kept.json` is no longer read and can be deleted: the first start after this shows "waiting" until the first read. Needs core API 1.33.

## 1.1.5 — 2026-11-09

- Takes core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does.

## 1.1.4 — 2026-11-09

- Its own `Ran` type, not core's `dovre/spawn.ts`. Nothing changes in what it does.

## 1.1.3 — 2026-11-09

- Logs a created ticket with `ctx.logged`, as `jira.ticket-create` (was `ticket.create`); older rows still read "Created a Jira ticket". Needs core API 1.25.

## 1.1.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.1 — 2026-11-09

- The old `…Crate` export alias is gone: import the `…Pack` name.

## 1.1.0 — 2026-11-09

- Follows core's Nov 8 moves (API 1.11). A created ticket goes on My list through the todo pack's `list` share (`uses: ["todo"]`), and the preview offers it only while that pack is on. The kept-file store comes from `dovre/kept.ts`. The form helpers live in the pack.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
