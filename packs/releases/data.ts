/**
 * Releases' data: what `forge().shipped` gave, cut to a window, grouped by repo, each merged PR
 * sorted by the conventional-commit type its title starts with, and a changelog draft from them.
 */
import type { ForgeShipped } from "dovre/pack.ts";

export const DAY = 86_400_000;
/** The windows the page offers, in days. */
export const WINDOWS = [7, 14, 30];
/** How far back a read goes: the longest window, and five whole weeks for Stats. */
export const READ_DAYS = 35;

/** The last read: what shipped since a day, or why there's nothing (`error`; with `shipped`, an older answer still shown). */
export type Kept = { at: number; since: string; shipped?: ForgeShipped; error?: string };

export type MergedPr = ForgeShipped["prs"][number];
export type Kind = "breaking" | "added" | "fixed" | "changed" | "other" | "docs" | "upkeep";
/** In the order they're drawn; `draft`: part of a changelog draft (docs and upkeep aren't). */
export const KINDS: { id: Kind; title: string; word: string; draft: boolean }[] = [
  { id: "breaking", title: "Breaking", word: "breaking", draft: true },
  { id: "added", title: "Added", word: "added", draft: true },
  { id: "fixed", title: "Fixed", word: "fixed", draft: true },
  { id: "changed", title: "Changed", word: "changed", draft: true },
  { id: "other", title: "Other", word: "other", draft: true },
  { id: "docs", title: "Docs", word: "docs", draft: false },
  { id: "upkeep", title: "Upkeep", word: "upkeep", draft: false },
];

const TYPES: Record<string, Kind> = {
  feat: "added", feature: "added",
  fix: "fixed", bugfix: "fixed", hotfix: "fixed",
  perf: "changed", refactor: "changed", revert: "changed",
  docs: "docs", doc: "docs",
  chore: "upkeep", ci: "upkeep", build: "upkeep", test: "upkeep", tests: "upkeep", style: "upkeep", deps: "upkeep", release: "upkeep",
};

/** A bump from a bot is upkeep whatever its title says. */
const isBot = (login: string) => /\[bot\]$|^dependabot|^renovate|^github-actions/i.test(login);

export type Change = { kind: Kind; scope: string; text: string; pr: MergedPr };

/** `feat(packs)!: a thing` → breaking, scope packs, "a thing". A title with no known type is "other", as written. */
export function changeOf(pr: MergedPr): Change {
  const title = pr.title.trim();
  const m = /^([A-Za-z]+)(?:\(([^()]{1,60})\))?(!)?:\s+(\S[^]*)$/.exec(title);
  const kind = m ? TYPES[m[1]!.toLowerCase()] : undefined;
  if (!m || !kind) return { kind: isBot(pr.author) ? "upkeep" : "other", scope: "", text: title, pr };
  return { kind: m[3] ? "breaking" : isBot(pr.author) ? "upkeep" : kind, scope: m[2]?.trim() ?? "", text: m[4]!.trim(), pr };
}

/** A time's UTC day. */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** The day a window of `days` starts. */
export const sinceOf = (now: number, days: number) => dayOf(now - days * DAY);

/** What shipped on or after a day. */
export function within(s: ForgeShipped, since: string): ForgeShipped {
  const on = (at: string) => at.slice(0, 10) >= since;
  return { prs: s.prs.filter((p) => on(p.mergedAt)), releases: s.releases.filter((r) => on(r.at)), tags: s.tags.filter((t) => on(t.at)), ...(s.more ? { more: true as const } : {}) };
}

export type RepoShipped = { repo: string; changes: Change[]; releases: ForgeShipped["releases"]; tags: ForgeShipped["tags"] };

/** By repo, the one that shipped most first. */
export function byRepo(s: ForgeShipped): RepoShipped[] {
  const repos = new Map<string, RepoShipped>();
  const of = (repo: string) => repos.get(repo) ?? repos.set(repo, { repo, changes: [], releases: [], tags: [] }).get(repo)!;
  for (const p of s.prs) of(p.repo).changes.push(changeOf(p));
  for (const r of s.releases) of(r.repo).releases.push(r);
  for (const t of s.tags) of(t.repo).tags.push(t);
  const size = (r: RepoShipped) => r.changes.length + r.releases.length + r.tags.length;
  return [...repos.values()].sort((a, b) => size(b) - size(a) || a.repo.localeCompare(b.repo));
}

/** How many of each kind, as "12 added · 3 fixed". */
export function tally(changes: Change[]): string {
  return KINDS.map((k) => [changes.filter((c) => c.kind === k.id).length, k.word] as const).filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(" · ");
}

/** Releases and tags named in a draft; the rest is a count. */
const DRAFT_TAGS = 20;

/** One line of Markdown: nothing in a title starts a list, a heading or a link of its own. */
const line = (s: string) => s.replace(/\s+/g, " ").replace(/([\\`*_[\]<>#|])/g, "\\$1").trim();

/**
 * A repo's changelog draft, Markdown to copy and edit: what was released, then the merged PRs under
 * Breaking, Added, Fixed, Changed and Other. Docs and upkeep are left out.
 */
export function draftOf(r: RepoShipped, o: { since: string; until: string }): string {
  const out = [`## ${line(r.repo)}, ${o.since} to ${o.until}`, ""];
  const released = [...r.releases.map((x) => ({ tag: x.tag, at: x.at })), ...r.tags].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (released.length) out.push(`Released: ${released.slice(0, DRAFT_TAGS).map((x) => `${line(x.tag)} (${x.at.slice(0, 10)})`).join(", ")}${released.length > DRAFT_TAGS ? `, and ${released.length - DRAFT_TAGS} more` : ""}`, "");
  for (const k of KINDS.filter((k) => k.draft)) {
    const of = r.changes.filter((c) => c.kind === k.id);
    if (!of.length) continue;
    out.push(`### ${k.title}`, "", ...of.map((c) => `- ${c.scope ? `${line(c.scope)}: ` : ""}${line(c.text)} (#${c.pr.number})`), "");
  }
  if (out.length === 2) out.push("Nothing to list.", "");
  return out.join("\n");
}

/** The Mondays (UTC) of the last `n` weeks, oldest first; the last is this week. */
export function weeksOf(now: number, n: number): string[] {
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  const monday = today - ((new Date(today).getUTCDay() || 7) - 1) * DAY;
  return Array.from({ length: n }, (_, i) => dayOf(monday - (n - 1 - i) * 7 * DAY));
}

/** How many of these times fall in each week. */
export function perWeek(times: string[], weeks: string[]): number[] {
  return weeks.map((w, i) => times.filter((t) => t.slice(0, 10) >= w && (i === weeks.length - 1 || t.slice(0, 10) < weeks[i + 1]!)).length);
}
