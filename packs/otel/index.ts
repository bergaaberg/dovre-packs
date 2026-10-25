/**
 * OpenTelemetry & Prometheus pack (`otel`): RED metrics per service from a Prometheus-compatible
 * API, firing alerts, a 24h error lane on Today's horizon, avatar storm/fire, and the running
 * version beside mapped repos on /deploys. Reads only in `refresh()`; everything else is memory.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { type OtelKept, readOtel } from "./data.ts";
import { otelCard, otelPage, otelProd } from "./view.ts";

export function createOtelPack(opts: { fetchFn?: typeof fetch } = {}): Pack & { kept(): OtelKept | undefined } {
  let kept: OtelKept | undefined;
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "otel",
      name: "OpenTelemetry & Prometheus",
      description: "RED metrics, firing alerts and prod versions from Prometheus / Mimir / VictoriaMetrics / Grafana Cloud.",
      domain: "general",
      execution: "any",
      everyMs: 3 * 60_000,
      settings: [
        { key: "OTEL_PROMETHEUS_URL", label: "Prometheus API base URL", required: true, help: "e.g. https://prom.example.com or a Grafana Cloud / Mimir / VictoriaMetrics endpoint" },
        { key: "OTEL_BEARER_TOKEN", label: "Bearer or Basic token", secret: true, help: "Sent as Authorization: Bearer (or Basic when it contains a colon)" },
        { key: "OTEL_SERVICES", label: "Service names", help: 'Comma-separated, with optional repo mapping: "api,web=bergaaberg/web" — mapped ones show their prod version on /deploys' },
      ],
    },
    async refresh(ctx) {
      kept = await readOtel(ctx, opts.fetchFn);
      ctx.publish(["otel", "snapshot"]);
    },
    nav: () => [{ href: "/otel", title: "OTel", icon: "chart", group: "Ops" }],
    pages: () => [{ title: "OpenTelemetry", href: "/otel", icon: "~", about: "RED metrics, alerts and prod versions", also: ["prometheus", "metrics", "observability"] }],
    routes(app, ctx) {
      app.get("/otel", (c) => ctx.page(c, { title: "OpenTelemetry", body: otelPage(kept) }));
    },
    today: () => {
      const card = otelCard(kept);
      return card ? [{ id: "otel", render: card }] : [];
    },
    glance() {
      if (!kept?.ok || !kept.services.length) return [];
      return [{ label: "req/s", value: Math.round(kept.services.reduce((a, s) => a + s.rps, 0) * 10) / 10 }];
    },
    avatar() {
      if (!kept?.ok) return undefined;
      const bad = kept.services.filter((s) => s.status === "bad");
      const warn = kept.services.filter((s) => s.status === "warn");
      const firing = kept.alerts.length > 0;
      if (bad.length) return { trouble: { level: "fire", why: `${bad.map((s) => s.name).join(", ")}: 5xx or latency breach`, href: "/otel" }, onDuty: firing };
      if (warn.length) return { trouble: { level: "storm", why: `${warn.map((s) => s.name).join(", ")}: elevated latency or errors`, href: "/otel" }, onDuty: firing };
      return firing ? { onDuty: true } : undefined;
    },
    lane() {
      if (!kept?.ok) return undefined;
      const marks = [];
      for (const s of kept.services) {
        for (const p of s.errHourly) if (p.pct >= 1) marks.push({ at: p.at, size: p.pct >= 5 ? 6 : p.pct >= 2 ? 4 : 2, title: `${s.name}: ${p.pct}% 5xx` });
        for (const a of s.alerts) if (a.since) marks.push({ at: a.since, size: a.severity === "critical" ? 8 : 5, title: `${a.name} on ${s.name} (${a.severity})` });
      }
      if (!marks.length) return undefined;
      return { label: "OTel", legend: "5xx spikes and firing alerts, by service", marks: marks.slice(-60) };
    },
    bino() {
      if (!kept) return "";
      if (!kept.ok) return `OTel: error (${kept.error})`;
      const parts = kept.services.map((s) => `${s.name} [${s.status}]: ${s.rps} req/s, ${s.errPct}% 5xx, p95 ${s.p95}ms${s.version ? `, v${s.version}` : ""}`);
      if (kept.alerts.length) parts.push(`${kept.alerts.length} alert${kept.alerts.length > 1 ? "s" : ""} firing: ${kept.alerts.map((a) => `${a.name} (${a.severity})`).join(", ")}`);
      return parts.join("\n");
    },
    slots() {
      return { "deploy.prod": ({ repo }) => otelProd(kept, repo) };
    },
  };
}

export const otelPack: Pack = createOtelPack();
export const otelCrate = otelPack;
