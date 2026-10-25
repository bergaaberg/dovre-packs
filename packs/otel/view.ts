/** OpenTelemetry pack views: the /otel page, the Today card and the /deploys prod pill. Built from core's kit. */
import { html } from "hono/html";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill, type Html } from "dovre/ui/kit.ts";
import { BAD_ERR, BAD_P95, WARN_ERR, WARN_P95, type OtelAlert, type OtelKept, type OtelService } from "./data.ts";

type Tone = "ok" | "warn" | "bad" | "neutral";
const TONE: Record<OtelService["status"], Tone> = { ok: "ok", warn: "warn", bad: "bad", none: "neutral" };
const WORD: Record<OtelService["status"], string> = { ok: "ok", warn: "degraded", bad: "down", none: "no data" };

const statusPill = (s: OtelService["status"]) => Pill({ tone: TONE[s], children: WORD[s] });
const num = (n: number) => n.toLocaleString("en-US");
const toneOf = (n: number, warn: number, bad: number): Tone => (n >= bad ? "bad" : n >= warn ? "warn" : "neutral");

/** One service: its state, RED numbers, version and its alerts. */
function serviceItem(s: OtelService): Html {
  return Item({
    leadTone: TONE[s.status],
    title: html`<strong>${s.name}</strong> ${statusPill(s.status)}${s.version ? html` <span class="t3">v${s.version}</span>` : ""}`,
    line:
      s.status === "none"
        ? html`No request series for <code>service_name="${s.name}"</code>: check the name, or how the backend labels services.`
        : html`${num(s.rps)} req/s · ${Pill({ tone: toneOf(s.errPct, WARN_ERR, BAD_ERR), children: `${num(s.errPct)}% 5xx` })} · ${Pill({ tone: toneOf(s.p95, WARN_P95, BAD_P95), children: `p95 ${num(s.p95)}ms` })} · p99 ${num(s.p99)}ms`,
    more: s.alerts.length ? html`${s.alerts.map((a) => Pill({ tone: a.severity === "critical" ? "bad" : "warn", children: a.name, title: a.summary }))}` : undefined,
  });
}

function alertList(alerts: OtelAlert[]): Html {
  return List(
    alerts.map((a) =>
      Item({
        leadTone: a.severity === "critical" ? "bad" : "warn",
        title: html`<strong>${a.name}</strong>${a.service ? html` on ${a.service}` : ""} ${Pill({ tone: a.severity === "critical" ? "bad" : "warn", children: a.severity })}`,
        line: a.summary ?? "",
      }),
    ),
  );
}

export function otelPage(kept: OtelKept | undefined): Html {
  const hot = kept?.ok ? kept.services.filter((s) => s.status === "warn" || s.status === "bad") : [];
  const blind = kept?.ok ? kept.services.filter((s) => s.status === "none") : [];
  return html`${PageHeader({ title: "OpenTelemetry", sub: kept?.ok ? html`From ${kept.url}, read ${new Date(kept.at).toLocaleTimeString("en-GB")}` : "RED metrics and firing alerts from a Prometheus-compatible API" })}
<div data-live id="otel">
${!kept ? Notice({ children: "Reading the metrics API…" }) : ""}
${kept && !kept.ok ? Notice({ tone: "bad", children: html`OpenTelemetry: ${kept.error}` }) : ""}
${kept?.ok && hot.length ? Notice({ tone: hot.some((s) => s.status === "bad") ? "bad" : "warn", children: `${hot.length} of ${kept.services.length} services need a look.` }) : ""}
${kept?.ok && blind.length ? Notice({ tone: "warn", children: `No data for ${blind.map((s) => s.name).join(", ")}.` }) : ""}
${kept?.ok
  ? Panel({ title: "Services", meta: `${kept.services.length} watched`, flush: true, children: kept.services.length ? List(kept.services.map(serviceItem)) : Empty({ title: "No services" }) })
  : ""}
${kept?.ok && kept.alerts.length ? Panel({ title: "Firing alerts", meta: String(kept.alerts.length), flush: true, children: alertList(kept.alerts) }) : ""}
</div>`;
}

/** Today's card: only when a service is degraded or an alert fires. */
export function otelCard(kept: OtelKept | undefined): Html | "" {
  if (!kept?.ok) return "";
  const hot = kept.services.filter((s) => s.status === "warn" || s.status === "bad");
  if (!hot.length && !kept.alerts.length) return "";
  return Card({
    id: "otel-now",
    title: "OpenTelemetry",
    meta: html`<a href="/otel">Open</a>`,
    children: hot.length ? List(hot.map(serviceItem)) : alertList(kept.alerts),
  });
}

/** The `deploy.prod` slot: the running version and its state, beside a mapped repo on /deploys. */
export function otelProd(kept: OtelKept | undefined, repo: string): Html | "" {
  if (!kept?.ok) return "";
  const s = kept.services.find((x) => x.repo === repo);
  if (!s) return "";
  return html`<span class="t3">prod v${s.version ?? "?"}</span> ${statusPill(s.status)}`;
}
