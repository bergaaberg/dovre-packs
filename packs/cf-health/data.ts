/**
 * Cloudflare Health Pack (`cf-health`): queries Cloudflare's GraphQL Analytics API
 * (`workersInvocationsAdaptive`) for 24h request & error counts per Worker.
 */
import type { PackContext } from "dovre/packs/types.ts";

export type WorkerMetric = {
  script: string;
  requests24h: number;
  errors24h: number;
  errorRatePct: number;
  status: "ok" | "warn" | "bad";
  dashboardUrl?: string;
};

export type CfHealthKept = {
  at: number;
  ok: boolean;
  error?: string;
  workers: WorkerMetric[];
};

const GQL_URL = "https://api.cloudflare.com/client/v4/graphql";

export async function readCfHealth(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<CfHealthKept> {
  const accountId = (ctx.env.CF_ACCOUNT_ID ?? "").trim();
  const apiToken = (ctx.env.CF_API_TOKEN ?? "").trim();
  const scripts = (ctx.env.CF_WORKERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!accountId || !apiToken) {
    return { at: now, ok: false, error: "Set CF_ACCOUNT_ID and CF_API_TOKEN to query Cloudflare Workers telemetry.", workers: [] };
  }

  const since = new Date(now - 24 * 3600_000).toISOString();
  const until = new Date(now).toISOString();
  const query = `
    query WorkersHealth($accountTag: string!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(limit: 500, filter: { datetime_geq: $since, datetime_leq: $until }) {
            dimensions { scriptName }
            sum { requests errors }
          }
        }
      }
    }
  `;

  try {
    const res = await fetchFn(GQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ query, variables: { accountTag: accountId, since, until } }),
    });
    if (!res.ok) {
      return { at: now, ok: false, error: `Cloudflare GraphQL HTTP ${res.status}`, workers: [] };
    }
    const j = (await res.json()) as {
      errors?: { message?: string }[];
      data?: {
        viewer?: {
          accounts?: {
            workersInvocationsAdaptive?: {
              dimensions?: { scriptName?: string };
              sum?: { requests?: number; errors?: number };
            }[];
          }[];
        };
      };
    };
    if (j.errors?.length) {
      return { at: now, ok: false, error: String(j.errors[0]?.message ?? "GraphQL error").slice(0, 180), workers: [] };
    }
    const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    const byScript = new Map<string, { requests: number; errors: number }>();
    for (const s of scripts) byScript.set(s, { requests: 0, errors: 0 });
    for (const r of rows) {
      const name = r.dimensions?.scriptName?.trim();
      if (!name) continue;
      if (scripts.length && !scripts.includes(name)) continue;
      const cur = byScript.get(name) ?? { requests: 0, errors: 0 };
      cur.requests += Number(r.sum?.requests ?? 0);
      cur.errors += Number(r.sum?.errors ?? 0);
      byScript.set(name, cur);
    }

    const workers: WorkerMetric[] = [...byScript.entries()].map(([script, m]) => {
      const rate = m.requests > 0 ? Number(((m.errors / m.requests) * 100).toFixed(2)) : 0;
      const status = rate >= 5 || m.errors >= 50 ? "bad" : rate >= 1 || m.errors > 0 ? "warn" : "ok";
      return {
        script,
        requests24h: m.requests,
        errors24h: m.errors,
        errorRatePct: rate,
        status,
        dashboardUrl: `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers/services/view/${encodeURIComponent(script)}/production`,
      };
    });
    return { at: now, ok: true, workers };
  } catch (e) {
    return { at: now, ok: false, error: String((e as Error)?.message ?? e).slice(0, 180), workers: [] };
  }
}
