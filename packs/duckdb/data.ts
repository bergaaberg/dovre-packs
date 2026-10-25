/**
 * DuckDB Pack (`duckdb`): data execution, source management, and zero-row queries.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

export type DuckDbTarget = {
  id: string;
  label: string;
  path: string;
  isDir?: boolean;
};

export type DuckDbRunner = (
  args: string[],
  opts?: { input?: string; timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string; code?: number }>;

export const defaultRunner: DuckDbRunner = async (args, opts = {}) => {
  try {
    const child = execFileAsync("duckdb", args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
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
    targets.push({ id: cleanId, label: cleanId, path, isDir });
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

export type DuckDbData = {
  sources(): DuckDbTarget[];
  source(id: string): DuckDbTarget | undefined;
  query(t: string, sql: string, maxRows?: number): Promise<Rows>;
  tables(t: string): Promise<TableInfo[]>;
  cols(t: string, table: string): Promise<Column[]>;
  peek(t: string, table: string, n?: number): Promise<Rows>;
  find(t: string, text: string): Promise<Found[]>;
};

export function createDuckDbData(o: {
  sources: DuckDbTarget[];
  run?: DuckDbRunner;
  now?: () => number;
}): DuckDbData {
  const runner = o.run ?? defaultRunner;
  const now = o.now ?? Date.now;

  const targetMap = new Map<string, DuckDbTarget>();
  for (const s of o.sources) {
    targetMap.set(s.id, s);
  }

  const runQuery = async (target: DuckDbTarget, querySql: string, maxRows = MAX_ROWS): Promise<Rows> => {
    const t0 = now();
    const isMemoryOrDir = target.path === ":memory:" || target.isDir;
    const dbArg = isMemoryOrDir ? ":memory:" : target.path;
    const args = ["-readonly", "-json", dbArg];

    let inputSql = querySql.trim();
    if (target.isDir) {
      const views = directoryViewsSql(target.path);
      if (views) {
        inputSql = `${views}\n${inputSql}`;
      }
    }

    const res = await runner(args, { input: inputSql, timeoutMs: 30_000 });
    if (res.code !== 0 && res.stderr) {
      const cleanError = res.stderr
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
