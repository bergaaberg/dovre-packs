/** OpenTelemetry pack views: the /otel service table, the Today card, and the /deploys prod pill. */
import { html, raw } from "hono/html";
import type { Html } from "dovre/ui/kit.ts";
import { BAD_ERR, BAD_P95, WARN_ERR, WARN_P95, type OtelKept, type OtelService } from "./data.ts";

const dot = (s: OtelService["status"]) =>
  s === "bad" ? `<span class="pill bad">down bad</span>` : s === "warn" ? `<span class="pill warn">degraded</span>` : `<span class="pill ok">ok</span>`;

const num = (n: number, unit = "") => `${n.toLocaleString("en-US")}${unit}`;

/** A service row: RED numbers, version and its alerts, with the pill that says its state. */
function row(s: OtelService): Html {
  return html`<tr>
    <td>${dot(s.status)} <b>${s.name}</b>${s.version ? html` <span class="mute">v${s.version}</span>` : ""}</td>
    <td class="num">${num(s.rps)} req/s</td>
    <td class="num ${s.errPct >= BAD_ERR ? "bad" : s.errPct >= WARN_ERR ? "warn" : ""}">${num(s.errPct)}% 5xx</td>
    <td class="num ${s.p95 >= BAD_P95 ? "bad" : s.p95 >= WARN_P95 ? "warn" : ""}">p95 ${num(s.p95)}ms</td>
    <td class="num">${num(s.p99)}ms</td>
    <td>${s.alerts.length ? html`<ul class="ticks">${s.alerts.map((a) => html`<li class="${a.severity === "critical" ? "bad" : "warn"}">${a.name}${a.summary ? html` — ${a.summary}` : ""}</li>`)}</ul>` : html`<span class="mute">—</span>`}</td>
  </tr>`;
}

export function otelPage(kept: OtelKept | undefined): Html {
  if (!kept) return html`<p class="mute">Reading the metrics API…</p>`;
  if (!kept.ok) return html`<p class="note bad">OpenTelemetry: ${kept.error}</p>`;
  const hot = kept.services.filter((s) => s.status !== "ok");
  return html`
    ${hot.length ? html`<p class="note ${hot.some((s) => s.status === "bad") ? "bad" : "warn"}">${hot.length} of ${kept.services.length} services need a look.</p>` : html`<p class="note ok">All ${kept.services.length} services healthy.</p>`}
    <table>
      <thead><tr><th>Service</th><th class="num">Rate</th><th class="num">Errors</th><th class="num">Duration</th><th class="num">p99</th><th>Alerts</th></tr></thead>
      <tbody>${kept.services.map(row)}</tbody>
    </table>
    ${kept.alerts.length ? html`<h3>Firing alerts</h3><ul class="ticks">${kept.alerts.map((a) => html`<li class="${a.severity === "critical" ? "bad" : "warn"}">${a.name}${a.service ? html` on ${a.service}` : ""}${a.summary ? html` — ${a.summary}` : ""}</li>`)}</ul>` : html``}
    <p class="mute">From ${kept.url}, ${new Date(kept.at).toLocaleString("en-US")}.</p>`;
}

/** Today's card: the RED table, compact, only when something is worth a look. */
export function otelCard(kept: OtelKept | undefined): Html {
  if (!kept?.ok) return html``;
  const hot = kept.services.filter((s) => s.status !== "ok");
  if (!hot.length && !kept.alerts.length) return html``;
  return html`<div class="card" data-live="otel">
    <h3>Signals</h3>
    <p class="${hot.some((s) => s.status === "bad") ? "note bad" : "note warn"}">${hot.length ? `${hot.map((s) => s.name).join(", ")} degraded` : "alerts firing"}</p>
    <table><tbody>${hot.map(row)}</tbody></table>
  </div>`;
}

/** The `deploy.prod` slot: the running version and its state, beside a mapped repo on /deploys. */
export function otelProd(kept: OtelKept | undefined, repo: string): Html | "" {
  if (!kept?.ok) return "";
  const s = kept.services.find((x) => x.repo === repo);
  if (!s) return "";
  return html`<span class="mute">prod v${s.version ?? "?"}</span> ${raw(dot(s.status))}`;
}
