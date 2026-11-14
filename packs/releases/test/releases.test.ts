/** Releases: PR titles sorted by kind, the page by repo and for one repo with its draft, Stats, search, and hostile input. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeShipped, PackStat } from "dovre/pack.ts";
import { assertInert, HOSTILE, packApp, testContext } from "dovre/pack-testing.ts";
import { byRepo, changeOf, draftOf, perWeek, tally, weeksOf, within } from "../data.ts";
import { createReleasesPack } from "../index.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const pr = (repo: string, number: number, title: string, mergedAt = "2026-11-13T09:00:00Z", author = "kari") => ({ repo, number, title, url: `https://github.com/${repo}/pull/${number}`, mergedAt, author });
const SHIPPED: ForgeShipped = {
  prs: [
    pr("acme/shop", 12, "feat(cart): save for later"),
    pr("acme/shop", 11, "fix: totals round the right way", "2026-11-12T09:00:00Z"),
    pr("acme/shop", 10, "feat(api)!: drop v1 routes", "2026-11-11T09:00:00Z"),
    pr("acme/shop", 9, "chore(deps): bump hono", "2026-11-10T09:00:00Z", "dependabot[bot]"),
    pr("acme/shop", 8, "Tidy the README", "2026-11-09T09:00:00Z"),
    pr("acme/shop", 7, "docs: how to deploy", "2026-11-03T09:00:00Z"),
    pr("acme/site", 3, "perf: smaller images", "2026-10-20T09:00:00Z"),
  ],
  releases: [{ repo: "acme/shop", tag: "v2.0.0", name: "Two", url: "https://github.com/acme/shop/releases/tag/v2.0.0", at: "2026-11-13T10:00:00Z" }],
  tags: [{ repo: "acme/site", tag: "site@1.4.0", url: "https://github.com/acme/site/releases/tag/site%401.4.0", at: "2026-11-12T10:00:00Z" }],
};
const forge = (shipped: () => Promise<ForgeShipped>) => ({ id: "github", name: "GitHub", can: [], host: "github.com", shipped });
const app = (s: ForgeShipped = SHIPPED, env: Record<string, string> = {}) => {
  const asked: string[] = [];
  const pack = createReleasesPack({ now: () => NOW });
  return { pack, asked, ...packApp([pack], { env, forge: { ...forge(async () => s), shipped: async (_o, since) => (asked.push(since), s) } }) };
};

test("a PR's title says its kind; a bot's bump is upkeep, a bang is breaking, anything else is other", () => {
  const kind = (title: string, author = "kari") => { const c = changeOf(pr("a/b", 1, title, undefined, author)); return `${c.kind}|${c.scope}|${c.text}`; };
  assert.equal(kind("feat(cart): save for later"), "added|cart|save for later");
  assert.equal(kind("Fix: totals"), "fixed||totals");
  assert.equal(kind("refactor(api)!: drop v1"), "breaking|api|drop v1");
  assert.equal(kind("feat: bump x", "dependabot[bot]"), "upkeep||bump x");
  assert.equal(kind("Bump x from 1 to 2", "renovate"), "upkeep||Bump x from 1 to 2");
  assert.equal(kind("Tidy the README"), "other||Tidy the README");
  assert.equal(kind("wip: not a type"), "other||wip: not a type");
  assert.equal(kind("feat:no space"), "other||feat:no space");
});

test("a window, by repo, and the weeks for Stats", () => {
  const week = byRepo(within(SHIPPED, "2026-11-07"));
  assert.deepEqual(week.map((r) => `${r.repo} ${r.changes.length}/${r.releases.length}/${r.tags.length}`), ["acme/shop 5/1/0", "acme/site 0/0/1"]);
  assert.equal(tally(week[0]!.changes), "1 breaking · 1 added · 1 fixed · 1 other · 1 upkeep");
  const weeks = weeksOf(NOW, 5);
  assert.deepEqual(weeks, ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
  assert.deepEqual(perWeek(SHIPPED.prs.map((p) => p.mergedAt), weeks), [0, 1, 0, 1, 5]);
});

test("a repo's draft: what was released, then the PRs by kind, docs and upkeep left out, Markdown in titles escaped", () => {
  const shop = byRepo({ ...SHIPPED, prs: [...SHIPPED.prs, pr("acme/shop", 13, "fix: a [link](javascript:x) and\n# a heading")] })[0]!;
  const draft = draftOf(shop, { since: "2026-11-07", until: "2026-11-14" });
  assert.equal(
    draft,
    ["## acme/shop, 2026-11-07 to 2026-11-14", "", "Released: v2.0.0 (2026-11-13)", "", "### Breaking", "", "- api: drop v1 routes (#10)", "", "### Added", "", "- cart: save for later (#12)", "", "### Fixed", "", "- totals round the right way (#11)", "- a \\[link\\](javascript:x) and \\# a heading (#13)", "", "### Other", "", "- Tidy the README (#8)", ""].join("\n"),
  );
  assert.match(draftOf({ repo: "acme/x", changes: [], releases: [], tags: [] }, { since: "a", until: "b" }), /Nothing to list/);
  const many = Array.from({ length: 23 }, (_, i) => ({ repo: "acme/x", tag: `p${i}@1.0.0`, url: "u", at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
  assert.match(draftOf({ repo: "acme/x", changes: [], releases: [], tags: many }, { since: "a", until: "b" }), /^Released: p22@1\.0\.0 \(2026-11-23\), .*p3@1\.0\.0 \(2026-11-04\), and 3 more$/m);
});

test("the page: every repo over the window, then one repo with its PRs by kind and the draft", async () => {
  const { get, asked } = app();
  const all = await (await get("/releases")).text();
  assert.match(all, /<title>Releases[^<]*<\/title>/);
  assert.deepEqual(asked, ["2026-10-10"], "one read, 35 days back");
  assert.match(all, /href="\/releases\?days=7&amp;repo=acme%2Fshop"[\s\S]*?acme\/shop[\s\S]*?1 breaking · 1 added · 1 fixed · 1 other · 1 upkeep/);
  assert.match(all, /site@1\.4\.0[\s\S]*?Tag/);
  assert.doesNotMatch(all, /smaller images|how to deploy/, "older than 7 days");
  assert.match(all, /href="\/releases\?days=7"[^>]*aria-current/);
  const month = await (await get("/releases?days=30")).text();
  assert.match(month, /acme\/site[\s\S]*?1 changed/);
  assert.match(await (await get("/releases?days=9")).text(), /href="\/releases\?days=7"[^>]*aria-current/, "an unknown window is the first");
  const shop = await (await get("/releases?days=14&repo=ACME/shop")).text();
  assert.match(shop, /Breaking[\s\S]*drop v1 routes[\s\S]*Added[\s\S]*save for later[\s\S]*Docs[\s\S]*how to deploy[\s\S]*Upkeep[\s\S]*bump hono/);
  assert.match(shop, /href="https:\/\/github\.com\/acme\/shop\/pull\/12"/);
  assert.match(shop, /<textarea[^>]*readonly[^>]*>## acme\/shop, 2026-10-31 to 2026-11-14[\s\S]*### Added[\s\S]*- cart: save for later \(#12\)[\s\S]*<\/textarea>/);
  assert.match(shop, /left out: 1 docs, 1 upkeep/);
  assert.match(await (await get("/releases?repo=acme/nope")).text(), /By repo/, "a repo that shipped nothing is the overview");
  assert.equal(asked.length, 1, "pages read memory after the first");
  const tags = Array.from({ length: 40 }, (_, i) => ({ repo: "acme/site", tag: `p${i}@1.0.0`, url: "https://github.com/acme/site", at: "2026-11-13T00:00:00Z" }));
  const busy = app({ prs: [], releases: [], tags });
  assert.match(await (await busy.get("/releases")).text(), /and 28 more/, "the overview names a dozen");
  assert.match(await (await busy.get("/releases?repo=acme/site")).text(), /and 10 more[\s\S]*and 20 more/, "a repo thirty, its draft twenty");
  assert.match(await (await get("/search?q=changelog")).text(), /href="\/releases"/, "search finds the page");
});

test("the window the page opens on is a setting", async () => {
  const { get } = app(SHIPPED, { RELEASES_DAYS: "30" });
  assert.match(await (await get("/releases")).text(), /href="\/releases\?days=30"[^>]*aria-current/);
});

test("nothing shipped, a forge that doesn't say, and a read that fails", async () => {
  assert.match(await (await app({ prs: [], releases: [], tags: [] }).get("/releases")).text(), /Nothing shipped in the last 7 days/);
  const quiet = packApp([createReleasesPack()], { forge: { id: "gitlab", name: "GitLab", can: [] } });
  assert.match(await (await quiet.get("/releases")).text(), /GitLab doesn(&#39;|')t say what shipped/);
  let fail = true;
  let t = NOW;
  const pack = createReleasesPack({ now: () => t });
  const { get } = packApp([pack], { forge: forge(async () => (fail ? Promise.reject(new Error("502 Bad Gateway")) : SHIPPED)) });
  assert.match(await (await get("/releases")).text(), /Couldn(&#39;|')t read what shipped: 502 Bad Gateway/);
  fail = false;
  t += 11 * 60_000;
  await pack.refresh!(testContext({ forge: () => ({ id: "github", name: "GitHub", host: "github.com", login: "kari", owners: "acme", owns: () => true, shipped: async () => SHIPPED }) }));
  assert.ok(pack.kept()?.shipped && !pack.kept()?.error, "the next read is good");
  await pack.refresh!(testContext({ forge: () => ({ id: "github", name: "GitHub", host: "github.com", login: "kari", owners: "acme", owns: () => true, shipped: async () => Promise.reject(new Error("rate limited")) }) }));
  assert.equal(pack.kept()?.error, "rate limited");
  assert.ok(pack.kept()?.shipped, "the last good answer is kept, with why");
  assert.match(await (await get("/releases")).text(), /Couldn(&#39;|')t read what shipped just now \(rate limited\)[\s\S]*acme\/shop/);
});

test("Stats, search and what Bino hears come from memory", async () => {
  const { pack, get } = app();
  const ctx = testContext();
  assert.deepEqual(pack.stats!(ctx, { weeks: 12 }), [], "nothing before the first read");
  assert.deepEqual(pack.finds!(ctx), []);
  await get("/releases");
  const [stat] = pack.stats!(ctx, { weeks: 12 }) as (PackStat & { labels: string[]; series: { name: string; values: number[] }[] })[];
  assert.deepEqual(stat!.labels, ["10-12", "10-19", "10-26", "11-02", "11-09"]);
  assert.deepEqual(stat!.series.map((s) => s.values), [[0, 1, 0, 1, 5], [0, 0, 0, 0, 2]]);
  assert.deepEqual(pack.finds!(ctx).map((f) => `${f.title} · ${f.sub} · ${f.href}`), ["acme/shop v2.0.0 · Release · Two · https://github.com/acme/shop/releases/tag/v2.0.0", "acme/site site@1.4.0 · Tag · https://github.com/acme/site/releases/tag/site%401.4.0"]);
  assert.equal(pack.bino!(ctx), "Releases, last 7 days: acme/shop 5 PRs merged, 1 released; acme/site 0 PRs merged, 1 released");
});

test("hostile titles, repos, tags and links stay inert, in the lists and in the draft", async () => {
  const s: ForgeShipped = {
    prs: [{ repo: "acme/shop", number: 1, title: `feat(${HOSTILE}): ${HOSTILE}</textarea><script>alert(1)</script>`, url: "javascript:alert(1)", mergedAt: "2026-11-13T09:00:00Z", author: HOSTILE }],
    releases: [{ repo: "acme/shop", tag: HOSTILE, name: `${HOSTILE}</textarea>`, url: "javascript:alert(1)", at: "2026-11-13T09:00:00Z" }],
    tags: [{ repo: "acme/shop", tag: `</textarea>${HOSTILE}`, url: "data:text/html,x", at: "2026-11-13T09:00:00Z" }],
  };
  const { get, pack } = app(s);
  for (const path of ["/releases", "/releases?repo=acme/shop", `/releases?repo=${encodeURIComponent(HOSTILE)}&days=${encodeURIComponent(HOSTILE)}`]) {
    const out = await (await get(path)).text();
    assertInert(`releases ${path}`, out);
    assert.doesNotMatch(out, /href="(javascript|data):/);
    assert.equal(out.split("<textarea").length, out.split("</textarea>").length, "the draft's box closes once");
  }
  for (const f of pack.finds!(testContext())) assert.equal(f.href, "#", "a link that isn't http(s) goes nowhere");
});
