/**
 * OTel sink views: the services page, a service's page (RED, errors, metrics), a trace's
 * waterfall, the log tail, the Today card and the /deploys pill. Built from core's kit; every
 * value from a sender is escaped by `html`, and every link is a path of ours through safeUrl.
 */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Pulse, Stat, Stats, type Html } from "dovre/ui/kit.ts";
import { LEVELS, levelName } from "./otlp.ts";
import { BAD_ERR, WARN_ERR, type ErrorSpan, type LogEntry, type ServiceSum, type SinkKept, type TraceSpan } from "./store.ts";

export const ID = "otel-sink";
type Tone = "ok" | "warn" | "bad" | "neutral";
const TONE: Record<ServiceSum["status"], Tone> = { ok: "ok", warn: "warn", bad: "bad", quiet: "neutral" };
const WORD: Record<ServiceSum["status"], string> = { ok: "ok", warn: "erroring", bad: "failing", quiet: "quiet" };

export const serviceHref = (name: string) => safeUrl(`/${ID}/service/${encodeURIComponent(name)}`);
export const traceHref = (id: string) => safeUrl(`/${ID}/trace/${encodeURIComponent(id)}`);
export const logsHref = (q: { service?: string; level?: string; trace?: string }) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return safeUrl(`/${ID}/logs${s ? `?${s}` : ""}`);
};

const num = (n: number) => n.toLocaleString("en-US");
const ms = (n: number) => (n >= 1000 ? `${num(Math.round(n / 100) / 10)}s` : `${num(Math.round(n * 10) / 10)}ms`);
const time = (atMs: number) => new Date(atMs).toISOString().slice(11, 19);
const ago = (atMs: number, now: number) => {
  const s = Math.max(0, Math.round((now - atMs) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const pill = (s: ServiceSum["status"]) => Pill({ tone: TONE[s], children: WORD[s] });
const errTone = (pct: number): Tone => (pct >= BAD_ERR ? "bad" : pct >= WARN_ERR ? "warn" : "neutral");

function pulse(s: ServiceSum): Html | "" {
  return Pulse({ requests: s.hourly.map((h) => h.n), errors: s.hourly.map((h) => h.e), labels: s.hourly.map((h) => `${new Date(h.at).toISOString().slice(11, 16)}`), label: `${s.name}, last 24 hours` });
}

function serviceItem(s: ServiceSum, now: number): Html {
  return Item({
    href: serviceHref(s.name),
    leadTone: TONE[s.status],
    title: html`<strong>${s.name}</strong> ${pill(s.status)}${s.version ? html` <span class="t3">v${s.version}</span>` : ""}${s.environment ? html` <span class="t3">${s.environment}</span>` : ""}`,
    line:
      s.status === "quiet"
        ? html`No requests in the last 15 minutes · last heard ${ago(s.lastAt, now)}`
        : html`${num(s.rpm)} req/min · ${Pill({ tone: errTone(s.errPct), children: `${num(s.errPct)}% errors` })} · p50 ${ms(s.p50)} · p95 ${ms(s.p95)}`,
    more: pulse(s),
  });
}

function errorItem(e: ErrorSpan, withService: boolean): Html {
  return Item({
    href: traceHref(e.trace_id),
    leadTone: "bad",
    title: html`<strong>${e.err_type ?? (e.http_status ? `HTTP ${e.http_status}` : "Error")}</strong> in ${e.name}${withService ? html` <span class="t3">${e.service}</span>` : ""}`,
    line: html`${e.err_msg ?? ""}${e.err_msg ? " · " : ""}${time(e.start_us / 1000)} · trace <code>${e.trace_id.slice(0, 12)}</code>`,
  });
}

function notReady(kept: SinkKept | undefined): Html | "" {
  if (!kept) return Notice({ children: "Reading what came in…" });
  if (!kept.ok) return Notice({ tone: "bad", children: html`OTel sink: ${kept.error}` });
  return "";
}

const howTo = () =>
  Empty({
    title: "Nothing in yet",
    children: html`<p class="notes">Make an ingest token on Settings, then point an OTLP/HTTP exporter at <code>/${ID}/ingest</code>: <code>OTEL_EXPORTER_OTLP_ENDPOINT=&lt;this Dovre&gt;/${ID}/ingest</code> and <code>OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20&lt;token&gt;</code>. JSON or protobuf, gzip or not.</p>`,
  });

export function sinkPage(kept: SinkKept | undefined): Html {
  const hot = kept?.ok ? kept.services.filter((s) => s.status === "warn" || s.status === "bad") : [];
  return html`${PageHeader({ title: "OTel sink", sub: "Traces, metrics and logs your apps send straight in: 24 hours of spans and logs, 7 days of metrics", actions: html`<a href="${logsHref({})}">Log tail</a>` })}
<div data-live id="${ID}">
${notReady(kept)}
${kept?.ok && hot.length ? Notice({ tone: hot.some((s) => s.status === "bad") ? "bad" : "warn", children: `${hot.length} of ${kept.services.length} services erroring.` }) : ""}
${kept?.ok
  ? html`${Panel({ title: "Services", meta: `${kept.services.length}`, flush: true, children: kept.services.length ? List(kept.services.map((s) => serviceItem(s, kept.at))) : howTo() })}
${kept.errors.length ? Panel({ title: "Latest errors", meta: String(kept.errors.length), flush: true, children: List(kept.errors.slice(0, 15).map((e) => errorItem(e, true))) }) : ""}
<p class="notes">Kept now: ${num(kept.counts.spans)} spans, ${num(kept.counts.logs)} log records, ${num(kept.counts.metrics)} metric hours. Read ${time(kept.at)} UTC.</p>`
  : ""}
</div>`;
}

export function servicePage(kept: SinkKept | undefined, name: string): Html {
  const s = kept?.ok ? kept.services.find((x) => x.name === name) : undefined;
  const crumbs = [{ href: safeUrl(`/${ID}`), label: "OTel sink" }, { label: name }];
  return html`${PageHeader({ title: name, crumbs, sub: s ? html`${s.version ? `v${s.version} · ` : ""}${s.environment ? `${s.environment} · ` : ""}via ${s.source}` : "", actions: html`<a href="${logsHref({ service: name })}">Logs</a>` })}
<div data-live id="${ID}">
${notReady(kept)}
${kept?.ok && !s ? Empty({ title: "No such service", children: html`<p class="notes">Nothing has come in from it in the last 7 days.</p>` }) : ""}
${s
  ? html`${Stats([
      Stat({ label: "Rate", value: `${num(s.rpm)}/min`, foot: "requests, last 15 min" }),
      Stat({ label: "Errors", value: `${num(s.errPct)}%`, tone: s.status === "bad" ? "bad" : s.status === "warn" ? "warn" : undefined, foot: `${num(s.errors)} of ${num(s.n)}` }),
      Stat({ label: "p50", value: ms(s.p50) }),
      Stat({ label: "p95", value: ms(s.p95) }),
    ])}
${Panel({ title: "Last 24 hours", meta: "requests by hour, errors in colour", children: pulse(s) || html`<p class="notes">No requests yet.</p>` })}
${(() => {
  const errs = kept!.ok ? kept!.errors.filter((e) => e.service === s.name) : [];
  return errs.length ? Panel({ title: "Latest errors", meta: String(errs.length), flush: true, children: List(errs.map((e) => errorItem(e, false))) }) : "";
})()}
${s.metrics.length
  ? Panel({ title: "Metrics", meta: "this hour or the last", flush: true, children: List(s.metrics.map((m) => Item({ title: html`<code>${m.name}</code>`, line: html`last ${num(Math.round(m.last * 1000) / 1000)}${m.unit ? ` ${m.unit}` : ""} · mean ${num(Math.round(m.avg * 1000) / 1000)}` }))) })
  : ""}`
  : ""}
</div>`;
}

type Node = { s: TraceSpan; depth: number };

/** The spans of a trace in tree order (parents before children, siblings by start). */
export function treeOrder(spans: TraceSpan[]): Node[] {
  const ids = new Set(spans.map((s) => s.span_id));
  const kids = new Map<string, TraceSpan[]>();
  for (const s of spans) {
    const p = s.parent_id && ids.has(s.parent_id) && s.parent_id !== s.span_id ? s.parent_id : "";
    const list = kids.get(p) ?? [];
    list.push(s);
    kids.set(p, list);
  }
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (p: string, depth: number) => {
    for (const s of (kids.get(p) ?? []).sort((a, b) => a.start_us - b.start_us)) {
      if (seen.has(s.span_id)) continue;
      seen.add(s.span_id);
      out.push({ s, depth });
      if (depth < 64) walk(s.span_id, depth + 1);
    }
  };
  walk("", 0);
  for (const s of spans) if (!seen.has(s.span_id)) out.push({ s, depth: 0 }); // a cycle's leftovers
  return out;
}

const KIND = ["", "internal", "server", "client", "producer", "consumer"];

export function tracePage(traceId: string, spans: TraceSpan[], logs: LogEntry[]): Html {
  const crumbs = [{ href: safeUrl(`/${ID}`), label: "OTel sink" }, { label: `Trace ${traceId.slice(0, 12)}` }];
  if (!spans.length)
    return html`${PageHeader({ title: "Trace", crumbs })}${Empty({ title: "No such trace", children: html`<p class="notes">Not here, or older than 24 hours.</p>` })}`;
  const start = Math.min(...spans.map((s) => s.start_us));
  const end = Math.max(...spans.map((s) => s.start_us + s.dur_us));
  const total = Math.max(1, end - start);
  const nodes = treeOrder(spans);
  const services = [...new Set(spans.map((s) => s.service))];
  const errs = spans.filter((s) => s.err).length;
  const rows = nodes.map(({ s, depth }) => {
    const x = Math.round(((s.start_us - start) / total) * 1000);
    const w = Math.max(2, Math.round((s.dur_us / total) * 1000));
    return html`<li class="${`osink-row osink-d${Math.min(depth, 8)}${s.err ? " osink-err" : ""}`}">
<div class="osink-label"><strong>${s.name}</strong> <span class="t3">${s.service}${KIND[s.kind] ? ` · ${KIND[s.kind]}` : ""}</span>${s.http_status ? html` ${Pill({ tone: s.http_status >= 500 ? "bad" : s.http_status >= 400 ? "warn" : "neutral", children: String(s.http_status) })}` : ""}${s.err ? html` ${Pill({ tone: "bad", children: "error" })}` : ""}</div>
<svg class="osink-bar" viewBox="0 0 1000 10" preserveAspectRatio="none" role="img" aria-label="${`${s.name}: ${ms(s.dur_us / 1000)} from +${ms((s.start_us - start) / 1000)}`}"><rect class="osink-track" x="0" y="0" width="1000" height="10"></rect><rect class="osink-span" x="${Math.min(x, 998)}" y="0" width="${Math.min(w, 1000 - Math.min(x, 998))}" height="10"></rect></svg>
<div class="osink-dur">${ms(s.dur_us / 1000)}</div>
${s.err && (s.err_type || s.err_msg) ? html`<div class="osink-detail">${s.err_type ?? ""}${s.err_type && s.err_msg ? ": " : ""}${s.err_msg ?? ""}</div>` : ""}
${s.http_method || s.http_route ? html`<div class="osink-detail t3">${s.http_method ?? ""} ${s.http_route ?? ""}</div>` : ""}
${s.attrs ? html`<div class="osink-detail t3">${attrsText(s.attrs)}</div>` : ""}
</li>`;
  });
  return html`${PageHeader({ title: html`Trace <code>${traceId.slice(0, 16)}</code>`, crumbs, sub: `${spans.length} spans · ${services.length} services · ${ms(total / 1000)}${errs ? ` · ${errs} with errors` : ""}`, actions: html`<a href="${logsHref({ trace: traceId })}">Logs for this trace</a>` })}
${Panel({ title: "Waterfall", meta: services.join(", "), flush: true, children: html`<ul class="osink-wf">${rows}</ul>` })}
${logs.length ? Panel({ title: "Logs", meta: String(logs.length), flush: true, children: logList(logs, true) }) : ""}`;
}

/** Kept extra attributes, as `key=value` text (they're JSON we wrote, but read back as untrusted). */
function attrsText(json: string): string {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(o)
      .slice(0, 20)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" · ");
  } catch {
    return "";
  }
}

const LEVEL_TONE = (sev: number): Tone => (sev >= 17 ? "bad" : sev >= 13 ? "warn" : "neutral");

function logList(logs: LogEntry[], inTrace: boolean): Html {
  return List(
    logs.map((l) =>
      Item({
        leadTone: LEVEL_TONE(l.severity),
        title: html`${Pill({ tone: LEVEL_TONE(l.severity), children: levelName(l.severity) })} ${l.body || (l.err_type ? "" : html`<span class="t3">(no body)</span>`)}${l.err_type ? html` <strong>${l.err_type}</strong>${l.err_msg ? `: ${l.err_msg}` : ""}` : ""}`,
        line: html`${time(l.at_us / 1000)} · <a href="${serviceHref(l.service)}">${l.service}</a>${!inTrace && l.trace_id ? html` · <a href="${traceHref(l.trace_id)}">trace <code>${l.trace_id.slice(0, 12)}</code></a>` : ""}${l.attrs ? html` · ${attrsText(l.attrs)}` : ""}`,
      }),
    ),
  );
}

export function logsPage(logs: LogEntry[], f: { service?: string; level?: string; trace?: string }, services: string[]): Html {
  const crumbs = [{ href: safeUrl(`/${ID}`), label: "OTel sink" }, { label: "Logs" }];
  return html`${PageHeader({ title: "Log tail", crumbs, sub: "Newest first, the last 200 that match" })}
<form method="get" action="${safeUrl(`/${ID}/logs`)}" class="osink-filter">
<label>Service <select name="service"><option value="">all</option>${services.map((s) => html`<option value="${s}"${s === f.service ? " selected" : ""}>${s}</option>`)}</select></label>
<label>Level <select name="level"><option value="">any</option>${LEVELS.map((l) => html`<option value="${l.name}"${l.name === f.level ? " selected" : ""}>${l.name} and up</option>`)}</select></label>
<label>Trace <input name="trace" value="${f.trace ?? ""}" maxlength="32" pattern="[0-9a-fA-F]{32}" placeholder="trace id"></label>
<button type="submit" class="sm">Filter</button>
</form>
${Panel({ title: "Logs", meta: String(logs.length), flush: true, children: logs.length ? logList(logs, false) : Empty({ title: "No log records match" }) })}`;
}

/** Today's card: only when a service is erroring. */
export function sinkCard(kept: SinkKept | undefined): Html | "" {
  if (!kept?.ok) return "";
  const hot = kept.services.filter((s) => s.status === "warn" || s.status === "bad");
  if (!hot.length) return "";
  return Card({ id: "otel-sink-now", title: "Erroring services", meta: html`<a href="${safeUrl(`/${ID}`)}">Open</a>`, children: List(hot.map((s) => serviceItem(s, kept.at))) });
}

/** The `deploy.prod` slot: the version a mapped repo's service last reported, and its state. */
export function sinkProd(kept: SinkKept | undefined, repo: string): Html | "" {
  if (!kept?.ok) return "";
  const s = kept.services.find((x) => x.repo === repo);
  if (!s) return "";
  return html`<a href="${serviceHref(s.name)}" class="t3">running v${s.version ?? "?"}</a> ${pill(s.status)}`;
}

export const STYLES = `
.osink-wf { list-style: none; margin: 0; padding: 0; }
.osink-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) 5rem; gap: 0.25rem 0.75rem; align-items: center; padding: 0.35rem 0.75rem; border-bottom: 1px solid var(--border); }
.osink-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osink-d1 .osink-label { padding-left: 0.75rem; } .osink-d2 .osink-label { padding-left: 1.5rem; } .osink-d3 .osink-label { padding-left: 2.25rem; }
.osink-d4 .osink-label { padding-left: 3rem; } .osink-d5 .osink-label { padding-left: 3.75rem; } .osink-d6 .osink-label { padding-left: 4.5rem; }
.osink-d7 .osink-label { padding-left: 5.25rem; } .osink-d8 .osink-label { padding-left: 6rem; }
svg.osink-bar { display: block; width: 100%; height: 10px; }
svg.osink-bar .osink-track { fill: transparent; }
svg.osink-bar .osink-span { fill: color-mix(in srgb, var(--text-3) 55%, transparent); }
.osink-err svg.osink-bar .osink-span { fill: var(--bad); }
.osink-dur { text-align: right; font-variant-numeric: tabular-nums; }
.osink-detail { grid-column: 1 / -1; font-size: 0.85em; overflow-wrap: anywhere; }
.osink-filter { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: end; margin: 0 0 1rem; }
@media (max-width: 640px) { .osink-row { grid-template-columns: minmax(0, 1fr) 4rem; } svg.osink-bar { grid-column: 1 / -1; grid-row: 2; } }
`;
