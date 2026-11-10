/**
 * AI summaries (`summaries`): a short summary on each open PR (at its head commit) and on what each
 * waiting deploy ships, written in the background by the model Dovre lends packs (`ctx.complete`,
 * once I allow it on Settings → Packs → AI summaries), kept in the summaries table (store.ts). It
 * reads the newest snapshot on its refresh, queues what's new, and answers the "ai.summary" slot by
 * key; core draws the text. Local only. It left Dovre's core in dovre#466.
 */
import { deploySummaryKey, type Pack, type PackContext, prSummaryKey, type Snapshot, throttle } from "dovre/pack.ts";
import { createSummaries, deployPrompt, MIGRATIONS, prPrompt, type Summaries } from "./store.ts";

/** Queues a summary for every open PR at its head commit and every deploy that ships something. */
export function wantAll(sum: Summaries, s: Snapshot, now: number): void {
  if (s.prs.ok)
    for (const p of [...s.prs.value.review, ...s.prs.value.mine])
      if (p.headSha) sum.want(prSummaryKey(p), () => prPrompt({ ...p, files: p.files }));
  for (const [, c] of s.changelogs)
    if (c.ok && c.value.changes.length) {
      const days = c.value.prodAt ? Math.max(1, Math.round((now - Date.parse(c.value.prodAt)) / 86400e3)) : 0;
      sum.want(deploySummaryKey(c.value), () => deployPrompt({ repo: c.value.repo, days, items: c.value.changes.map((x) => ({ kind: x.kind, title: x.title, author: x.author })) }));
    }
}

export function createSummariesPack(deps: { now?: () => number } = {}): Pack {
  const now = deps.now ?? Date.now;
  /** Made on the first refresh or page, so pages see what was written before a restart. */
  let sum: Summaries | undefined;
  let loading: Promise<Summaries> | undefined;
  const ready = (ctx: PackContext) =>
    (loading ??= (async () => {
      // A finished summary redraws the pages that show it, every 2 s at most.
      const changed = throttle(() => ctx.publish(["snapshot"]), 2000);
      const s = createSummaries(ctx.db, (p) => ctx.complete(p), { onReady: changed });
      await s.load();
      return (sum = s);
    })().catch((e) => {
      loading = undefined;
      throw e;
    }));

  return {
    manifest: {
      api: "1.35",
      version: "1.1.0",
      id: "summaries",
      name: "AI summaries",
      description: "A short summary on each PR and deploy, from the PR's own text",
      domain: "general",
      execution: "local-only",
      ai: { text: { why: "A two-sentence summary of each open PR (its title, description and changed files) and of what each waiting deploy ships." } },
      // Picks up a new gather's PRs and deploys within half a minute; what's queued already is skipped.
      everyMs: 30_000,
    },
    migrations: MIGRATIONS,
    refresh: async (ctx) => {
      // Nothing is asked until I allow it (Settings → Packs → AI summaries); what's kept still shows.
      const got = await ready(ctx);
      const s = ctx.snapshot();
      if (s && ctx.ai().text) wantAll(got, s, now());
    },
    beforePage: async (ctx) => {
      if (!sum) await ready(ctx);
    },
    slots: () => ({
      "ai.summary": ({ key }) => (typeof key === "string" ? sum?.get(key) : undefined),
    }),
  };
}

export const summariesPack = createSummariesPack();
