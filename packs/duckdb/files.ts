/**
 * The file viewer (`/duckdb/files`): open a Parquet, CSV or JSON lines file, or a folder of Parquet
 * files, under one of the directory sources in DUCKDB_SOURCES, and look inside without writing SQL.
 * It runs on the same shut-in DuckDB as every query (`DuckDbData.scan`): files only under that
 * source, no environment, no extensions. Paths are checked here first, before DuckDB sees them: a
 * relative path with no `..`, whose real path (symlinks followed) stays inside the source's.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { type DuckDbData, type DuckDbTarget, type FileKind, kindOf, type Row } from "./data.ts";

export { type FileKind, kindOf };

/** How many files a folder opened as one dataset may hold, and how many entries a folder lists. */
export const MAX_FILES = 500;
export const MAX_ENTRIES = 1000;
/** Rows a preview page may hold, and the rows computed stats read at most. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const STATS_ROWS = 100_000;
/** Columns preselected when none are picked. */
export const DEFAULT_COLS = 30;

/** A relative path with no `..`, no backslash and no NUL, or undefined. "" is the source itself. */
export function cleanRel(f: string): string | undefined {
  if (f.length > 1024 || /[\0\\]/.test(f) || f.startsWith("/")) return undefined;
  const parts = f.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return undefined;
  return parts.join("/");
}

const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** `p`'s real path is `rootReal` or inside it. */
export function inside(rootReal: string, p: string): boolean {
  const r = realOf(p);
  return !!r && (r === rootReal || r.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep));
}

export type Entry = { name: string; rel: string; isDir: boolean; kind?: FileKind; size?: number };

export type Opened =
  | { type: "dir"; rel: string; abs: string; entries: Entry[]; parquet: string[]; capped: boolean }
  | { type: "file"; rel: string; abs: string; kind: FileKind; files: string[]; size?: number; all: boolean };

/**
 * What `f` is under `root`: a folder (its entries, and its own .parquet files), or a file to view,
 * or with `all` a folder's .parquet files as one dataset. Undefined when the path isn't inside the
 * source (`..`, a symlink out, a missing file) or isn't a kind it reads.
 */
export function open(root: DuckDbTarget, f: string, all = false): Opened | undefined {
  if (root.url && root.file) {
    // A remote file: only itself; its size isn't known without asking.
    if (all || cleanRel(f) !== "") return undefined;
    return { type: "file", rel: "", abs: root.url, kind: root.file, files: [root.url], all: false };
  }
  if (root.file) {
    // A file source is the file itself: nothing under it, nothing beside it.
    if (all || cleanRel(f) !== "") return undefined;
    try {
      const st = statSync(root.path);
      if (!st.isFile()) return undefined;
      return { type: "file", rel: "", abs: root.path, kind: root.file, files: [realpathSync(root.path)], size: st.size, all: false };
    } catch {
      return undefined;
    }
  }
  if (!root.isDir) return undefined;
  const rel = cleanRel(f);
  if (rel === undefined) return undefined;
  const rootReal = realOf(root.path);
  if (!rootReal) return undefined;
  const abs = rel ? join(root.path, rel) : root.path;
  if (!inside(rootReal, abs)) return undefined;
  let st;
  try {
    st = statSync(abs);
  } catch {
    return undefined;
  }

  if (st.isDirectory()) {
    let names: string[] = [];
    try {
      names = readdirSync(abs).filter((n) => !n.startsWith(".")).sort((a, b) => a.localeCompare(b));
    } catch {}
    const entries: Entry[] = [];
    for (const name of names) {
      const p = join(abs, name);
      if (!inside(rootReal, p)) continue;
      try {
        const s = statSync(p);
        const kind = s.isFile() ? kindOf(name) : undefined;
        if (!s.isDirectory() && !kind) continue;
        entries.push({ name, rel: rel ? `${rel}/${name}` : name, isDir: s.isDirectory(), kind, size: s.isFile() ? s.size : undefined });
      } catch {}
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir));
    const parquet = entries.filter((e) => e.kind === "parquet").map((e) => join(root.path, e.rel));
    if (all) {
      if (!parquet.length) return undefined;
      const files = parquet.slice(0, MAX_FILES);
      const size = entries.filter((e) => e.kind === "parquet").slice(0, MAX_FILES).reduce((n, e) => n + (e.size ?? 0), 0);
      return { type: "file", rel, abs, kind: "parquet", files, size, all: true };
    }
    return { type: "dir", rel, abs, entries: entries.slice(0, MAX_ENTRIES), parquet, capped: entries.length > MAX_ENTRIES };
  }

  const kind = st.isFile() ? kindOf(abs) : undefined;
  if (!kind) return undefined;
  return { type: "file", rel, abs, kind, files: [abs], size: st.size, all: false };
}

/** A SQL string literal. */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** A quoted SQL identifier. */
export const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

const filesArg = (files: string[]) => (files.length === 1 ? lit(files[0]!) : `[${files.map(lit).join(", ")}]`);

/** The table function that reads these files. */
export function fromSql(kind: FileKind, files: string[]): string {
  const arg = filesArg(files);
  if (kind === "parquet") return files.length > 1 ? `read_parquet(${arg}, union_by_name = true)` : `read_parquet(${arg})`;
  if (kind === "csv") return `read_csv(${arg})`;
  return `read_json(${arg})`;
}

export const describeSql = (from: string) => `DESCRIBE SELECT * FROM ${from};`;

/** Parquet's own schema tree of the first file: the top-level fields' repetition (nullability). */
export const parquetSchemaSql = (file: string) => `SELECT name, repetition_type, num_children FROM parquet_schema(${lit(file)});`;

export const fileMetaSql = (files: string[]) =>
  `SELECT file_name, num_rows, num_row_groups, created_by, format_version FROM parquet_file_metadata(${filesArg(files)});`;

/**
 * Each leaf column's storage and statistics from the row groups' metadata, over every row group of
 * every file: nulls and min/max only where every row group has them (numbers compared as numbers),
 * the distinct count only where there's a single row group (counts don't add up).
 */
export const columnMetaSql = (files: string[]) => {
  const extreme = (fn: "min" | "max", col: string) =>
    `CASE WHEN count(${col}) = count(*) THEN CASE WHEN bool_and(TRY_CAST(${col} AS DOUBLE) IS NOT NULL) THEN arg_${fn}(${col}, TRY_CAST(${col} AS DOUBLE)) ELSE ${fn}(${col}) END END`;
  return `SELECT path_in_schema AS col, any_value(type) AS ty, string_agg(DISTINCT compression, ', ') AS codec, sum(total_compressed_size) AS packed, sum(total_uncompressed_size) AS unpacked, CASE WHEN count(stats_null_count) = count(*) THEN sum(stats_null_count) END AS nulls, ${extreme("min", "stats_min_value")} AS lo, ${extreme("max", "stats_max_value")} AS hi, CASE WHEN count(*) = 1 THEN any_value(stats_distinct_count) END AS distinct_count FROM parquet_metadata(${filesArg(files)}) GROUP BY path_in_schema ORDER BY min(column_id);`;
};

// ── Filter, sort, export ─────────────────────────────────────────────────────

export const FILTER_OPS = ["eq", "ne", "lt", "le", "gt", "ge", "contains", "null", "notnull"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const FILTER_LABELS: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  le: "≤",
  gt: ">",
  ge: "≥",
  contains: "contains",
  null: "is null",
  notnull: "is not null",
};
/** Filter or sort on one of the file's own columns; the value only ever reaches SQL as a literal. */
export type Filter = { col: string; op: FilterOp; val: string };
export type Sort = { col: string; desc: boolean };
export type Slice = { filter?: Filter; sort?: Sort };

/** Rows an export holds at most. */
export const EXPORT_ROWS = 10_000;

const CMP: Partial<Record<FilterOp, string>> = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" };

/** ` WHERE …` for a filter, or "". A compared value is a string literal DuckDB casts to the column's type. */
export function whereSql(f: Filter | undefined): string {
  if (!f) return "";
  const c = ident(f.col);
  if (f.op === "null") return ` WHERE ${c} IS NULL`;
  if (f.op === "notnull") return ` WHERE ${c} IS NOT NULL`;
  if (f.op === "contains") return ` WHERE contains(lower(CAST(${c} AS VARCHAR)), lower(${lit(f.val)}))`;
  return ` WHERE ${c} ${CMP[f.op]} ${lit(f.val)}`;
}

export const orderSql = (o: Sort | undefined) => (o ? ` ORDER BY ${ident(o.col)} ${o.desc ? "DESC" : "ASC"} NULLS LAST` : "");

/** Keeps only a filter and sort on known columns (and a value where the operator needs one). */
export function sliceOf(known: Set<string>, s: Slice): Slice {
  const f = s.filter;
  const filter = f && known.has(f.col) && FILTER_OPS.includes(f.op) && (f.op === "null" || f.op === "notnull" || f.val !== "") ? f : undefined;
  const sort = s.sort && known.has(s.sort.col) ? s.sort : undefined;
  return { filter, sort };
}

export const previewSql = (from: string, cols: string[], limit: number, offset: number, s: Slice = {}) =>
  `SELECT ${cols.map(ident).join(", ")} FROM ${from}${whereSql(s.filter)}${orderSql(s.sort)} LIMIT ${limit} OFFSET ${offset};`;

export const matchingSql = (from: string, f: Filter) => `SELECT count(*) AS n FROM ${from}${whereSql(f)};`;

/** A value as text for a CSV cell: nested values as JSON, a text starting like a formula defused. */
function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(cols: string[], rows: Row[]): string {
  const lines = [cols.map(csvCell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(csvValue(r[c]))).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** A download's name: the file's own name, cut to safe characters. */
export function exportName(rel: string, all: boolean, as: "csv" | "json"): string {
  const base = (all ? `${rel.split("/").pop() || "dataset"}-all` : (rel.split("/").pop() ?? "data").replace(/\.[^.]+$/, "")).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return `${base || "data"}-slice.${as}`;
}

/** The picked columns, filtered and sorted, as many rows as an export holds. */
export async function slice(
  data: DuckDbData,
  t: string,
  o: Extract<Opened, { type: "file" }>,
  q: { cols?: string[] } & Slice,
): Promise<{ columns: string[]; rows: Row[]; capped: boolean }> {
  const from = fromSql(o.kind, o.files);
  const described = await data.scan(t, describeSql(from), 100_000);
  const all = columnsOf(described.rows, []).map((c) => c.name);
  const known = new Set(all);
  const wanted = (q.cols ?? []).filter((c) => known.has(c));
  const cols = wanted.length ? [...new Set(wanted)] : all.slice(0, DEFAULT_COLS);
  if (!cols.length) return { columns: [], rows: [], capped: false };
  const r = await data.scan(t, previewSql(from, cols, EXPORT_ROWS + 1, 0, sliceOf(known, q)), EXPORT_ROWS + 1);
  return { columns: cols, rows: r.rows.slice(0, EXPORT_ROWS), capped: r.rows.length > EXPORT_ROWS };
}

export const summarizeSql = (from: string, cols: string[], cap = STATS_ROWS) =>
  `SUMMARIZE SELECT ${cols.map(ident).join(", ")} FROM ${from} LIMIT ${cap};`;

/** The query handed to DuckDB's own query page: the same files, every column. */
export function handoffSql(o: { kind: FileKind; files: string[]; abs: string; all: boolean }, max: number): string {
  const sql = `SELECT *\nFROM ${fromSql(o.kind, o.files)}\nLIMIT 100;`;
  if (sql.length <= max) return sql;
  return `SELECT *\nFROM read_parquet(${lit(join(o.abs, "*.parquet"))}, union_by_name = true)\nLIMIT 100;`;
}

export type FileColumn = { name: string; type: string; nullable?: "yes" | "no" | "list" };
export type LeafMeta = {
  col: string;
  ty?: string;
  codec?: string;
  packed?: number;
  unpacked?: number;
  nulls?: number;
  lo?: string;
  hi?: string;
  distinct?: number;
};
export type FileFacts = { rows?: number; rowGroups?: number; createdBy?: string; format?: string; files: number };
export type Summary = { col: string; type?: string; lo?: string; hi?: string; distinct?: number; nullPct?: string; count?: number };

const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function columnsOf(described: Row[], schema: Row[]): FileColumn[] {
  // parquet_schema is the tree depth first: a root, then each field followed by its children.
  const rep = new Map<string, string>();
  const rows = schema.slice(1);
  let i = 0;
  const skip = () => {
    const r = rows[i++];
    for (let k = num(r?.num_children) ?? 0; k > 0 && i < rows.length; k--) skip();
    return r;
  };
  while (i < rows.length) {
    const r = skip();
    if (r && typeof r.name === "string") rep.set(r.name, String(r.repetition_type ?? ""));
  }
  return described
    .map((r) => {
      const name = String(r.column_name ?? "");
      const rt = rep.get(name);
      const nullable = rt === "REQUIRED" ? "no" : rt === "OPTIONAL" ? "yes" : rt === "REPEATED" ? "list" : undefined;
      return { name, type: String(r.column_type ?? ""), nullable } as FileColumn;
    })
    .filter((c) => c.name);
}

export const leavesOf = (rows: Row[]): LeafMeta[] =>
  rows.map((r) => ({
    col: String(r.col ?? ""),
    ty: str(r.ty),
    codec: str(r.codec),
    packed: num(r.packed),
    unpacked: num(r.unpacked),
    nulls: num(r.nulls),
    lo: str(r.lo),
    hi: str(r.hi),
    distinct: num(r.distinct_count),
  }));

export function factsOf(rows: Row[], files: number): FileFacts {
  const sum = (k: string) => (rows.length && rows.every((r) => num(r[k]) !== undefined) ? rows.reduce((n, r) => n + num(r[k])!, 0) : undefined);
  return {
    rows: sum("num_rows"),
    rowGroups: sum("num_row_groups"),
    createdBy: str(rows[0]?.created_by),
    format: str(rows[0]?.format_version),
    files,
  };
}

export const summariesOf = (rows: Row[]): Summary[] =>
  rows.map((r) => ({
    col: String(r.column_name ?? ""),
    type: str(r.column_type),
    lo: str(r.min),
    hi: str(r.max),
    distinct: num(r.approx_unique),
    nullPct: str(r.null_percentage),
    count: num(r.count),
  }));

export type Look = {
  columns: FileColumn[];
  facts?: FileFacts;
  leaves?: LeafMeta[];
  picked: string[];
  page: { rows: Row[]; columns: string[]; more: boolean; ms: number };
  stats?: Summary[];
  /** The filter and sort applied (only on the file's own columns), and how many rows match the filter. */
  slice: Slice;
  matching?: number;
  /** What went wrong reading it (the schema or preview); metadata failing just leaves its panel out. */
  error?: string;
  statsError?: string;
};

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * Reads what the viewer shows: the schema first (which says the columns to pick from), then the
 * metadata, a page of rows and, when asked, stats computed over the first STATS_ROWS rows.
 */
export async function look(
  data: DuckDbData,
  t: string,
  o: Extract<Opened, { type: "file" }>,
  q: { cols?: string[]; size: number; page: number; stats?: boolean } & Slice,
): Promise<Look> {
  const from = fromSql(o.kind, o.files);
  const empty = { rows: [], columns: [], more: false, ms: 0 };
  let columns: FileColumn[];
  try {
    const [described, schema] = await Promise.all([
      data.scan(t, describeSql(from), 100_000),
      o.kind === "parquet" ? data.scan(t, parquetSchemaSql(o.files[0]!), 200_000).catch(() => undefined) : undefined,
    ]);
    columns = columnsOf(described.rows, schema?.rows ?? []);
  } catch (e) {
    return { columns: [], picked: [], page: empty, slice: {}, error: message(e) };
  }

  const known = new Set(columns.map((c) => c.name));
  const wanted = (q.cols ?? []).filter((c) => known.has(c));
  const picked = wanted.length ? [...new Set(wanted)] : columns.slice(0, DEFAULT_COLS).map((c) => c.name);
  const sl = sliceOf(known, q);

  const [facts, leaves, page, stats, matching] = await Promise.all([
    o.kind === "parquet" ? data.scan(t, fileMetaSql(o.files), MAX_FILES).then((r) => factsOf(r.rows, o.files.length)).catch(() => undefined) : undefined,
    o.kind === "parquet" ? data.scan(t, columnMetaSql(o.files), 100_000).then((r) => leavesOf(r.rows)).catch(() => undefined) : undefined,
    picked.length
      ? data
          .scan(t, previewSql(from, picked, q.size + 1, q.page * q.size, sl), q.size + 1)
          .then((r) => ({ rows: r.rows.slice(0, q.size), columns: picked, more: r.rows.length > q.size, ms: r.ms }))
          .catch((e) => ({ ...empty, error: message(e) }))
      : { ...empty },
    q.stats && picked.length
      ? data.scan(t, summarizeSql(from, picked), picked.length).then((r) => ({ list: summariesOf(r.rows) })).catch((e) => ({ error: message(e) }))
      : undefined,
    sl.filter ? data.scan(t, matchingSql(from, sl.filter), 1).then((r) => num(r.rows[0]?.n)).catch(() => undefined) : undefined,
  ]);

  return {
    columns,
    facts,
    leaves,
    picked,
    page: { rows: page.rows, columns: page.columns, more: page.more, ms: page.ms },
    error: "error" in page ? page.error : undefined,
    stats: stats && "list" in stats ? stats.list : undefined,
    slice: sl,
    matching,
    statsError: stats && "error" in stats ? stats.error : undefined,
  };
}
