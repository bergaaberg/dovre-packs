/**
 * DuckDB zero-row schema exploration, 24h disk/memory caching, and keyword/stem scoring.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDbData, DuckDbTarget, Row } from "./data.ts";

export type SchemaTable = {
  name: string;
  cols: [string, string][];
};

export type Schema = {
  from: string;
  at: number;
  tables: SchemaTable[];
};

export const DAY = 24 * 3600_000;
const MAX_COLUMNS = 60_000;

export const ALL_CHARS = 50_000;
export const NAMES_CHARS = 20_000;
export const COLS_CHARS = 30_000;

/** Zero-row schema discovery query on information_schema.columns. */
export const DUCKDB_SCHEMA_SQL = `
SELECT table_schema AS s, table_name AS t, column_name AS c, data_type AS ty
FROM information_schema.columns
WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_schema, table_name, ordinal_position;`.trim();

/**
 * Transforms column metadata rows into Schema representation.
 * Zero rows of user data are ever parsed or contained here.
 */
export function schemaOf(rows: Row[], from: string, at: number): Schema {
  const by = new Map<string, [string, string][]>();
  for (const r of rows.slice(0, MAX_COLUMNS)) {
    const s = typeof r.s === "string" ? r.s : typeof r.table_schema === "string" ? r.table_schema : "main";
    const t = typeof r.t === "string" ? r.t : typeof r.table_name === "string" ? r.table_name : "";
    const c = typeof r.c === "string" ? r.c : typeof r.column_name === "string" ? r.column_name : "";
    const ty = typeof r.ty === "string" ? r.ty : typeof r.data_type === "string" ? r.data_type : "";
    if (!t || !c) continue;
    const name = s === "main" ? t : `${s}.${t}`;
    const list = by.get(name) ?? [];
    list.push([c.slice(0, 128), ty.slice(0, 64)]);
    by.set(name, list);
  }
  return {
    from,
    at,
    tables: [...by].map(([name, cols]) => ({ name: name.slice(0, 260), cols })),
  };
}

export type DuckDbSchemas = {
  get(targetId: string): Promise<Schema>;
};

export function createDuckDbSchemas(o: {
  data: DuckDbData;
  dir?: string;
  now?: () => number;
}): DuckDbSchemas {
  const now = o.now ?? Date.now;
  const kept = new Map<string, Schema>();
  const loading = new Map<string, Promise<Schema>>();

  const cacheFile = (from: string) =>
    o.dir ? join(o.dir, `duckdb-${from.replace(/[^\w.-]/g, "_")}.json`) : undefined;

  const fromDisk = (from: string): Schema | undefined => {
    const f = cacheFile(from);
    if (!f) return undefined;
    try {
      const s = JSON.parse(readFileSync(f, "utf8")) as Schema;
      return s && s.from === from && Array.isArray(s.tables) && typeof s.at === "number" ? s : undefined;
    } catch {
      return undefined;
    }
  };

  const toDisk = (s: Schema) => {
    const f = cacheFile(s.from);
    if (!f || !o.dir) return;
    try {
      mkdirSync(o.dir, { recursive: true });
      writeFileSync(`${f}.tmp`, JSON.stringify(s));
      renameSync(`${f}.tmp`, f);
    } catch {}
  };

  return {
    async get(targetId: string): Promise<Schema> {
      const target = o.data.source(targetId);
      if (!target) throw new Error(`Unknown DuckDB source: ${targetId}`);

      const have = kept.get(targetId) ?? fromDisk(targetId);
      if (have && now() - have.at < DAY) {
        kept.set(targetId, have);
        return have;
      }

      const busy = loading.get(targetId);
      if (busy) return busy;

      const job = (async () => {
        try {
          // Zero-row schema discovery via information_schema
          const res = await o.data.query(targetId, DUCKDB_SCHEMA_SQL, MAX_COLUMNS);
          let s: Schema;
          if (res.rows.length) {
            s = schemaOf(res.rows, targetId, now());
          } else {
            // Fallback for directory or views without information_schema entries
            const tables = await o.data.tables(targetId);
            const schemaTables: SchemaTable[] = [];
            for (const tbl of tables) {
              const full = tbl.schema === "main" ? tbl.table : `${tbl.schema}.${tbl.table}`;
              const cols = await o.data.cols(targetId, full);
              schemaTables.push({
                name: full,
                cols: cols.map((c) => [c.column, c.type ?? ""]),
              });
            }
            s = { from: targetId, at: now(), tables: schemaTables };
          }

          kept.set(targetId, s);
          toDisk(s);
          return s;
        } catch (err) {
          if (have) return have;
          throw err;
        } finally {
          loading.delete(targetId);
        }
      })();

      loading.set(targetId, job);
      return job;
    },
  };
}

/** Folded for matching: lower case, Norwegian letters spelled out, accents off. */
export const fold = (s: string) =>
  s.toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").normalize("NFD").replace(/\p{M}/gu, "");

export const STOP = new Set(
  "hva hvor hvem hvilke hvilken hvordan mange som med for fra til og eller der det den de er har alle per pa av om en et ett the how many what which who and or with from for per all are is was in on of to a an by show list find give me vis finn select query count".split(" ")
);

export const words = (s: string) =>
  [...new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];

/** Near-equality check for stems/plurals (e.g. kunder/kunde, users/user). */
export const near = (a: string, b: string) =>
  a === b ||
  (a.length >= 4 &&
    b.length >= 4 &&
    (a.startsWith(b.slice(0, Math.max(4, b.length - 2))) ||
      b.startsWith(a.slice(0, Math.max(4, a.length - 2)))));

const tableLine = (t: SchemaTable) =>
  `${t.name}(${t.cols.map(([c, ty]) => (ty ? `${c} ${ty}` : c)).join(", ")})`;

/**
 * Produces schema prompt text scored by user question so large schemas stay
 * within prompt token budgets. Zero rows are ever shown.
 */
export function schemaPart(question: string, s: Schema): string {
  const all = s.tables.map(tableLine).join("\n");
  if (all.length <= ALL_CHARS) return all;

  const want = words(question);
  const scored = s.tables
    .map((t, i) => {
      const nameWords = fold(t.name).split(/[^a-z0-9]+/).filter(Boolean);
      let score = 0;
      for (const w of want) {
        if (nameWords.some((n) => near(n, w) || n.includes(w))) score += 5;
        score += Math.min(
          3,
          t.cols.filter(([c]) => fold(c).split(/[^a-z0-9]+/).some((n) => near(n, w))).length
        );
      }
      return { t, score, i };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const cols: string[] = [];
  let used = 0;
  for (const { t } of scored) {
    const l = tableLine(t);
    if (used + l.length > COLS_CHARS) continue;
    cols.push(l);
    used += l.length;
  }

  let names = s.tables.map((t) => t.name).join(", ");
  if (names.length > NAMES_CHARS) names = `${names.slice(0, NAMES_CHARS)}, …`;

  return `All tables: ${names}\n\nColumns of the tables that seem to fit the question:\n${cols.join("\n") || "(none matched: ask which table, or use the names above)"}`;
}

/** Formats schema for client autocomplete endpoint /duckdb/schema?t=... */
export function toAutocomplete(s: Schema): { from: string; at: number; tables: [string, [string, string][]][] } {
  return {
    from: s.from,
    at: s.at,
    tables: s.tables.map((t) => [t.name, t.cols]),
  };
}
