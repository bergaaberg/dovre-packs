/**
 * Custom App Pack (`custom-app`): reads your app's metrics or events into memory on `refresh()`.
 * Pages and Today cards read strictly from `Kept` in memory — never awaiting network I/O during render.
 */
import type { PackContext } from "dovre/packs/types.ts";

export type CustomAppItem = {
  title: string;
  sub?: string;
  href?: string;
  tone?: "ok" | "warn" | "bad" | "neutral";
};

export type Kept = {
  at: number;
  summary: string;
  items: CustomAppItem[];
};

export async function read(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<Kept> {
  const url = (ctx.env.CUSTOM_APP_URL ?? "").trim();
  if (url && /^https?:\/\//i.test(url)) {
    try {
      const res = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const j = (await res.json()) as { summary?: string; items?: CustomAppItem[] };
        return {
          at: now,
          summary: String(j.summary ?? "Connected").slice(0, 140),
          items: Array.isArray(j.items) ? j.items.slice(0, 25) : [],
        };
      }
    } catch {}
  }
  return {
    at: now,
    summary: "Starter pack ready — connect your D1 binding or CUSTOM_APP_URL in data.ts",
    items: [],
  };
}
