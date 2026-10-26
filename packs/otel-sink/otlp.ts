/**
 * From an OTLP/HTTP request to the rows the sink keeps. Every sender is hostile: the body is
 * inflated under a cap, decoded (JSON or protobuf, see proto.ts), and each span, log and metric
 * point is cut down to an allowlist of attributes on arrival: what isn't on the list (request
 * bodies, headers, user ids…) is never stored. URL-ish values lose their query string and
 * fragment, every string is cut to size, and ids must be the hex they claim to be.
 */
import { type AnyValue, type HistogramPoint, type KeyValue, type LogsRequest, type MetricsRequest, type NumberPoint, type OtlpLog, type OtlpMetric, type OtlpSpan, type Resource, type TracesRequest, decodeLogs, decodeMetrics, decodeTraces } from "./proto.ts";

/** What a request may inflate to; more is refused (a zip bomb stops here). */
export const MAX_INFLATED = 16 * 1024 * 1024;
/** Most items taken from one request; the rest are rejected (partial success). */
export const MAX_ITEMS = 5000;

/** Resource attributes kept, besides the service's name (which every row has). */
const RESOURCE_KEEP = ["service.version", "deployment.environment", "deployment.environment.name"];
/** Span attributes kept, old and new semantic-convention names. */
export const SPAN_KEEP = ["http.method", "http.request.method", "http.route", "http.status_code", "http.response.status_code"];
/** Never kept, whatever the extra allowlist says: what a request carries about a person or a secret. */
const NEVER = /(^|\.)(body|headers?|cookie|authorization|password|passwd|secret|token|api[._-]?key|session|user\.(id|email|name|full_name|hash))(\.|$)/i;

export type Limits = { now: number; retentionMs: number; extra: Set<string> };

export type SpanRow = {
  trace_id: string;
  span_id: string;
  parent_id: string;
  service: string;
  name: string;
  kind: number;
  start_us: number;
  dur_us: number;
  status: number;
  http_method: string | null;
  http_route: string | null;
  http_status: number | null;
  err: number;
  entry: number;
  err_type: string | null;
  err_msg: string | null;
  attrs: string | null;
};
export type LogRow = { at_us: number; service: string; severity: number; body: string; trace_id: string | null; span_id: string | null; err_type: string | null; err_msg: string | null; attrs: string | null };
export type PointRow = { service: string; name: string; unit: string; hour: number; value: number };
export type ServiceSeen = { name: string; version: string | null; environment: string | null };
export type Parsed<T> = { rows: T[]; services: ServiceSeen[]; rejected: number; why: string };

/** Cuts a string to `n` characters, dropping control characters (they'd only garble a page). */
export function clip(s: unknown, n: number): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A URL or path without its query string or fragment: `/pay?card=…#x` → `/pay`. */
export const noQuery = (s: string) => s.replace(/[?#].*$/s, "");

/** In free text (a log body, an exception message): URLs lose their query, addresses are masked. */
export function scrub(s: string): string {
  return s
    .slice(0, 2000) // every caller keeps far less; this bounds the regexes' work on a huge value
    .replace(/\b((?:https?|wss?):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}

/** A 16- or 8-byte id as lowercase hex, from hex (OTLP/JSON) or base64 (proto3 JSON); undefined otherwise. */
export function hexId(v: unknown, bytes: 16 | 8): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  if (v.length === bytes * 2 && /^[0-9a-f]+$/i.test(v)) {
    const h = v.toLowerCase();
    return /^0+$/.test(h) ? undefined : h;
  }
  if (v.length <= 32 && /^[A-Za-z0-9+/_-]+=*$/.test(v)) {
    try {
      const bin = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
      if (bin.length !== bytes) return undefined;
      const h = Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      return /^0+$/.test(h) ? undefined : h;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Nanoseconds since the epoch (a string or number) → microseconds; 0 when it isn't one. */
export function micros(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v / 1000) : 0;
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) {
    try {
      return Number(BigInt(v) / 1000n);
    } catch {
      return 0;
    }
  }
  return 0;
}

/** A scalar attribute value as a string or number; nested values (arrays, kvlists, bytes) are dropped. */
function scalar(v: AnyValue | undefined): string | number | boolean | undefined {
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.intValue === "number" && Number.isFinite(v.intValue)) return v.intValue;
  if (typeof v.intValue === "string" && /^-?\d{1,19}$/.test(v.intValue)) return Number(v.intValue);
  if (typeof v.doubleValue === "number" && Number.isFinite(v.doubleValue)) return v.doubleValue;
  return undefined;
}

const attrList = (a: unknown): KeyValue[] => (Array.isArray(a) ? a.slice(0, 256).filter((x): x is KeyValue => !!x && typeof x === "object" && typeof (x as KeyValue).key === "string") : []);

function attrMap(a: unknown): Map<string, string | number | boolean> {
  const m = new Map<string, string | number | boolean>();
  for (const kv of attrList(a)) {
    const v = scalar(kv.value);
    if (v !== undefined && !m.has(kv.key!)) m.set(kv.key!, v);
  }
  return m;
}

/** A kept value: strings cut to size, and a URL-ish one (by key or by look) without its query. */
function keptValue(key: string, v: string | number | boolean): string | number | boolean {
  if (typeof v !== "string") return v;
  const urlish = /(^|\.)(url|uri|target|path|route|full|href|link)(\.|$)/i.test(key) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.startsWith("/");
  return clip(urlish ? noQuery(v) : scrub(v), 200);
}

/** The extra attributes the setting lets through (never one NEVER names), as a small JSON object. */
function extras(m: Map<string, string | number | boolean>, extra: Set<string>): string | null {
  if (!extra.size) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of m) {
    if (!extra.has(k) || NEVER.test(k) || n >= 20) continue;
    out[k] = keptValue(k, v);
    n++;
  }
  return n ? JSON.stringify(out) : null;
}

/** OTEL_SINK_ATTRIBUTES → the set of extra keys: plain attribute names only. */
export function extraKeys(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== "string") return out;
  for (const k of raw.split(",")) {
    const key = k.trim();
    if (/^[A-Za-z0-9_.-]{1,100}$/.test(key) && !NEVER.test(key)) out.add(key);
  }
  return out;
}

const str = (v: string | number | boolean | undefined) => (v === undefined ? null : String(v));
const int = (v: string | number | boolean | undefined) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : null;
};

/** The service a resource names, and what else of it is kept. */
function serviceOf(r: Resource | undefined): ServiceSeen {
  const m = attrMap(r?.attributes);
  const name = clip(String(m.get("service.name") ?? ""), 100).trim() || "unknown_service";
  const env = m.get(RESOURCE_KEEP[1]!) ?? m.get(RESOURCE_KEEP[2]!);
  return { name, version: m.has(RESOURCE_KEEP[0]!) ? clip(String(m.get(RESOURCE_KEEP[0]!)), 60) : null, environment: env === undefined ? null : clip(String(env), 40) };
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const enumNum = (v: unknown, names: string[]): number => {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const i = names.indexOf(v);
    if (i >= 0) return i;
    if (/^\d+$/.test(v)) return Number(v);
  }
  return 0;
};
const KINDS = ["SPAN_KIND_UNSPECIFIED", "SPAN_KIND_INTERNAL", "SPAN_KIND_SERVER", "SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER", "SPAN_KIND_CONSUMER"];
const CODES = ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"];

function addService(list: ServiceSeen[], s: ServiceSeen) {
  const had = list.find((x) => x.name === s.name);
  if (!had) list.push(s);
  else {
    had.version ??= s.version;
    had.environment ??= s.environment;
  }
}

/** The exception an error carries: from its "exception" event, else its attributes. */
function exceptionOf(span: OtlpSpan, m: Map<string, string | number | boolean>): { type: string | null; msg: string | null } {
  const ev = asArray<{ name?: string; attributes?: KeyValue[] }>(span.events).find((e) => e?.name === "exception");
  const em = ev ? attrMap(ev.attributes) : m;
  const type = em.get("exception.type");
  const msg = em.get("exception.message");
  return { type: type === undefined ? null : clip(String(type), 120), msg: msg === undefined ? null : clip(scrub(String(msg)), 300) };
}

export function parseTraces(req: TracesRequest, lim: Limits): Parsed<SpanRow> {
  const rows: SpanRow[] = [];
  const services: ServiceSeen[] = [];
  let rejected = 0;
  let why = "";
  const oldest = (lim.now - lim.retentionMs) * 1000;
  const newest = (lim.now + 3600_000) * 1000;
  for (const rs of asArray<{ resource?: Resource; scopeSpans?: unknown }>(req?.resourceSpans)) {
    const svc = serviceOf(rs?.resource);
    for (const ss of asArray<{ spans?: unknown }>(rs?.scopeSpans)) {
      for (const sp of asArray<OtlpSpan>(ss?.spans)) {
        if (rows.length >= MAX_ITEMS) {
          rejected++;
          why = `more than ${MAX_ITEMS} spans in one request`;
          continue;
        }
        const trace = hexId(sp?.traceId, 16);
        const id = hexId(sp?.spanId, 8);
        const start = micros(sp?.startTimeUnixNano);
        const end = micros(sp?.endTimeUnixNano);
        if (!trace || !id) {
          rejected++;
          why ||= "a span without a valid trace or span id";
          continue;
        }
        if (!start || start < oldest || start > newest) {
          rejected++;
          why ||= "a span outside the kept window (24h)";
          continue;
        }
        addService(services, svc);
        const m = attrMap(sp.attributes);
        const status = enumNum(sp.status?.code, CODES);
        const httpStatus = int(m.get("http.response.status_code") ?? m.get("http.status_code"));
        const kind = enumNum(sp.kind, KINDS);
        const parent = hexId(sp.parentSpanId, 8) ?? "";
        const isErr = status === 2 || (httpStatus !== null && httpStatus >= 500 && kind !== 3);
        const ex = isErr ? exceptionOf(sp, m) : { type: null, msg: null };
        const statusMsg = isErr && !ex.msg && typeof sp.status?.message === "string" ? clip(scrub(sp.status.message), 300) : null;
        const route = m.get("http.route");
        const method = str(m.get("http.request.method") ?? m.get("http.method"));
        rows.push({
          trace_id: trace,
          span_id: id,
          parent_id: parent,
          service: svc.name,
          name: clip(noQuery(String(sp.name ?? "")), 120) || "(unnamed)",
          kind,
          start_us: start,
          dur_us: end > start ? Math.min(end - start, 86_400e6) : 0,
          status,
          http_method: method === null ? null : clip(method, 10),
          http_route: route === undefined ? null : clip(noQuery(String(route)), 120),
          http_status: httpStatus,
          err: isErr ? 1 : 0,
          entry: kind === 2 || kind === 5 || !parent ? 1 : 0,
          err_type: ex.type,
          err_msg: ex.msg ?? statusMsg,
          attrs: extras(m, lim.extra),
        });
      }
    }
  }
  return { rows, services, rejected, why };
}

/** Severity number → 1..24, from the number or else the text. */
export function severityOf(n: unknown, text: unknown): number {
  const num = typeof n === "number" ? n : typeof n === "string" ? Number(n.replace(/^SEVERITY_NUMBER_/, "")) || ["UNSPECIFIED", "TRACE", "TRACE2", "TRACE3", "TRACE4", "DEBUG", "DEBUG2", "DEBUG3", "DEBUG4", "INFO", "INFO2", "INFO3", "INFO4", "WARN", "WARN2", "WARN3", "WARN4", "ERROR", "ERROR2", "ERROR3", "ERROR4", "FATAL"].indexOf(n.replace(/^SEVERITY_NUMBER_/, "")) : 0;
  if (Number.isInteger(num) && num >= 1 && num <= 24) return num;
  const t = typeof text === "string" ? text.toLowerCase() : "";
  if (/fatal|crit|emerg|alert/.test(t)) return 21;
  if (/err/.test(t)) return 17;
  if (/warn/.test(t)) return 13;
  if (/info|notice/.test(t)) return 9;
  if (/debug/.test(t)) return 5;
  if (/trace/.test(t)) return 1;
  return 9;
}

export const LEVELS = [
  { name: "trace", min: 1 },
  { name: "debug", min: 5 },
  { name: "info", min: 9 },
  { name: "warn", min: 13 },
  { name: "error", min: 17 },
  { name: "fatal", min: 21 },
] as const;
export const levelName = (sev: number) => [...LEVELS].reverse().find((l) => sev >= l.min)?.name ?? "info";

export function parseLogs(req: LogsRequest, lim: Limits & { bodies: boolean }): Parsed<LogRow> {
  const rows: LogRow[] = [];
  const services: ServiceSeen[] = [];
  let rejected = 0;
  let why = "";
  const oldest = (lim.now - lim.retentionMs) * 1000;
  const newest = (lim.now + 3600_000) * 1000;
  for (const rl of asArray<{ resource?: Resource; scopeLogs?: unknown }>(req?.resourceLogs)) {
    const svc = serviceOf(rl?.resource);
    for (const sl of asArray<{ logRecords?: unknown }>(rl?.scopeLogs)) {
      for (const lr of asArray<OtlpLog>(sl?.logRecords)) {
        if (rows.length >= MAX_ITEMS) {
          rejected++;
          why = `more than ${MAX_ITEMS} log records in one request`;
          continue;
        }
        const at = micros(lr?.timeUnixNano) || micros(lr?.observedTimeUnixNano) || lim.now * 1000;
        if (at < oldest || at > newest) {
          rejected++;
          why ||= "a log record outside the kept window (24h)";
          continue;
        }
        addService(services, svc);
        const m = attrMap(lr.attributes);
        const b = scalar(lr.body);
        const body = !lim.bodies ? "" : b !== undefined ? clip(scrub(String(b)), 500) : lr.body && typeof lr.body === "object" && Object.keys(lr.body).length ? "(structured body, not kept)" : "";
        const et = m.get("exception.type");
        const em = m.get("exception.message");
        rows.push({
          at_us: at,
          service: svc.name,
          severity: severityOf(lr.severityNumber, lr.severityText),
          body,
          trace_id: hexId(lr.traceId, 16) ?? null,
          span_id: hexId(lr.spanId, 8) ?? null,
          err_type: et === undefined ? null : clip(String(et), 120),
          err_msg: em === undefined ? null : clip(scrub(String(em)), 300),
          attrs: extras(m, lim.extra),
        });
      }
    }
  }
  return { rows, services, rejected, why };
}

const HOUR_US = 3600e6;

/**
 * Metric points → one value each (gauge and sum: the value; histograms and summaries: the mean),
 * by service, metric and hour. Attributes on points aren't kept: the rollup is per metric.
 */
export function parseMetrics(req: MetricsRequest, lim: Limits): Parsed<PointRow> {
  const rows: PointRow[] = [];
  const services: ServiceSeen[] = [];
  let rejected = 0;
  let why = "";
  const now = lim.now * 1000;
  const oldest = now - 7 * 24 * HOUR_US;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,20}$/.test(v) ? Number(v) : NaN);
  for (const rm of asArray<{ resource?: Resource; scopeMetrics?: unknown }>(req?.resourceMetrics)) {
    const svc = serviceOf(rm?.resource);
    for (const sm of asArray<{ metrics?: unknown }>(rm?.scopeMetrics)) {
      for (const mt of asArray<OtlpMetric>(sm?.metrics)) {
        const name = typeof mt?.name === "string" && /^[A-Za-z][\w./-]{0,119}$/.test(mt.name) ? mt.name : undefined;
        const pts: { t: unknown; v: number }[] = [];
        for (const p of asArray<NumberPoint>(mt?.gauge?.dataPoints ?? mt?.sum?.dataPoints)) pts.push({ t: p?.timeUnixNano, v: p?.asDouble ?? num(p?.asInt) });
        for (const p of asArray<HistogramPoint>(mt?.histogram?.dataPoints ?? mt?.exponentialHistogram?.dataPoints ?? mt?.summary?.dataPoints)) {
          const c = num(p?.count);
          pts.push({ t: p?.timeUnixNano, v: c > 0 && typeof p?.sum === "number" ? p.sum / c : NaN });
        }
        for (const p of pts) {
          const t = micros(p.t) || now;
          if (!name || !Number.isFinite(p.v) || t < oldest || t > now + HOUR_US || rows.length >= MAX_ITEMS) {
            rejected++;
            why ||= !name ? "a metric without a plain name" : rows.length >= MAX_ITEMS ? `more than ${MAX_ITEMS} points in one request` : "a point without a value, or outside the kept window (7d)";
            continue;
          }
          addService(services, svc);
          rows.push({ service: svc.name, name, unit: clip(mt.unit ?? "", 20), hour: Math.floor(t / HOUR_US), value: p.v });
        }
      }
    }
  }
  return { rows, services, rejected, why };
}

/** Inflates a gzip/deflate body, giving up past `max` bytes; undefined when it's bigger. */
export async function inflate(body: Uint8Array, encoding: "gzip" | "deflate", max = MAX_INFLATED): Promise<Uint8Array | undefined> {
  const stream = new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream(encoding));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.byteLength));
  return out;
}

export type Signal = "traces" | "metrics" | "logs";
export type Decoded = { signal: Signal; proto: boolean; req: TracesRequest | MetricsRequest | LogsRequest };

/** The request's body, decoded; or the status and reason it's refused with. */
export async function decode(input: { path: string; body: Uint8Array; contentType: string; contentEncoding: string }): Promise<Decoded | { status: number; error: string }> {
  const signal = ({ "v1/traces": "traces", "v1/metrics": "metrics", "v1/logs": "logs" } as Record<string, Signal>)[input.path.replace(/\/+$/, "")];
  if (!signal) return { status: 404, error: "Send to v1/traces, v1/metrics or v1/logs." };
  const type = input.contentType.split(";")[0]!.trim().toLowerCase();
  const proto = type === "application/x-protobuf" || type === "application/protobuf";
  if (!proto && type !== "application/json") return { status: 415, error: "OTLP/HTTP takes application/json or application/x-protobuf." };
  const enc = input.contentEncoding.trim().toLowerCase();
  let body: Uint8Array | undefined = input.body;
  if (enc === "gzip" || enc === "deflate") {
    let out: Uint8Array | undefined | null;
    try {
      out = await inflate(input.body, enc);
    } catch {
      out = null;
    }
    if (out === null) return { status: 400, error: `Not valid ${enc}.` };
    if (!out) return { status: 413, error: "Too large once inflated." };
    body = out;
  } else if (enc && enc !== "identity") return { status: 415, error: "Content-Encoding is gzip, deflate or none." };
  try {
    if (proto) return { signal, proto, req: signal === "traces" ? decodeTraces(body) : signal === "logs" ? decodeLogs(body) : decodeMetrics(body) };
    const req = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!req || typeof req !== "object" || Array.isArray(req)) return { status: 400, error: "Not an OTLP export request." };
    return { signal, proto, req: req as TracesRequest };
  } catch {
    return { status: 400, error: proto ? "Not valid OTLP protobuf." : "Not valid JSON." };
  }
}
