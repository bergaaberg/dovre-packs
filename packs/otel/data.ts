/**
 * OpenTelemetry & Prometheus pack data: RED metrics per service, firing alerts, and 24h error
 * series from a Prometheus-compatible API (Prometheus, Mimir, VictoriaMetrics, Grafana Cloud).
 * Reads happen only in `refresh()`; everything else is a synchronous memory read.
 */
import type { PackContext } from "dovre/packs/types.ts";

/** When a service counts as degraded: error ratio in % and p95 latency in ms. */
export const WARN_ERR = 1;
export const BAD_ERR = 5;
export const WARN_P95 = 500;
export const BAD_P95 = 2000;

export type OtelAlert = { name: string; service?: string; severity: string; since: number; summary?: string };

export type OtelService = {
  name: string;
  repo?: string;
  /** Requests per second, 5m rate. */
  rps: number;
  /** 5xx ratio over 5m, in percent. */
  errPct: number;
  /** p95 / p99 latency in ms. */
  p95: number;
  p99: number;
  status: "ok" | "warn" | "bad";
  /** Running version, from the `service_version`/`build_info` label. */
  version?: string;
  /** 5xx ratio % per hour over the last 24h, for the horizon lane. */
  errHourly: { at: number; pct: number }[];
  alerts: OtelAlert[];
};

export type OtelKept =
  | { ok: true; at: number; services: OtelService[]; alerts: OtelAlert[]; url: string }
  | { ok: false; error: string };

/** `api,gitlab=bergaaberg/gitlab` → [{name:"api"},{name:"gitlab",repo:"bergaaberg/gitlab"}]. */
export function wantedServices(raw: unknown): { name: string; repo?: string }[] {
  if (typeof raw !== "string") return [];
  const out: { name: string; repo?: string }[] = [];
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    const repo = eq < 0 ? undefined : piece.slice(eq + 1).trim();
    const name = (eq < 0 ? piece : piece.slice(0, eq)).trim();
    if (!name || !/^[\w./-]+$/.test(name)) continue; // a service name, not markup
    if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
    if (!out.some((s) => s.name === name)) out.push(repo ? { name, repo } : { name });
  }
  return out;
}

/** One instant PromQL query's value as a number, or 0 when it answered nothing. */
function value(v: unknown): number {
  const first = (v as { data?: { result?: { value?: [number, string] }[] } } | undefined)?.data?.result?.[0]?.value;
  const n = Number(first?.[1]);
  return Number.isFinite(n) ? n : 0;
}

/** A query_range's values as numbers with their times. */
function series(v: unknown): { at: number; n: number }[] {
  const vals = (v as { data?: { result?: { values?: [number, string][] }[] } } | undefined)?.data?.result?.[0]?.values ?? [];
  return vals.map(([at, s]) => ({ at: at * 1000, n: Number(s) })).filter((p) => Number.isFinite(p.n));
}

const q = (s: string) => `?query=${encodeURIComponent(s)}`;

/** The metric prefix real OTel SDKs emit; fall back to the bare Prometheus http one. */
function count(service: string) {
  const m = `http_server_request_duration_seconds_count{service_name="${service}"}`;
  return { all: m, err: `http_server_request_duration_seconds_count{service_name="${service}",http_response_status_code=~"5.."}` };
}

/**
 * Reads everything once: per service the RED numbers, the 24h 5xx series and its alerts; the
 * running version; and the firing alerts across services. One bad query degrades that service,
 * an unreachable API fails the whole read with the message the page shows.
 */
export async function readOtel(ctx: PackContext, fetchFn?: typeof fetch): Promise<OtelKept> {
  const fetch_ = fetchFn ?? fetch;
  const url = (ctx.env.OTEL_PROMETHEUS_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return { ok: false, error: "OTEL_PROMETHEUS_URL is not set" };
  if (!/^https?:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(url)) return { ok: false, error: `OTEL_PROMETHEUS_URL is not a plain http(s) URL: ${url}` };
  const wanted = wantedServices(ctx.env.OTEL_SERVICES);
  if (!wanted.length) return { ok: false, error: "OTEL_SERVICES is not set (service names, `name=owner/repo` mappings)" };
  const headers: Record<string, string> = { accept: "application/json" };
  const token = (ctx.env.OTEL_BEARER_TOKEN ?? "").trim();
  if (token) headers.authorization = token.includes(":") ? `Basic ${btoa(token)}` : `Bearer ${token}`;
  const get = async (path: string) => {
    const res = await fetch_(`${url}${path}`, { headers });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  };

  try {
    const alertsRaw = (await get("/api/v1/alerts")) as {
      data?: { alerts?: { labels?: Record<string, string>; state?: string; activeAt?: string; annotations?: Record<string, string> }[] };
    };
    const alerts: OtelAlert[] = (alertsRaw.data?.alerts ?? [])
      .filter((a) => a.state === "firing")
      .map((a) => ({
        name: (a.labels?.alertname ?? "").replace(/[<>{}$`]/g, "").slice(0, 80),
        service: a.labels?.service_name ?? a.labels?.service,
        severity: a.labels?.severity === "critical" ? "critical" : "warning",
        since: Date.parse(a.activeAt ?? "") || 0,
        summary: a.annotations?.summary?.replace(/[<>{}$`]/g, "").slice(0, 140),
      }))
      .filter((a) => a.name);

    const at = Date.now();
    const services: OtelService[] = [];
    for (const s of wanted) {
      const c = count(s.name);
      const [r, e, q95, q99, hist, ver] = await Promise.all([
        get(`/api/v1/query${q(`sum(rate(${c.all}[5m]))`)}`),
        get(`/api/v1/query${q(`100 * sum(rate(${c.err}[5m])) / clamp_min(sum(rate(${c.all}[5m])), 1e-9)`)}`),
        get(`/api/v1/query${q(`histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="${s.name}"}[5m])))`)}`),
        get(`/api/v1/query${q(`histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="${s.name}"}[5m])))`)}`),
        get(`/api/v1/query_range${q(`100 * sum(rate(${c.err}[1h])) / clamp_min(sum(rate(${c.all}[1h])), 1e-9)`)}&start=${Math.floor((at - 24 * 3600e3) / 1000)}&end=${Math.floor(at / 1000)}&step=3600`),
        get(`/api/v1/query${q(`build_info{service_name="${s.name}"}`)}`).catch(() => null),
      ]);
      const svcAlerts = alerts.filter((a) => a.service === s.name);
      const errPct = Math.max(0, value(e));
      const p95 = Math.round(value(q95) * 1000);
      const p99 = Math.round(value(q99) * 1000);
      const status: OtelService["status"] =
        errPct >= BAD_ERR || p95 >= BAD_P95 || svcAlerts.some((a) => a.severity === "critical")
          ? "bad"
          : errPct >= WARN_ERR || p95 >= WARN_P95 || svcAlerts.some((a) => a.severity === "warning")
            ? "warn"
            : "ok";
      const versionLabel = ver as { data?: { result?: { metric?: Record<string, string> }[] } } | null;
      services.push({
        name: s.name,
        repo: s.repo,
        rps: Math.round(value(r) * 100) / 100,
        errPct: Math.round(errPct * 10) / 10,
        p95,
        p99,
        status,
        version: versionLabel?.data?.result?.[0]?.metric?.service_version?.replace(/[<>{}$`]/g, "").slice(0, 40) || undefined,
        errHourly: series(hist).map((p) => ({ at: p.at, pct: Math.max(0, Math.round(p.n * 10) / 10) })),
        alerts: svcAlerts,
      });
    }
    return { ok: true, at, services, alerts, url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "reading the metrics API failed" };
  }
}
