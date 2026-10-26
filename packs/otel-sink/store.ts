/**
 * The sink's own tables in Dovre's database (SQLite locally, D1 hosted), made idempotently on
 * first use (`CREATE … IF NOT EXISTS`, all prefixed `otel_sink_`), so the pack needs no core
 * migration. Short retention and hard row caps keep Dovre a cockpit, not a backend: spans and
 * logs 24 h, metric rollups 7 days, pruned on refresh and whenever enough has come in since.
 */
import type { D1, D1Statement } from "dovre/db.ts";
import type { LogRow, PointRow, ServiceSeen, SpanRow } from "./otlp.ts";

export const SPAN_RETENTION_MS = 24 * 3600_000;
export const LOG_RETENTION_MS = 24 * 3600_000;
export const METRIC_RETENTION_MS = 7 * 24 * 3600_000;
export const MAX_SPANS = 30_000;
export const MAX_LOGS = 20_000;
export const MAX_METRIC_ROWS = 20_000;
export const MAX_SERVICES = 200;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS otel_sink_spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT NOT NULL, service TEXT NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL, start_us INTEGER NOT NULL, dur_us INTEGER NOT NULL, status INTEGER NOT NULL, http_method TEXT, http_route TEXT, http_status INTEGER, err INTEGER NOT NULL, entry INTEGER NOT NULL, err_type TEXT, err_msg TEXT, attrs TEXT, source TEXT NOT NULL, PRIMARY KEY (trace_id, span_id))`,
  `CREATE INDEX IF NOT EXISTS otel_sink_spans_start ON otel_sink_spans (start_us)`,
  `CREATE INDEX IF NOT EXISTS otel_sink_spans_entry ON otel_sink_spans (entry, start_us)`,
  `CREATE INDEX IF NOT EXISTS otel_sink_spans_err ON otel_sink_spans (err, start_us)`,
  `CREATE TABLE IF NOT EXISTS otel_sink_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at_us INTEGER NOT NULL, service TEXT NOT NULL, severity INTEGER NOT NULL, body TEXT NOT NULL, trace_id TEXT, span_id TEXT, err_type TEXT, err_msg TEXT, attrs TEXT, source TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS otel_sink_logs_at ON otel_sink_logs (at_us)`,
  `CREATE INDEX IF NOT EXISTS otel_sink_logs_trace ON otel_sink_logs (trace_id)`,
  `CREATE TABLE IF NOT EXISTS otel_sink_metrics (service TEXT NOT NULL, name TEXT NOT NULL, hour INTEGER NOT NULL, unit TEXT NOT NULL, n INTEGER NOT NULL, total REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL, last REAL NOT NULL, PRIMARY KEY (service, name, hour))`,
  `CREATE TABLE IF NOT EXISTS otel_sink_services (name TEXT PRIMARY KEY, version TEXT, environment TEXT, source TEXT NOT NULL, first_us INTEGER NOT NULL, last_us INTEGER NOT NULL)`,
];

const made = new WeakSet<object>();

/** Makes the tables once per database handle. */
export async function ensureSchema(db: D1): Promise<void> {
  if (made.has(db)) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  made.add(db);
}

async function inChunks(db: D1, stmts: D1Statement[], size = 100): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

/** Records the services a request named: version and environment as last seen. */
function serviceStatements(db: D1, services: ServiceSeen[], source: string, nowUs: number): D1Statement[] {
  return services.map((s) =>
    db
      .prepare(
        `INSERT INTO otel_sink_services (name, version, environment, source, first_us, last_us) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET version = COALESCE(excluded.version, version), environment = COALESCE(excluded.environment, environment), source = excluded.source, last_us = excluded.last_us`,
      )
      .bind(s.name, s.version, s.environment, source, nowUs, nowUs),
  );
}

/** D1 binds at most 100 values a statement: rows go in as many to a statement as fit. */
const MAX_PARAMS = 100;

function multiRow(db: D1, head: string, cols: number, rows: (string | number | null)[][], tail = ""): D1Statement[] {
  const per = Math.max(1, Math.floor(MAX_PARAMS / cols));
  const one = `(${Array(cols).fill("?").join(", ")})`;
  const out: D1Statement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push(db.prepare(`${head} VALUES ${chunk.map(() => one).join(", ")}${tail}`).bind(...chunk.flat()));
  }
  return out;
}

export async function insertSpans(db: D1, rows: SpanRow[], services: ServiceSeen[], source: string, now: number): Promise<number> {
  const stmts = multiRow(
    db,
    "INSERT OR IGNORE INTO otel_sink_spans (trace_id, span_id, parent_id, service, name, kind, start_us, dur_us, status, http_method, http_route, http_status, err, entry, err_type, err_msg, attrs, source)",
    18,
    rows.map((r) => [r.trace_id, r.span_id, r.parent_id, r.service, r.name, r.kind, r.start_us, r.dur_us, r.status, r.http_method, r.http_route, r.http_status, r.err, r.entry, r.err_type, r.err_msg, r.attrs, source]),
  );
  await inChunks(db, [...serviceStatements(db, services, source, now * 1000), ...stmts]);
  return rows.length;
}

export async function insertLogs(db: D1, rows: LogRow[], services: ServiceSeen[], source: string, now: number): Promise<number> {
  const stmts = multiRow(
    db,
    "INSERT INTO otel_sink_logs (at_us, service, severity, body, trace_id, span_id, err_type, err_msg, attrs, source)",
    10,
    rows.map((r) => [r.at_us, r.service, r.severity, r.body, r.trace_id, r.span_id, r.err_type, r.err_msg, r.attrs, source]),
  );
  await inChunks(db, [...serviceStatements(db, services, source, now * 1000), ...stmts]);
  return rows.length;
}

/** Points rolled up per service, metric and hour (count, sum, min, max, last), added to what's there. */
export async function insertPoints(db: D1, rows: PointRow[], services: ServiceSeen[], source: string, now: number): Promise<number> {
  const roll = new Map<string, { r: PointRow; n: number; total: number; min: number; max: number; last: number }>();
  for (const r of rows) {
    const k = JSON.stringify([r.service, r.name, r.hour]);
    const had = roll.get(k);
    if (!had) roll.set(k, { r, n: 1, total: r.value, min: r.value, max: r.value, last: r.value });
    else (had.n++, (had.total += r.value), (had.min = Math.min(had.min, r.value)), (had.max = Math.max(had.max, r.value)), (had.last = r.value));
  }
  const stmts = multiRow(
    db,
    "INSERT INTO otel_sink_metrics (service, name, hour, unit, n, total, min, max, last)",
    9,
    [...roll.values()].map((x) => [x.r.service, x.r.name, x.r.hour, x.r.unit, x.n, x.total, x.min, x.max, x.last]),
    " ON CONFLICT (service, name, hour) DO UPDATE SET unit = excluded.unit, n = n + excluded.n, total = total + excluded.total, min = MIN(min, excluded.min), max = MAX(max, excluded.max), last = excluded.last",
  );
  await inChunks(db, [...serviceStatements(db, services, source, now * 1000), ...stmts]);
  return roll.size;
}

/** Drops what's past retention, then the oldest past each cap. */
export async function prune(db: D1, now: number): Promise<void> {
  const us = now * 1000;
  await db.batch([
    db.prepare("DELETE FROM otel_sink_spans WHERE start_us < ?").bind(us - SPAN_RETENTION_MS * 1000),
    db.prepare("DELETE FROM otel_sink_spans WHERE rowid IN (SELECT rowid FROM otel_sink_spans ORDER BY start_us DESC LIMIT -1 OFFSET ?)").bind(MAX_SPANS),
    db.prepare("DELETE FROM otel_sink_logs WHERE at_us < ?").bind(us - LOG_RETENTION_MS * 1000),
    db.prepare("DELETE FROM otel_sink_logs WHERE id IN (SELECT id FROM otel_sink_logs ORDER BY at_us DESC LIMIT -1 OFFSET ?)").bind(MAX_LOGS),
    db.prepare("DELETE FROM otel_sink_metrics WHERE hour < ?").bind(Math.floor((us - METRIC_RETENTION_MS * 1000) / 3600e6)),
    db.prepare("DELETE FROM otel_sink_metrics WHERE rowid IN (SELECT rowid FROM otel_sink_metrics ORDER BY hour DESC LIMIT -1 OFFSET ?)").bind(MAX_METRIC_ROWS),
    db.prepare("DELETE FROM otel_sink_services WHERE last_us < ?").bind(us - METRIC_RETENTION_MS * 1000),
    db.prepare("DELETE FROM otel_sink_services WHERE name IN (SELECT name FROM otel_sink_services ORDER BY last_us DESC LIMIT -1 OFFSET ?)").bind(MAX_SERVICES),
  ]);
}

// --- reading ---

/** When a service counts as erroring: share of its requests that failed in the last 15 minutes, and how many. */
export const WINDOW_MS = 15 * 60_000;
export const WARN_ERR = 1;
export const BAD_ERR = 5;

export type ServiceSum = {
  name: string;
  version: string | null;
  environment: string | null;
  source: string;
  lastAt: number;
  repo?: string;
  /** Requests (entry spans) and failed ones in the window. */
  n: number;
  errors: number;
  rpm: number;
  errPct: number;
  p50: number;
  p95: number;
  status: "ok" | "warn" | "bad" | "quiet";
  /** Per hour over the last 24 h, oldest first. */
  hourly: { at: number; n: number; e: number }[];
  metrics: { name: string; unit: string; last: number; avg: number; at: number }[];
};
export type ErrorSpan = { trace_id: string; span_id: string; service: string; name: string; err_type: string | null; err_msg: string | null; http_status: number | null; start_us: number };
export type SinkKept = { ok: true; at: number; services: ServiceSum[]; errors: ErrorSpan[]; counts: { spans: number; logs: number; metrics: number } } | { ok: false; error: string };

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export function statusOf(n: number, errors: number): ServiceSum["status"] {
  if (!n && !errors) return "quiet";
  const pct = n ? (100 * errors) / n : 100;
  if (errors >= 3 && pct >= BAD_ERR) return "bad";
  if (errors >= 2 && pct >= WARN_ERR) return "warn";
  return "ok";
}

/** Everything the pages, Today and the needs show, read in one go (refresh). */
export async function readSummary(db: D1, now: number, repos: Map<string, string>): Promise<SinkKept> {
  const us = now * 1000;
  const from = us - WINDOW_MS * 1000;
  const dayFrom = us - 24 * 3600e6;
  const [svcs, recent, hourly, errors, metrics, counts] = await db.batch([
    db.prepare("SELECT name, version, environment, source, last_us FROM otel_sink_services ORDER BY name LIMIT ?").bind(MAX_SERVICES),
    db.prepare("SELECT service, dur_us, err FROM otel_sink_spans WHERE entry = 1 AND start_us >= ? ORDER BY start_us DESC LIMIT 20000").bind(from),
    db.prepare("SELECT service, CAST(start_us / 3600000000 AS INTEGER) AS h, COUNT(*) AS n, SUM(err) AS e FROM otel_sink_spans WHERE entry = 1 AND start_us >= ? GROUP BY service, h").bind(dayFrom),
    db.prepare("SELECT trace_id, span_id, service, name, err_type, err_msg, http_status, start_us FROM otel_sink_spans WHERE err = 1 ORDER BY start_us DESC LIMIT 50"),
    db.prepare("SELECT service, name, unit, hour, n, total, last FROM otel_sink_metrics WHERE hour >= ? ORDER BY hour").bind(Math.floor(us / 3600e6) - 2),
    db.prepare("SELECT (SELECT COUNT(*) FROM otel_sink_spans) AS spans, (SELECT COUNT(*) FROM otel_sink_logs) AS logs, (SELECT COUNT(*) FROM otel_sink_metrics) AS metrics"),
  ]);
  type Svc = { name: string; version: string | null; environment: string | null; source: string; last_us: number };
  const durs = new Map<string, { d: number[]; e: number }>();
  for (const r of recent!.results as { service: string; dur_us: number; err: number }[]) {
    const x = durs.get(r.service) ?? { d: [], e: 0 };
    x.d.push(r.dur_us);
    x.e += r.err;
    durs.set(r.service, x);
  }
  const nowH = Math.floor(us / 3600e6);
  const hours = new Map<string, Map<number, { n: number; e: number }>>();
  for (const r of hourly!.results as { service: string; h: number; n: number; e: number }[]) {
    const m = hours.get(r.service) ?? new Map();
    m.set(r.h, { n: r.n, e: r.e ?? 0 });
    hours.set(r.service, m);
  }
  const latest = new Map<string, Map<string, ServiceSum["metrics"][number]>>();
  for (const r of metrics!.results as { service: string; name: string; unit: string; hour: number; n: number; total: number; last: number }[]) {
    const m = latest.get(r.service) ?? new Map();
    m.set(r.name, { name: r.name, unit: r.unit, last: r.last, avg: r.n ? r.total / r.n : 0, at: r.hour * 3600e3 });
    latest.set(r.service, m);
  }
  const services: ServiceSum[] = (svcs!.results as Svc[]).map((s) => {
    const x = durs.get(s.name) ?? { d: [], e: 0 };
    const sorted = [...x.d].sort((a, b) => a - b);
    const hm = hours.get(s.name);
    const repo = repos.get(s.name);
    return {
      name: s.name,
      version: s.version,
      environment: s.environment,
      source: s.source,
      lastAt: Math.floor(s.last_us / 1000),
      ...(repo ? { repo } : {}),
      n: sorted.length,
      errors: x.e,
      rpm: Math.round((sorted.length / (WINDOW_MS / 60_000)) * 10) / 10,
      errPct: sorted.length ? Math.round((1000 * x.e) / sorted.length) / 10 : 0,
      p50: Math.round(quantile(sorted, 0.5) / 100) / 10,
      p95: Math.round(quantile(sorted, 0.95) / 100) / 10,
      status: statusOf(sorted.length, x.e),
      hourly: Array.from({ length: 24 }, (_, i) => {
        const h = nowH - 23 + i;
        const v = hm?.get(h);
        return { at: h * 3600e3, n: v?.n ?? 0, e: v?.e ?? 0 };
      }),
      metrics: [...(latest.get(s.name)?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40),
    };
  });
  const c = (counts!.results[0] ?? {}) as { spans?: number; logs?: number; metrics?: number };
  return { ok: true, at: now, services, errors: errors!.results as ErrorSpan[], counts: { spans: c.spans ?? 0, logs: c.logs ?? 0, metrics: c.metrics ?? 0 } };
}

export type TraceSpan = SpanRow & { source: string };

export async function readTrace(db: D1, traceId: string): Promise<TraceSpan[]> {
  const { results } = await db.prepare("SELECT * FROM otel_sink_spans WHERE trace_id = ? ORDER BY start_us LIMIT 1000").bind(traceId).all<TraceSpan>();
  return results;
}

export type LogEntry = LogRow & { id: number; source: string };
export type LogFilter = { service?: string; minSeverity?: number; trace?: string };

export async function readLogs(db: D1, f: LogFilter, limit = 200): Promise<LogEntry[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.service) (where.push("service = ?"), args.push(f.service));
  if (f.minSeverity) (where.push("severity >= ?"), args.push(f.minSeverity));
  if (f.trace) (where.push("trace_id = ?"), args.push(f.trace));
  const sql = `SELECT * FROM otel_sink_logs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at_us DESC, id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, limit).all<LogEntry>();
  return results;
}
