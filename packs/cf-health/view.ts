/** Cloudflare Health Pack (`cf-health`) views: Today card and `/cf-health` page. */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import type { CfHealthKept } from "./data.ts";

function renderList(k: CfHealthKept) {
  return List(
    k.workers.map((w) =>
      Item({
        lead: html`<span class="dot ${w.status}" role="img" aria-label="${w.status}"></span>`,
        href: w.dashboardUrl ? safeUrl(w.dashboardUrl) : undefined,
        title: html`<strong>${w.script}</strong> ${Pill({ tone: w.status, children: `${w.errorRatePct}% err` })}`,
        line: `${w.requests24h.toLocaleString("en-US")} req · ${w.errors24h.toLocaleString("en-US")} errors (24h)`,
      }),
    ),
  );
}

export function cfHealthPage(k: CfHealthKept | undefined) {
  return html`${PageHeader({ title: "Cloudflare Health", sub: "24h Workers GraphQL telemetry (workersInvocationsAdaptive)" })}
<div data-live id="cf-health">
${k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Cloudflare query failed" }) : ""}
${Panel({
  title: "Workers (24h)",
  meta: k ? `${k.workers.length} tracked` : "loading",
  flush: true,
  children: k?.workers.length ? renderList(k) : Empty({ title: k ? "No Workers reported traffic" : "Not read yet" }),
})}
</div>`;
}

export function cfHealthCard(k: CfHealthKept) {
  const body = !k.ok
    ? html`<p class="t2">${k.error ?? "Cloudflare telemetry unavailable"}</p>`
    : k.workers.length
      ? renderList(k)
      : html`<p class="t2">No Workers reported in the last 24h</p>`;
  return Card({ id: "cf-health-now", title: "Cloudflare Health", meta: html`<a href="/cf-health">Open</a>`, children: body });
}
