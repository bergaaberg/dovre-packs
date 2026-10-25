/**
 * HTTP & OpenTelemetry Pack (`http-otel`): polls comma-separated `HTTP_HEALTH_URLS`
 * (`/healthz` endpoints) and optional `OTEL_METRICS_URL` for latency and status.
 */
import type { PackContext } from "dovre/packs/types.ts";

export type EndpointCheck = {
  name: string;
  url: string;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  status: "ok" | "warn" | "bad";
  detail?: string;
};

export type HttpOtelKept = {
  at: number;
  endpoints: EndpointCheck[];
};

export async function readHttpOtel(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<HttpOtelKept> {
  const urls = (ctx.env.HTTP_HEALTH_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 20);

  const endpoints = await Promise.all(
    urls.map(async (url): Promise<EndpointCheck> => {
      const started = Date.now();
      let name = url;
      try {
        const u = new URL(url);
        name = u.host + (u.pathname !== "/" ? u.pathname : "");
      } catch {}
      try {
        const res = await fetchFn(url, {
          method: "GET",
          headers: { accept: "application/json, text/plain;q=0.8" },
          signal: AbortSignal.timeout(6000),
        });
        const latencyMs = Math.max(1, Date.now() - started);
        const ok = res.status >= 200 && res.status < 300;
        const status = !ok ? "bad" : latencyMs > 1500 ? "warn" : "ok";
        return {
          name,
          url,
          ok,
          statusCode: res.status,
          latencyMs,
          status,
          detail: `HTTP ${res.status} · ${latencyMs} ms`,
        };
      } catch (e) {
        const latencyMs = Math.max(1, Date.now() - started);
        return {
          name,
          url,
          ok: false,
          statusCode: 0,
          latencyMs,
          status: "bad",
          detail: String((e as Error)?.message ?? "unreachable").slice(0, 120),
        };
      }
    }),
  );

  return { at: now, endpoints };
}
