# tasks

## 0.2.0 — 2026-11-14

- Takes My list's place (pack API 2.3, `replaces: ["todo"]`): while Tasks is on, core's My list is held off, and what reads My list (Bino, search, New work's "Also put it on My list", Slack's saved messages) reads and adds to Tasks through its `list` share, for whoever's asking. My list's items come over in one click, read through My list's share (not its table), steps under their initiative; My list keeps them, so switching Tasks off brings it back as it was. Other packs' proposals for My list show on `/tasks`, hosted too.
- On the pack SDK (`dovre/pack.ts`, `dovre/pack-testing.ts`) only: its tables are `migrations` now, its writes logged with `ctx.logged`, and whom a hook is for read with `ctx.viewer()`.
- A step's parent (`parent_id`) is used: My list's initiatives, one level. The unused `repeat` column is gone from new databases.
- Fixed: snooze and next week on an overdue or due-today task now move it to Later (it was left on Now), and a snoozed task doesn't ring or count as overdue until its day.
- Fixed: search finds my own private tasks again (still only mine).

## 0.1.0 — 2026-11-06

- First release, a prototype: tasks in Dovre's own database (`tasks_items`, `tasks_activity`, made on first use), for one person or a team on a hosted cockpit (private tasks are their maker's alone).
- `/tasks` (Now, Next, Waiting, Inbox, Later; area and person filters; done, start, +1d, next week in one click), `/tasks/T-42` (fields, Markdown notes, links, activity and comments) and `/tasks/review` (the weekly review).
- A quick-add line read as you type: `#area`, `!high`/`!low`, `@person`, a date at the end (do on) or `due <date>` anywhere, `waiting:` first. Dates as core's My list reads them, Norwegian too.
- A Today card, a dock (T), needs for overdue tasks (ring `tasks-overdue`, off until switched on), Bino's lines, lookups (`list`, `search`, `task`) and acts (`create`, `status`, `schedule`, `edit`, `comment`), shared tasks only.
- Copies My list's items in one click (they stay on My list), and shows other packs' My list proposals.
