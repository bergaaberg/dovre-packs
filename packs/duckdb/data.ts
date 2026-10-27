/**
 * DuckDB Pack (`duckdb`): data execution, source management, and zero-row queries.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { PackContext } from "dovre/packs/types.ts";

const execFileAsync = promisify(execFile);

export const MAX_ROWS = 500;
export const MAX_SQL = 20_000;

export type Row = Record<string, unknown>;

export type Rows = {
  rows: Row[];
  columns: string[];
  capped: boolean;
  ms: number;
};

export type TableInfo = {
  schema: string;
  table: string;
  rows?: number;
};

export type Column = {
  pos?: number;
  column: string;
  type?: string;
  nullable?: string;
  key?: string | null;
};

export type Found = {
  schema: string;
  table: string;
  column?: string;
  type?: string;
};

export type FileKind = "parquet" | "csv" | "json";

const KINDS: Record<string, FileKind> = {
  ".parquet": "parquet",
  ".csv": "csv",
  ".tsv": "csv",
  ".json": "json",
  ".jsonl": "json",
  ".ndjson": "json",
};

/** The data file kind a name's extension says, or undefined. */
export const kindOf = (name: string): FileKind | undefined => KINDS[extname(name).toLowerCase()];

export type DuckDbTarget = {
  id: string;
  label: string;
  path: string;
  isDir?: boolean;
  /** A single data file listed as a source: read in memory as one view, shut in to that file. */
  file?: FileKind;
  /** That file is remote (http(s), s3, gs): `path` is its URL, read through httpfs, shut in to that URL. */
  url?: string;
};

const REMOTE = ["http:", "https:", "s3:", "gs:", "gcs:"];

/**
 * A remote data file's URL as DuckDB will be given it, or undefined: http(s), s3 or gs, a host, no
 * user or password in it, no spaces or control characters, no glob (`*`, `[`, `{`) in its path,
 * at most 2048 characters. Keys go only to s3/gs URLs, and only when set in Settings (`remoteKeys`).
 */
export function cleanUrl(raw: string): string | undefined {
  const s = raw.trim();
  if (!s || s.length > 2048 || /[\s\x00-\x1f\x7f]/.test(s)) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (!REMOTE.includes(u.protocol) || !u.hostname || u.username || u.password) return undefined;
  if (/[*[\]{}]|%2a|%5b|%7b/i.test(u.pathname)) return undefined;
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : s;
}

/** The kind a URL's path says (its query left out), or undefined. */
export const urlKind = (url: string): FileKind | undefined => {
  try {
    return kindOf(new URL(url).pathname);
  } catch {
    return undefined;
  }
};

/** A remote file as a source of its own (one typed on the Files page): never in the configured list. */
export function remoteSource(url: string, kind: FileKind): DuckDbTarget {
  let host = "url";
  try {
    host = new URL(url).hostname || host;
  } catch {}
  return { id: "url", label: host, path: url, url, file: kind };
}

/** Keys for private buckets, from Settings. Never shown, logged, or put on a command line. */
export type RemoteKeys = {
  s3?: { keyId: string; secret: string; region?: string; endpoint?: string; ssl: boolean };
  gcs?: { keyId: string; secret: string };
};

const keyOk = (v: string | undefined) => (v && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v) ? v : undefined);

/**
 * The bucket keys set in Settings: an S3 access key (with an optional region, and an optional
 * endpoint `host[:port]` for MinIO/R2, `http://` for one without TLS) and a GCS HMAC key. A half-set
 * pair or a malformed region/endpoint is left out, so those URLs are read anonymously.
 */
export function remoteKeys(env: Record<string, string | undefined>): RemoteKeys {
  const out: RemoteKeys = {};
  const s3Id = keyOk(env.DUCKDB_S3_KEY_ID?.trim());
  const s3Secret = keyOk(env.DUCKDB_S3_SECRET?.trim());
  const region = env.DUCKDB_S3_REGION?.trim();
  const ep = env.DUCKDB_S3_ENDPOINT?.trim().match(/^(https?:\/\/)?([a-z0-9.-]{1,253}(?::\d{1,5})?)\/?$/i);
  if (s3Id && s3Secret && (!region || /^[a-z0-9-]{1,40}$/.test(region)) && (ep || !env.DUCKDB_S3_ENDPOINT?.trim())) {
    out.s3 = { keyId: s3Id, secret: s3Secret, ssl: ep?.[1]?.toLowerCase() !== "http://", ...(region ? { region } : {}), ...(ep ? { endpoint: ep[2] } : {}) };
  }
  const gcsId = keyOk(env.DUCKDB_GCS_KEY_ID?.trim());
  const gcsSecret = keyOk(env.DUCKDB_GCS_SECRET?.trim());
  if (gcsId && gcsSecret) out.gcs = { keyId: gcsId, secret: gcsSecret };
  return out;
}

/**
 * A temporary secret for this one URL's bucket, created before the lock with its output thrown away
 * (`.mode trash`), or "" for a public read: https, no keys for that scheme, or a URL without a bucket.
 * DuckDB keeps the secret redacted and the lock stops a query un-redacting it (checked against the
 * real CLI), and sqlOk refuses duckdb_secrets() so the key id isn't listed either.
 */
export function secretSql(url: string, keys: RemoteKeys | undefined): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (!u.hostname) return "";
  const scope = sqlLit(`${u.protocol}//${u.hostname}`);
  let body: string;
  if (u.protocol === "s3:" && keys?.s3) {
    const k = keys.s3;
    body = `TYPE s3, KEY_ID ${sqlLit(k.keyId)}, SECRET ${sqlLit(k.secret)}`;
    if (k.region) body += `, REGION ${sqlLit(k.region)}`;
    if (k.endpoint) body += `, ENDPOINT ${sqlLit(k.endpoint)}, URL_STYLE 'path', USE_SSL ${k.ssl}`;
  } else if ((u.protocol === "gs:" || u.protocol === "gcs:") && keys?.gcs) {
    body = `TYPE gcs, KEY_ID ${sqlLit(keys.gcs.keyId)}, SECRET ${sqlLit(keys.gcs.secret)}`;
  } else return "";
  return `.mode trash\nCREATE TEMPORARY SECRET dovre_bucket (${body}, SCOPE ${scope});\n.mode json\n`;
}

/** Every key value in a DuckDB message replaced, so an error never carries one. */
export function scrub(text: string, keys: RemoteKeys | undefined): string {
  let out = text;
  for (const v of [keys?.s3?.keyId, keys?.s3?.secret, keys?.gcs?.keyId, keys?.gcs?.secret]) {
    if (v && v.length >= 4) out = out.split(v).join("…");
  }
  return out;
}

/** The system's CA bundle, which httpfs reads for https: public certificates, allowed beside the URL. */
const CA_FILES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/ssl/cert.pem"];
let ca: string | null | undefined;
const caBundle = () => (ca === undefined ? (ca = CA_FILES.find((f) => existsSync(f)) ?? null) : ca) ?? undefined;

export type DuckDbRunner = (
  args: string[],
  opts?: { input?: string; timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string; code?: number }>;

export const defaultRunner: DuckDbRunner = async (args, opts = {}) => {
  try {
    // A bare environment: no tokens for getenv() to read, and no AI_AGENT / CLAUDECODE, which switch
    // DuckDB 2's CLI to an "agent mode" output.
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[k]) env[k] = process.env[k];
    const child = execFileAsync("duckdb", args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    if (opts.input && child.child.stdin) {
      child.child.stdin.write(opts.input);
      child.child.stdin.end();
    }
    const { stdout, stderr } = await child;
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "duckdb execution failed",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
};

/**
 * Parses DUCKDB_SOURCES: comma-separated targets:
 * name=/path/to/db.duckdb, name=/path/to/dir, :memory:, or plain paths.
 */
export function parseSources(raw: string | undefined): DuckDbTarget[] {
  if (!raw) return [];
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const targets: DuckDbTarget[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    let id: string;
    let path: string;
    if (eq > 0) {
      id = part.slice(0, eq).trim();
      path = part.slice(eq + 1).trim();
    } else {
      path = part.trim();
      if (path === ":memory:") {
        id = "memory";
      } else {
        const base = path.split("/").pop() || "source";
        id = base.replace(/\.[^.]+$/, "");
      }
    }
    const cleanId = id.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40) || "db";
    let isDir = false;
    try {
      if (path !== ":memory:" && existsSync(path) && statSync(path).isDirectory()) {
        isDir = true;
      }
    } catch {}
    // A URL to a data file is a remote file source; a .parquet/.csv/.jsonl path is never a
    // database file, so it is a file source.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      const url = cleanUrl(path);
      const kind = url && urlKind(url);
      if (url && kind) targets.push({ id: cleanId, label: cleanId, path: url, url, file: kind });
      continue;
    }
    const file = isDir || path === ":memory:" ? undefined : kindOf(path);
    targets.push({ id: cleanId, label: cleanId, path, isDir, ...(file ? { file } : {}) });
  }
  return targets;
}

/** Parses JSON output from duckdb -json. */
export function parseDuckDbJson(stdout: string): Row[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
    }
    if (parsed && typeof parsed === "object") {
      return [parsed as Row];
    }
    return [];
  } catch {
    // If multiple JSON arrays or lines were emitted
    const rows: Row[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;
      try {
        const v = JSON.parse(trimmed);
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item && typeof item === "object") rows.push(item as Row);
          }
        } else if (v && typeof v === "object") {
          rows.push(v as Row);
        }
      } catch {}
    }
    return rows;
  }
}

/** Prepares view-creation SQL for directory targets containing parquet/csv/json files. */
export function directoryViewsSql(dirPath: string): string {
  if (!dirPath || dirPath === ":memory:" || !existsSync(dirPath)) return "";
  try {
    const files = readdirSync(dirPath);
    const views: string[] = [];
    for (const file of files) {
      const lower = file.toLowerCase();
      if (!lower.endsWith(".parquet") && !lower.endsWith(".csv") && !lower.endsWith(".json") && !lower.endsWith(".jsonl")) {
        continue;
      }
      const fullPath = join(dirPath, file).replace(/'/g, "''");
      const stem = file.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
      views.push(`CREATE OR REPLACE TEMPORARY VIEW "${stem}" AS SELECT * FROM '${fullPath}';`);
    }
    return views.join("\n");
  } catch {
    return "";
  }
}

/** The table function that reads data files of a kind. */
export function readFn(kind: FileKind, arg: string): string {
  return kind === "parquet" ? `read_parquet(${arg})` : kind === "csv" ? `read_csv(${arg})` : `read_json(${arg})`;
}

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A file source's one view, named after the file. */
export const fileViewName = (path: string) => basename(path).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_") || "data";

/**
 * What every in-memory run starts with, then locked: file access only under `dir`, or only to the
 * one file `file` (DuckDB's allowed_paths; checked against the real CLI that a sibling, even through
 * read_text, is refused), or none.
 */
export function lockdownSql(dir: string | undefined, file?: string | string[]): string {
  const files = file === undefined ? [] : Array.isArray(file) ? file : [file];
  const allowed = dir
    ? `SET allowed_directories = [${sqlLit(join(dir, "/"))}];\n`
    : files.length
      ? `SET allowed_paths = [${files.map(sqlLit).join(", ")}];\n`
      : "";
  return `${allowed}SET enable_external_access = false;
SET autoinstall_known_extensions = false;
SET autoload_known_extensions = false;
SET lock_configuration = true;`;
}

export type DuckDbData = {
  sources(): DuckDbTarget[];
  source(id: string): DuckDbTarget | undefined;
  query(t: string, sql: string, maxRows?: number): Promise<Rows>;
  tables(t: string): Promise<TableInfo[]>;
  cols(t: string, table: string): Promise<Column[]>;
  peek(t: string, table: string, n?: number): Promise<Rows>;
  find(t: string, text: string): Promise<Found[]>;
  /**
   * One statement in a folder or file source, shut in as every in-memory run is, but without the
   * directory's views (the file viewer names its files itself, and one unreadable file elsewhere in
   * the directory mustn't break it).
   */
  scan(t: string, sql: string, maxRows?: number): Promise<Rows>;
};

export function createDuckDbData(o: {
  sources: DuckDbTarget[];
  run?: DuckDbRunner;
  now?: () => number;
  /** Keys for private s3/gs buckets (Settings); without them remote files are read anonymously. */
  keys?: RemoteKeys;
}): DuckDbData {
  const runner = o.run ?? defaultRunner;
  const now = o.now ?? Date.now;

  const targetMap = new Map<string, DuckDbTarget>();
  for (const s of o.sources) {
    targetMap.set(s.id, s);
  }

  const runQuery = async (target: DuckDbTarget, querySql: string, maxRows = MAX_ROWS, views = true): Promise<Rows> => {
    const t0 = now();
    const isMemoryOrDir = target.path === ":memory:" || target.isDir || !!target.file;
    // sqlOk keeps a query to one SELECT, but a SELECT can still read any file (read_text, read_csv),
    // call getenv() or autoload httpfs. So DuckDB itself is shut in (tested against the real CLI):
    // - a database file: -safe (no file access beyond it, no .shell) and -readonly;
    // - a directory or :memory: (an in-memory database can't be -readonly): files only under that
    //   directory, no environment, no extension autoloading, and the configuration locked before
    //   the query runs.
    const args = isMemoryOrDir ? ["-json", ":memory:"] : ["-safe", "-readonly", "-json", target.path];

    let inputSql = querySql.trim();
    if (target.url && target.file) {
      // Remote: httpfs loaded by name before the lock (nothing autoloads or installs), no stored
      // secrets read (so no saved S3 keys either), a temporary secret for this bucket when Settings
      // has keys, then only this URL and the CA bundle (checked against the real CLI: another URL or
      // a local file is refused, and the lock holds).
      const bundle = caBundle();
      const view = `CREATE OR REPLACE TEMPORARY VIEW "${fileViewName(new URL(target.url).pathname)}" AS SELECT * FROM ${readFn(target.file, sqlLit(target.url))};`;
      inputSql = `SET allow_persistent_secrets = false;\nLOAD httpfs;\n${secretSql(target.url, o.keys)}${lockdownSql(undefined, bundle ? [target.url, bundle] : [target.url])}\n${views ? `${view}\n` : ""}${inputSql}`;
    } else if (target.file) {
      // The real path, so a symlinked source still names the file DuckDB opens.
      let real: string;
      try {
        real = realpathSync(target.path);
      } catch {
        throw new Error(`File not found: ${target.path}`);
      }
      const view = `CREATE OR REPLACE TEMPORARY VIEW "${fileViewName(target.path)}" AS SELECT * FROM ${readFn(target.file, sqlLit(real))};`;
      inputSql = `${lockdownSql(undefined, real)}\n${views ? `${view}\n` : ""}${inputSql}`;
    } else if (isMemoryOrDir) {
      const viewSql = target.isDir && views ? directoryViewsSql(target.path) : "";
      inputSql = `${lockdownSql(target.isDir ? target.path : undefined)}\n${viewSql ? `${viewSql}\n` : ""}${inputSql}`;
    }

    const res = await runner(args, { input: inputSql, timeoutMs: 30_000 });
    if (res.code !== 0 && target.url && /httpfs/i.test(res.stderr) && /not found|install/i.test(res.stderr)) {
      throw new Error("DuckDB's httpfs extension isn't installed. Run duckdb -c 'INSTALL httpfs' once.");
    }
    if (res.code !== 0 && res.stderr) {
      const cleanError = scrub(res.stderr, o.keys)
        .replace(/^Error:\s*/i, "")
        .split(/\r?\n/)[0]
        .slice(0, 300);
      throw new Error(cleanError || `duckdb exited with code ${res.code}`);
    }

    const allRows = parseDuckDbJson(res.stdout);
    const capped = allRows.length > maxRows;
    const list = allRows.slice(0, maxRows);
    const columns = [...new Set(list.flatMap((r) => Object.keys(r)))];
    return {
      rows: list,
      columns,
      capped,
      ms: Math.max(0, now() - t0),
    };
  };

  return {
    sources: () => o.sources,
    source: (id: string) => targetMap.get(id),

    async query(t: string, sql: string, maxRows = MAX_ROWS): Promise<Rows> {
      const target = targetMap.get(t);
      if (!target) throw new Error(`Unknown DuckDB source: ${t}`);
      return runQuery(target, sql, maxRows);
    },

    async scan(t: string, sql: string, maxRows = MAX_ROWS): Promise<Rows> {
      const target = targetMap.get(t);
      if (!target) throw new Error(`Unknown DuckDB source: ${t}`);
      if (!target.isDir && !target.file) throw new Error(`Not a folder or file source: ${t}`);
      return runQuery(target, sql, maxRows, false);
    },

    async tables(t: string): Promise<TableInfo[]> {
      const target = targetMap.get(t);
      if (!target) throw new Error(`Unknown DuckDB source: ${t}`);

      const sql = `
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_schema, table_name;`.trim();

      try {
        const res = await runQuery(target, sql, 1000);
        return res.rows.map((r) => ({
          schema: String(r.table_schema ?? r.schema ?? r.s ?? "main"),
          table: String(r.table_name ?? r.table ?? r.t ?? r.name ?? ""),
        })).filter((x) => !!x.table);
      } catch {
        // Fallback to SHOW TABLES
        try {
          const res = await runQuery(target, "SHOW TABLES;", 1000);
          return res.rows.map((r) => ({
            schema: "main",
            table: String(Object.values(r)[0] ?? ""),
          })).filter((x) => !!x.table);
        } catch {
          return [];
        }
      }
    },

    async cols(t: string, table: string): Promise<Column[]> {
      const target = targetMap.get(t);
      if (!target) throw new Error(`Unknown DuckDB source: ${t}`);

      const parts = table.split(".");
      const tbl = parts.length > 1 ? parts[1] : parts[0];
      const sch = parts.length > 1 ? parts[0] : "";

      const sql = `
SELECT column_name, data_type, is_nullable, ordinal_position
FROM information_schema.columns
WHERE table_name = '${tbl.replace(/'/g, "''")}'
${sch ? `AND table_schema = '${sch.replace(/'/g, "''")}'` : ""}
ORDER BY ordinal_position;`.trim();

      try {
        const res = await runQuery(target, sql, 1000);
        if (res.rows.length) {
          return res.rows.map((r) => ({
            pos: typeof r.ordinal_position === "number" ? r.ordinal_position : undefined,
            column: String(r.column_name ?? r.column ?? ""),
            type: String(r.data_type ?? r.type ?? ""),
            nullable: r.is_nullable === "NO" ? "NOT NULL" : "null",
            key: null,
          }));
        }
      } catch {}

      // Fallback: DESCRIBE table
      const descSql = `DESCRIBE ${table.includes(".") ? table : `"${table.replace(/"/g, '""')}"`};`;
      const descRes = await runQuery(target, descSql, 1000);
      return descRes.rows.map((r, i) => ({
        pos: i + 1,
        column: String(r.column_name ?? r.Field ?? r.name ?? ""),
        type: String(r.column_type ?? r.Type ?? r.type ?? ""),
        nullable: String(r.null ?? r.Null ?? "").toLowerCase() === "no" ? "NOT NULL" : "null",
        key: r.key ? String(r.key) : null,
      })).filter((c) => !!c.column);
    },

    async peek(t: string, table: string, n = 50): Promise<Rows> {
      const target = targetMap.get(t);
      if (!target) throw new Error(`Unknown DuckDB source: ${t}`);
      const sql = `SELECT * FROM ${table.includes(".") ? table : `"${table.replace(/"/g, '""')}"`} LIMIT ${Math.min(100, Math.max(1, n))};`;
      return runQuery(target, sql, n);
    },

    async find(t: string, text: string): Promise<Found[]> {
      const target = targetMap.get(t);
      if (!target) throw new Error(`Unknown DuckDB source: ${t}`);
      const clean = text.replace(/'/g, "''").toLowerCase();
      const sql = `
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
  AND (LOWER(table_name) LIKE '%${clean}%' OR LOWER(column_name) LIKE '%${clean}%')
ORDER BY table_schema, table_name, ordinal_position;`.trim();

      try {
        const res = await runQuery(target, sql, 300);
        return res.rows.map((r) => ({
          schema: String(r.table_schema ?? "main"),
          table: String(r.table_name ?? ""),
          column: r.column_name ? String(r.column_name) : undefined,
          type: r.data_type ? String(r.data_type) : undefined,
        }));
      } catch {
        return [];
      }
    },
  };
}

export type DuckDbKept = {
  at: number;
  ok: boolean;
  error?: string;
  sources: { id: string; label: string; tablesCount: number }[];
};

export async function readDuckDb(
  ctx: PackContext,
  run?: DuckDbRunner,
  now = Date.now()
): Promise<DuckDbKept> {
  const sources = parseSources(ctx.env.DUCKDB_SOURCES);
  if (!sources.length) {
    return {
      at: now,
      ok: false,
      error: "No sources configured: set DUCKDB_SOURCES in settings.",
      sources: [],
    };
  }

  const data = createDuckDbData({ sources, run, now: () => now });
  const counts: { id: string; label: string; tablesCount: number }[] = [];

  for (const s of sources) {
    try {
      const tables = await data.tables(s.id);
      counts.push({ id: s.id, label: s.label, tablesCount: tables.length });
    } catch (e) {
      counts.push({ id: s.id, label: s.label, tablesCount: 0 });
    }
  }

  return {
    at: now,
    ok: true,
    sources: counts,
  };
}
