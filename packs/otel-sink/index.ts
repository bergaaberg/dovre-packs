/**
 * OTel sink pack (`otel-sink`): apps send OpenTelemetry straight into Dovre over OTLP/HTTP, no
 * collector or backend in between. POST /otel-sink/ingest/v1/{traces,metrics,logs} with an ingest
 * token from Settings (core checks it, the size and the rate: src/packs/ingest.ts). What comes in
 * is cut to an attribute allowlist and kept briefly in the pack's own tables (store.ts); refresh()
 * prunes and reads the summary into memory, which feeds the pages, Today's horizon, the avatar,
 * the needs (a service that starts erroring rings once) and the running version on /deploys.
 */
import { html } from "hono/html";
import { type Pack, type PackContext, type PackNeed, PACK_API } from "dovre/packs/types.ts";
import { Notice } from "dovre/ui/kit.ts";
import { LEVELS, SPAN_KEEP, decode, extraKeys, hexId, parseLogs, parseMetrics, parseTraces, type Signal } from "./otlp.ts";
import { encodeReply } from "./proto.ts";
import { LOG_RETENTION_MS, MAX_LOGS, MAX_METRIC_ROWS, MAX_SPANS, METRIC_RETENTION_MS, SPAN_RETENTION_MS, type SinkKept, ensureSchema, insertLogs, insertPoints, insertSpans, prune, readLogs, readSummary, readTrace } from "./store.ts";
import { ID, STYLES, logsPage, servicePage, serviceHref, sinkCard, sinkPage, sinkProd, tracePage } from "./view.ts";

/** `api,web=owner/web` → service name → repo, for the /deploys pill. */
export function repoMap(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== "string") return out;
  for (const part of raw.split(",")) {
    const [name, repo] = part.split("=").map((s) => s.trim());
    if (name && repo && /^[\w./-]{1,100}$/.test(name) && /^[\w.-]+\/[\w.-]+$/.test(repo)) out.set(name, repo);
  }
  return out;
}

const REJECTED: Record<Signal, string> = { traces: "rejectedSpans", metrics: "rejectedDataPoints", logs: "rejectedLogRecords" };

/** An OTLP reply: `{}` (or an empty protobuf message) when all was taken, else partial success. */
function reply(signal: Signal, proto: boolean, rejected: number, why: string) {
  if (proto) return { status: 200, body: encodeReply(rejected, why), contentType: "application/x-protobuf" };
  const body = rejected || why ? { partialSuccess: { [REJECTED[signal]]: rejected, errorMessage: why } } : {};
  return { status: 200, body: JSON.stringify(body), contentType: "application/json" };
}

export function createOtelSinkPack(opts: { now?: () => number } = {}): Pack & { kept(): SinkKept | undefined } {
  const now = opts.now ?? Date.now;
  let kept: SinkKept | undefined;
  /** Rows in since the last prune, by table: past a tenth of a cap, the ingest prunes itself. */
  const since = { spans: 0, logs: 0, metrics: 0 };
  const hot = () => (kept?.ok ? kept.services.filter((s) => s.status === "warn" || s.status === "bad") : []);

  async function pruneNow(ctx: PackContext) {
    since.spans = since.logs = since.metrics = 0;
    await prune(ctx.db, now());
  }

  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: ID,
      name: "OTel sink",
      description: "Receives OTLP/HTTP (traces, metrics, logs) straight from your apps: RED per service, errors with their trace, a waterfall, a log tail.",
      domain: "general",
      execution: "any",
      everyMs: 60_000,
      rings: [{ kind: "erroring", label: "A service starts erroring", hint: "Its share of failed requests over 15 minutes crosses 1% (or 5%)" }],
      settings: [
        { key: "OTEL_SINK_SERVICES", label: "Repos for services", help: 'Service names mapped to repos, "api=owner/api,web=owner/web": the version each reports shows beside its repo on /deploys' },
        { key: "OTEL_SINK_ATTRIBUTES", label: "Extra attributes to keep", help: "Comma-separated attribute keys kept besides the built-in list (shown on a trace's spans and on logs). Keys naming bodies, headers, cookies, tokens, sessions or user ids are never kept." },
        { key: "OTEL_SINK_LOG_BODIES", label: "Log bodies", help: '"off" keeps log records without their body (levels, services, trace ids and exceptions only)' },
      ],
    },
    styles: STYLES,
    async init(ctx) {
      if (ctx.db) await ensureSchema(ctx.db);
    },
    async refresh(ctx) {
      try {
        await ensureSchema(ctx.db);
        await pruneNow(ctx);
        kept = await readSummary(ctx.db, now(), repoMap(ctx.env.OTEL_SINK_SERVICES));
      } catch (e) {
        kept = { ok: false, error: e instanceof Error ? e.message : "reading the sink's tables failed" };
      }
      ctx.publish([ID, "snapshot"]);
    },
    ingest: {
      maxBytes: 4 * 1024 * 1024,
      async handle(input, ctx) {
        const d = await decode(input);
        if ("error" in d) return { status: d.status, body: d.error };
        await ensureSchema(ctx.db);
        const at = now();
        const extra = extraKeys(ctx.env.OTEL_SINK_ATTRIBUTES);
        let rejected = 0;
        let why = "";
        if (d.signal === "traces") {
          const p = parseTraces(d.req as never, { now: at, retentionMs: SPAN_RETENTION_MS, extra });
          since.spans += await insertSpans(ctx.db, p.rows, p.services, input.source, at);
          ({ rejected, why } = p);
        } else if (d.signal === "logs") {
          const p = parseLogs(d.req as never, { now: at, retentionMs: LOG_RETENTION_MS, extra, bodies: (ctx.env.OTEL_SINK_LOG_BODIES ?? "").trim().toLowerCase() !== "off" });
          since.logs += await insertLogs(ctx.db, p.rows, p.services, input.source, at);
          ({ rejected, why } = p);
        } else {
          const p = parseMetrics(d.req as never, { now: at, retentionMs: METRIC_RETENTION_MS, extra });
          since.metrics += await insertPoints(ctx.db, p.rows, p.services, input.source, at);
          ({ rejected, why } = p);
        }
        if (since.spans > MAX_SPANS / 10 || since.logs > MAX_LOGS / 10 || since.metrics > MAX_METRIC_ROWS / 10) await pruneNow(ctx);
        return reply(d.signal, d.proto, rejected, why);
      },
    },
    nav: () => [{ href: `/${ID}`, title: "OTel sink", icon: "chart", group: "Ops" }],
    pages: () => [
      { title: "OTel sink", href: `/${ID}`, icon: "~", about: "Traces, metrics and logs sent straight in", also: ["otlp", "traces", "spans", "observability"] },
      { title: "OTel sink logs", href: `/${ID}/logs`, icon: "~", about: "Log tail by service, level or trace", also: ["logs", "otlp"] },
    ],
    finds() {
      return kept?.ok ? kept.services.map((s) => ({ title: s.name, sub: `OTel sink · ${s.status}`, href: serviceHref(s.name) })) : [];
    },
    routes(app, ctx) {
      app.get(`/${ID}`, (c) => ctx.page(c, { title: "OTel sink", current: `/${ID}`, body: sinkPage(kept) }));
      app.get(`/${ID}/service/:name`, (c) => {
        const name = c.req.param("name").slice(0, 100);
        return ctx.page(c, { title: name, current: `/${ID}`, body: servicePage(kept, name) });
      });
      app.get(`/${ID}/trace/:id`, async (c) => {
        const id = hexId(c.req.param("id"), 16);
        if (!id) return c.notFound();
        try {
          await ensureSchema(ctx.db);
          const [spans, logs] = await Promise.all([readTrace(ctx.db, id), readLogs(ctx.db, { trace: id }, 100)]);
          return ctx.page(c, { title: `Trace ${id.slice(0, 12)}`, current: `/${ID}`, body: tracePage(id, spans, logs) });
        } catch (e) {
          return ctx.page(c, { title: "Trace", current: `/${ID}`, body: Notice({ tone: "bad", children: html`Reading the trace failed: ${e instanceof Error ? e.message : "unknown"}` }) });
        }
      });
      app.get(`/${ID}/logs`, async (c) => {
        const service = (c.req.query("service") ?? "").slice(0, 100) || undefined;
        const level = LEVELS.find((l) => l.name === c.req.query("level"));
        const trace = hexId(c.req.query("trace") ?? "", 16);
        const f = { service, level: level?.name, trace };
        try {
          await ensureSchema(ctx.db);
          const logs = await readLogs(ctx.db, { service, minSeverity: level?.min, trace });
          const services = kept?.ok ? kept.services.map((s) => s.name) : [];
          return ctx.page(c, { title: "OTel sink logs", current: `/${ID}`, body: logsPage(logs, f, service && !services.includes(service) ? [...services, service] : services) });
        } catch (e) {
          return ctx.page(c, { title: "OTel sink logs", current: `/${ID}`, body: Notice({ tone: "bad", children: html`Reading the logs failed: ${e instanceof Error ? e.message : "unknown"}` }) });
        }
      });
    },
    settings: () =>
      html`<p class="notes">Kept on arrival: <code>service.name</code>, <code>service.version</code>, <code>deployment.environment</code>, span names, kinds, status and durations, ${SPAN_KEEP.map((k, i) => html`${i ? ", " : ""}<code>${k}</code>`)}, and an error's exception type and message (cut short). Everything else is dropped: bodies, headers, user ids; URLs lose their query string, and e-mail addresses in messages are masked. Spans and logs are kept 24 hours, metric rollups 7 days, at most ${MAX_SPANS.toLocaleString("en-US")} spans and ${MAX_LOGS.toLocaleString("en-US")} log records.</p>`,
    today: () => {
      const card = sinkCard(kept);
      return card ? [{ id: ID, render: card }] : [];
    },
    needs(): PackNeed[] {
      return hot().map((s) => ({
        key: `erroring ${s.name}${s.status === "bad" ? " bad" : ""}`,
        title: `${s.name} is erroring: ${s.errPct}% of requests failed in 15 minutes`,
        line: `${s.errors} of ${s.n} requests${s.version ? ` · v${s.version}` : ""}`,
        href: serviceHref(s.name),
        tone: s.status === "bad" ? "bad" : "warn",
        rank: s.status === "bad" ? 1 : 2,
        at: kept?.ok ? kept.at : now(),
        ring: "erroring",
        label: "OTel sink",
      }));
    },
    avatar() {
      const h = hot();
      if (!h.length) return undefined;
      const bad = h.filter((s) => s.status === "bad").length;
      return { trouble: { level: bad ? "fire" : "storm", why: bad ? `${bad} service${bad > 1 ? "s" : ""} failing` : `${h.length} service${h.length > 1 ? "s" : ""} erroring`, href: `/${ID}` } };
    },
    lane() {
      if (!kept?.ok) return undefined;
      const marks = [];
      for (const s of kept.services)
        for (const h of s.hourly) {
          const pct = h.n ? (100 * h.e) / h.n : 100;
          if (h.e >= 2 && pct >= 1) marks.push({ at: h.at + 1800_000, size: pct >= 5 ? 6 : pct >= 2 ? 4 : 2, title: `${s.name}: ${h.e} errors (${Math.round(pct * 10) / 10}%)` });
        }
      if (!marks.length) return undefined;
      return { label: "OTel sink", legend: "Failed requests by hour, by service", marks: marks.sort((a, b) => a.at - b.at).slice(-60) };
    },
    bino() {
      if (!kept) return "";
      if (!kept.ok) return `OTel sink: error (${kept.error})`;
      return kept.services.map((s) => `${s.name} [${s.status}]: ${s.rpm} req/min, ${s.errPct}% errors, p95 ${s.p95}ms${s.version ? `, v${s.version}` : ""}`).join("\n");
    },
    about: (_ctx, path) => (path.startsWith(`/${ID}/trace/`) ? "A trace's waterfall in the OTel sink" : path.startsWith(`/${ID}/logs`) ? "The OTel sink's log tail" : undefined),
    slots() {
      return { "deploy.prod": ({ repo }) => sinkProd(kept, repo) };
    },
  };
}

export const otelSinkPack: Pack = createOtelSinkPack();
