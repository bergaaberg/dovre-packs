/** HTTP & OpenTelemetry Pack (`http-otel`) views: `/http-otel` page and Today card. */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import type { HttpOtelKept } from "./data.ts";

function renderEndpoints(k: HttpOtelKept) {
  return List(
    k.endpoints.map((ep) =>
      Item({
        lead: html`<span class="dot ${ep.status}" role="img" aria-label="${ep.status}"></span>`,
        href: safeUrl(ep.url),
        title: html`<strong>${ep.name}</strong> ${Pill({ tone: ep.status, children: ep.ok ? `${ep.latencyMs} ms` : "DOWN" })}`,
        line: ep.detail ?? `HTTP ${ep.statusCode}`,
      }),
    ),
  );
}

export function httpOtelPage(k: HttpOtelKept | undefined) {
  return html`${PageHeader({ title: "HTTP & OpenTelemetry", sub: "Endpoint health checks (/healthz) and collector status" })}
<div data-live id="http-otel">
${Panel({
  title: "Endpoints",
  meta: k ? `${k.endpoints.filter((e) => e.ok).length}/${k.endpoints.length} up` : "loading",
  flush: true,
  children: k?.endpoints.length ? renderEndpoints(k) : Empty({ title: k ? "No HTTP_HEALTH_URLS configured" : "Not read yet" }),
})}
</div>`;
}

export function httpOtelCard(k: HttpOtelKept) {
  return Card({
    id: "http-otel-now",
    title: "HTTP & OTel Health",
    meta: html`<a href="/http-otel">Open</a>`,
    children: k.endpoints.length ? renderEndpoints(k) : html`<p class="t2">No endpoints configured</p>`,
  });
}
