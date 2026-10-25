/**
 * Cloudflare Health Pack (`cf-health`): 24h Cloudflare Workers GraphQL telemetry.
 * Works both locally and hosted on Cloudflare Workers.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { type CfHealthKept, readCfHealth } from "./data.ts";
import { cfHealthCard, cfHealthPage } from "./view.ts";

export function createCfHealthPack(opts: { fetchFn?: typeof fetch } = {}): Pack & { kept(): CfHealthKept | undefined } {
  let kept: CfHealthKept | undefined;
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "cf-health",
      name: "Cloudflare Health",
      description: "24h Cloudflare Workers request and error telemetry via GraphQL.",
      domain: "general",
      execution: "any",
      everyMs: 2 * 60_000,
      settings: [
        { key: "CF_ACCOUNT_ID", label: "Cloudflare Account ID", required: true },
        { key: "CF_API_TOKEN", label: "Cloudflare Analytics API Token", secret: true, required: true },
        { key: "CF_WORKERS", label: "Worker script names (comma-separated)", help: "Optional filter, e.g. api-worker, web-worker" },
      ],
    },
    async refresh(ctx) {
      kept = await readCfHealth(ctx, opts.fetchFn);
      ctx.publish(["cf-health", "snapshot"]);
    },
    nav: () => [{ href: "/cf-health", title: "CF Health", icon: "health", group: "Ops" }],
    pages: () => [{ title: "Cloudflare Health", href: "/cf-health", icon: "♥", about: "24h Cloudflare Workers requests and errors", also: ["workers", "ops", "telemetry"] }],
    routes(app, ctx) {
      app.get("/cf-health", (c) => ctx.page(c, { title: "Cloudflare Health", body: cfHealthPage(kept) }));
    },
    today: () => (kept ? [{ id: "now", render: cfHealthCard(kept) }] : []),
    avatar: () => {
      if (!kept?.ok) return undefined;
      const bad = kept.workers.filter((w) => w.status === "bad");
      const warn = kept.workers.filter((w) => w.status === "warn");
      if (bad.length) return { trouble: { level: "fire", why: `${bad.length} Worker${bad.length > 1 ? "s" : ""} failing`, href: "/cf-health" } };
      if (warn.length) return { trouble: { level: "storm", why: `${warn.length} Worker${warn.length > 1 ? "s" : ""} elevated errors`, href: "/cf-health" } };
      return undefined;
    },
    bino: () => {
      if (!kept) return "";
      if (!kept.ok) return `Cloudflare Health: error (${kept.error ?? "unavailable"})`;
      return kept.workers.map((w) => `${w.script} [${w.status}]: ${w.requests24h} req, ${w.errors24h} err (${w.errorRatePct}%)`).join("\n");
    },
  };
}

export const cfHealthPack: Pack = createCfHealthPack();
export const cfHealthCrate = cfHealthPack;
