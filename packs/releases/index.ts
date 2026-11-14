/**
 * Releases (`releases`): what shipped in your repos over the last 7, 14 or 30 days, by repo: the
 * PRs merged, sorted by the conventional-commit type their titles start with, the releases and
 * tags, and a changelog draft for each repo to copy and edit. Shipped per week on Stats, releases
 * and tags in search. It reads the forge's `shipped` (pack API 2.6) every ten minutes and keeps the
 * answer in memory; nothing is stored, and nothing is written anywhere.
 */
import { type FindItem, type Pack, type PackContext, safeUrl } from "dovre/pack.ts";
import { byRepo, DAY, type Kept, perWeek, READ_DAYS, sinceOf, weeksOf, WINDOWS, within } from "./data.ts";
import { HREF, releasesPage } from "./view.ts";

/** Releases and tags offered in search, the newest. */
const MAX_FINDS = 50;
const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export function createReleasesPack(opts: { now?: () => number } = {}): Pack & { kept(): Kept | undefined } {
  const now = opts.now ?? Date.now;
  let kept: Kept | undefined;
  let reading: Promise<void> | undefined;

  /** One read at a time; a failure keeps the last good answer for a day, with why. */
  const read = (ctx: PackContext): Promise<void> =>
    (reading ??= (async () => {
      const shipped = ctx.forge()?.shipped;
      if (!shipped) return;
      const since = sinceOf(now(), READ_DAYS);
      try {
        kept = { at: now(), since, shipped: await shipped(since) };
      } catch (e) {
        kept = kept?.shipped && now() - kept.at < DAY ? { ...kept, error: message(e) } : { at: now(), since, error: message(e) };
      }
    })().finally(() => (reading = undefined)));

  const daysOf = (ctx: PackContext, asked: string | undefined) => {
    const n = Number(asked ?? ctx.env.RELEASES_DAYS);
    return WINDOWS.includes(n) ? n : WINDOWS[0]!;
  };

  return {
    kept: () => kept,
    manifest: {
      api: "2.6",
      version: "0.1.0",
      id: "releases",
      name: "Releases",
      description: "What shipped in your repos: merged PRs by kind, releases and tags, and a changelog draft per repo",
      domain: "work",
      roles: ["po"],
      execution: "any",
      everyMs: 10 * 60_000,
      settings: [
        {
          key: "RELEASES_DAYS",
          label: "Days shown first",
          help: "The window the page opens on",
          choices: WINDOWS.map((d) => ({ value: String(d), label: `${d} days` })),
          default: String(WINDOWS[0]),
        },
      ],
    },
    async refresh(ctx) {
      await read(ctx);
      ctx.publish(["releases"]);
    },
    nav: () => [{ href: HREF, title: "Releases", icon: "rocket", group: "Code", order: 60 }],
    pages: () => [{ title: "Releases", href: HREF, icon: "↗", about: "What shipped in your repos, and a changelog draft", also: ["shipped", "changelog", "release notes", "tags", "merged"] }],
    routes(app, ctx) {
      app.get(HREF, async (c) => {
        const forge = ctx.forge();
        // The first page after a start reads it itself: hosted, another isolate may have, and core kept its answer.
        if (!kept && forge?.shipped) await read(ctx);
        return ctx.page(c, {
          title: "Releases",
          current: HREF,
          body: releasesPage(kept, { days: daysOf(ctx, c.req.query("days")), repo: c.req.query("repo"), now: now(), silent: forge && !forge.shipped ? forge.name : undefined }),
        });
      });
    },
    finds: () => {
      if (!kept?.shipped) return [];
      const out: (FindItem & { at: string })[] = [
        ...kept.shipped.releases.map((r) => ({ title: `${r.repo} ${r.tag}`, sub: r.name !== r.tag ? `Release · ${r.name}` : "Release", href: safeUrl(r.url), also: ["release"], at: r.at })),
        ...kept.shipped.tags.map((t) => ({ title: `${t.repo} ${t.tag}`, sub: "Tag", href: safeUrl(t.url), also: ["tag", "release"], at: t.at })),
      ];
      return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX_FINDS).map(({ at: _at, ...f }) => ({ ...f, kind: "code" as const }));
    },
    stats: () => {
      if (!kept?.shipped) return [];
      const weeks = weeksOf(now(), 5);
      const s = kept.shipped;
      return [
        {
          id: "shipped",
          title: "Shipped",
          meta: "by week",
          empty: "Nothing shipped in the last five weeks",
          labels: weeks.map((w) => w.slice(5)),
          tips: weeks.map((w) => `Week of ${w}`),
          series: [
            { name: "PRs merged", values: perWeek(s.prs.map((p) => p.mergedAt), weeks) },
            { name: "Releases and tags", values: perWeek([...s.releases, ...s.tags].map((r) => r.at), weeks) },
          ],
          partialLast: true,
        },
      ];
    },
    bino: () => {
      if (!kept?.shipped) return "";
      const week = byRepo(within(kept.shipped, sinceOf(now(), 7)));
      if (!week.length) return "Releases: nothing shipped in the last 7 days.";
      return `Releases, last 7 days: ${week.slice(0, 8).map((r) => `${r.repo} ${r.changes.length} PRs merged, ${r.releases.length + r.tags.length} released`).join("; ")}`;
    },
  };
}

export const releasesPack = createReleasesPack();
