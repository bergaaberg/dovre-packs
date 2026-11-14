/** Releases' page: what shipped in a window, every repo or one of them with its changelog draft. */
import { html } from "hono/html";
import { Empty, format, type Html, Item, List, Notice, PageHeader, Panel, Pill, safeUrl, Stat, Stats, Tabs } from "dovre/pack.ts";
import { byRepo, type Change, dayOf, draftOf, type Kept, KINDS, type RepoShipped, sinceOf, tally, WINDOWS, within } from "./data.ts";

export const HREF = "/releases";
/** Rows drawn of one list of PRs; the rest is a count. */
const MAX_ROWS = 100;

const day = (at: string) => format.shortDay(at.slice(0, 10));
const hrefOf = (days: number, repo?: string) => `${HREF}?days=${days}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const capped = <T>(rows: T[], draw: (row: T) => Html, max = MAX_ROWS): Html =>
  html`${List(rows.slice(0, max).map(draw))}${rows.length > max ? html`<p class="t3">and ${rows.length - max} more</p>` : ""}`;

const releasedRows = (r: Pick<RepoShipped, "releases" | "tags">, withRepo: boolean, max: number): Html | "" => {
  const rows = [...r.releases.map((x) => ({ ...x, release: true })), ...r.tags.map((x) => ({ ...x, name: x.tag, pre: undefined, release: false }))].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (!rows.length) return "";
  return capped(rows, (x) =>
    Item({
      href: safeUrl(x.url),
      title: html`${withRepo ? html`<span class="t3">${x.repo}</span> ` : ""}<strong>${x.tag}</strong>${x.pre ? html` ${Pill({ children: "prerelease" })}` : ""}`,
      line: x.release ? (x.name !== x.tag ? x.name : "Release") : "Tag",
      trail: day(x.at),
    }),
    max,
  );
};

const changeRow = (c: Change): Html =>
  Item({ href: safeUrl(c.pr.url), title: c.text, line: `${c.scope ? `${c.scope} · ` : ""}#${c.pr.number}${c.pr.author ? ` · ${c.pr.author}` : ""}`, trail: day(c.pr.mergedAt) });

function overview(repos: RepoShipped[], days: number): Html {
  const prs = repos.reduce((n, r) => n + r.changes.length, 0);
  const releases = repos.reduce((n, r) => n + r.releases.length, 0);
  const tags = repos.reduce((n, r) => n + r.tags.length, 0);
  const released = { releases: repos.flatMap((r) => r.releases), tags: repos.flatMap((r) => r.tags) };
  return html`${Stats(html`${Stat({ label: "PRs merged", value: format.count(prs) })}${Stat({ label: "Releases", value: format.count(releases) })}${Stat({ label: "Tags", value: format.count(tags) })}${Stat({ label: "Repos that shipped", value: format.count(repos.length) })}`)}
${Panel({
  title: "By repo",
  meta: `last ${days} days`,
  flush: true,
  children: List(
    repos.map((r) =>
      Item({
        href: hrefOf(days, r.repo),
        title: html`<strong>${r.repo}</strong>`,
        line: tally(r.changes) || "No PRs merged",
        trail: [r.changes.length ? plural(r.changes.length, "PR") : "", r.releases.length ? plural(r.releases.length, "release") : "", r.tags.length ? plural(r.tags.length, "tag") : ""].filter(Boolean).join(" · "),
      }),
    ),
  ),
})}
${released.releases.length + released.tags.length ? Panel({ title: "Released", meta: "releases and tags, newest first", flush: true, children: releasedRows(released, true, 12) }) : ""}`;
}

function repoView(r: RepoShipped, o: { since: string; until: string }): Html {
  const left = KINDS.filter((k) => !k.draft).map((k) => [r.changes.filter((c) => c.kind === k.id).length, k.word] as const).filter(([n]) => n);
  return html`${r.releases.length + r.tags.length ? Panel({ title: "Released", flush: true, children: releasedRows(r, false, 30) }) : ""}
${KINDS.map((k) => {
  const of = r.changes.filter((c) => c.kind === k.id);
  return of.length ? Panel({ title: k.title, meta: plural(of.length, "PR"), flush: true, children: capped(of, changeRow) }) : "";
})}
${Panel({
  title: "Changelog draft",
  meta: left.length ? `Markdown to copy and edit · left out: ${left.map(([n, word]) => `${n} ${word}`).join(", ")}` : "Markdown to copy and edit",
  children: html`<textarea class="mono" rows="14" readonly aria-label="Changelog draft for ${r.repo}">${draftOf(r, o)}</textarea>`,
})}`;
}

export type PageAsk = { days: number; repo?: string; now: number; /** The forge's name when it doesn't say what shipped. */ silent?: string };

export function releasesPage(k: Kept | undefined, o: PageAsk): Html {
  const days = WINDOWS.includes(o.days) ? o.days : WINDOWS[0]!;
  const since = sinceOf(o.now, days);
  const repos = k?.shipped ? byRepo(within(k.shipped, since)) : [];
  const one = o.repo ? repos.find((r) => r.repo.toLowerCase() === o.repo!.toLowerCase()) : undefined;
  const header = PageHeader({
    title: one ? one.repo : "Releases",
    sub: one ? `What shipped since ${format.shortDay(since)}` : "What shipped in your repos: merged PRs, releases and tags",
    crumbs: one ? [{ href: hrefOf(days), label: "Releases" }] : undefined,
    tabs: Tabs({ label: "Window", items: WINDOWS.map((d) => ({ href: hrefOf(d, one?.repo), label: `${d} days`, current: d === days })) }),
  });
  const body = o.silent
    ? Notice({ children: `${o.silent} doesn't say what shipped here yet, so there's nothing to show.` })
    : !k
      ? Empty({ title: "Not read yet" })
      : html`${k.error ? Notice({ tone: k.shipped ? "warn" : "bad", children: k.shipped ? `Couldn't read what shipped just now (${k.error}): this is from ${format.ago(k.at, o.now)}.` : `Couldn't read what shipped: ${k.error}` }) : ""}
${k.shipped?.more ? Notice({ children: "More PRs merged than could be read: these are the newest." }) : ""}
${!k.shipped ? "" : one ? repoView(one, { since, until: dayOf(o.now) }) : repos.length ? overview(repos, days) : Empty({ title: `Nothing shipped in the last ${days} days` })}`;
  return html`${header}
<div data-live id="releases">
${body}
</div>`;
}
