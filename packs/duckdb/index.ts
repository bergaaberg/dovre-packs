/**
 * DuckDB Pack (`duckdb`): zero-row schema exploration, AI query builder,
 * manual/agentic execution, opt-in AI result review, and multi-source routing.
 */
import { html } from "hono/html";
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import {
  createDuckDbData,
  type DuckDbData,
  type DuckDbKept,
  type DuckDbRunner,
  MAX_ROWS,
  parseSources,
  readDuckDb,
} from "./data.ts";
import { exportName, look, open, PAGE_SIZES, slice, toCsv } from "./files.ts";
import { FILES_STYLES, filePage, filesHome, folderPage, notOpenPage, sliceParams } from "./filesview.ts";
import { createDuckDbSchemas, type DuckDbSchemas, toAutocomplete } from "./schema.ts";
import {
  type Asker,
  createDuckDbAgent,
  type DuckDbAgent,
  sqlOk,
} from "./agent.ts";
import {
  acrossHref,
  askHref,
  dbHref,
  duckdbAcrossPage,
  duckdbAskPage,
  duckdbCard,
  duckdbHome,
  duckdbResultPage,
  duckdbSourcePage,
  duckdbTablePage,
  tableHref,
} from "./view.ts";

export type CreateDuckDbPackOpts = {
  run?: DuckDbRunner;
  asker?: Asker;
  schemaDir?: string;
  now?: () => number;
};

export function createDuckDbPack(opts: CreateDuckDbPackOpts = {}): Pack & {
  kept(): DuckDbKept | undefined;
  agent(): DuckDbAgent | undefined;
  data(ctx: { env: Record<string, string | undefined> }): DuckDbData;
} {
  let kept: DuckDbKept | undefined;
  let cachedData: DuckDbData | undefined;
  let cachedSchemas: DuckDbSchemas | undefined;
  let cachedAgent: DuckDbAgent | undefined;

  const initServices = (env: Record<string, string | undefined>, ctx?: { publish(topics: string[]): void }) => {
    const sources = parseSources(env.DUCKDB_SOURCES);
    const data = createDuckDbData({ sources, run: opts.run, now: opts.now });
    const schemas = createDuckDbSchemas({ data, dir: opts.schemaDir, now: opts.now });
    const defaultMode = (env.DUCKDB_EXECUTION?.trim().toLowerCase() === "agentic" ? "agentic" : "manual") as "manual" | "agentic";
    const agent = createDuckDbAgent({
      asker: opts.asker,
      schemas,
      data,
      defaultMode,
      now: opts.now,
      onChange: (id) => {
        ctx?.publish([`duckdb-ask:${id}`, "duckdb"]);
      },
    });

    cachedData = data;
    cachedSchemas = schemas;
    cachedAgent = agent;

    return { data, schemas, agent, sources, defaultMode };
  };

  return {
    kept: () => kept,
    agent: () => cachedAgent,
    data: (ctx) => {
      if (cachedData) return cachedData;
      return initServices(ctx.env).data;
    },

    manifest: {
      api: PACK_API,
      id: "duckdb",
      name: "DuckDB",
      description: "Agentic analytics on local DuckDB databases, Parquet, CSV, and JSON lines files.",
      domain: "general",
      execution: "local-only",
      requiredBinaries: ["duckdb"],
      everyMs: 5 * 60_000,
      settings: [
        {
          key: "DUCKDB_SOURCES",
          label: "DuckDB sources",
          required: true,
          help: "Comma-separated targets: name=/path/to/db.duckdb, directory of .parquet/.csv/.jsonl files, or :memory:",
        },
        {
          key: "DUCKDB_EXECUTION",
          label: "Execution mode",
          help: "manual (default, human clicks Run) or agentic (allows bounded exploratory SELECT queries)",
        },
      ],
    },

    async refresh(ctx) {
      kept = await readDuckDb(ctx, opts.run, opts.now?.());
      ctx.publish(["duckdb", "snapshot"]);
    },

    styles: FILES_STYLES,

    nav: () => [{ href: "/duckdb", title: "DuckDB", icon: "db", group: "Code" }],

    pages: () => [
      {
        title: "DuckDB",
        href: "/duckdb",
        icon: "🦆",
        about: "DuckDB agentic data pack",
        also: ["sql", "parquet", "query", "duckdb"],
      },
      {
        title: "DuckDB files",
        href: "/duckdb/files",
        icon: "🦆",
        about: "Open a Parquet, CSV or JSON lines file: schema, stats and rows",
        also: ["parquet", "csv", "jsonl", "schema", "file viewer"],
      },
    ],

    today: () => (kept ? [{ id: "now", render: duckdbCard(parseSources(undefined), kept.sources.length) }] : []),

    bino: () => {
      if (!kept?.ok) return "DuckDB: not configured or sources unreachable.";
      const s = kept.sources;
      if (!s.length) return "DuckDB: no sources configured.";
      return `DuckDB: ${s.length} configured ${s.length === 1 ? "source" : "sources"} (${s
        .map((x) => `${x.label}: ${x.tablesCount} tables`)
        .join(", ")}).`;
    },

    routes(app, ctx) {
      app.get("/duckdb", async (c) => {
        const { data, agent, defaultMode } = initServices(ctx.env, ctx);
        return ctx.page(c, {
          title: "DuckDB",
          body: duckdbHome({
            sources: data.sources(),
            defaultMode,
            whyAgent: agent.why(),
          }),
        });
      });

      app.get("/duckdb/db", async (c) => {
        const { data, agent, defaultMode } = initServices(ctx.env, ctx);
        const t = c.req.query("t") ?? "";
        const target = data.source(t);
        if (!target) {
          return ctx.page(c, {
            title: "DuckDB",
            body: duckdbHome({
              sources: data.sources(),
              defaultMode,
              whyAgent: agent.why(),
            }),
          });
        }

        const find = c.req.query("find")?.trim();
        let tables: any[] = [];
        let found: any[] | undefined;
        let error: string | undefined;

        try {
          tables = await data.tables(t);
          if (find) {
            found = await data.find(t, find);
          }
        } catch (e) {
          error = String((e as Error)?.message ?? e);
        }

        return ctx.page(c, {
          title: target.label,
          body: duckdbSourcePage({
            target,
            tables,
            find,
            found,
            defaultMode,
            whyAgent: agent.why(),
            error,
          }),
        });
      });

      app.get("/duckdb/table", async (c) => {
        const { data, agent, defaultMode } = initServices(ctx.env, ctx);
        const t = c.req.query("t") ?? "";
        const n = c.req.query("n") ?? "";
        const target = data.source(t);
        if (!target) return c.redirect("/duckdb", 303);

        let cols: any[] = [];
        let peek: any;
        let error: string | undefined;

        try {
          cols = await data.cols(t, n);
          peek = await data.peek(t, n, 50);
        } catch (e) {
          error = String((e as Error)?.message ?? e);
        }

        return ctx.page(c, {
          title: n,
          body: duckdbTablePage({
            target,
            table: n,
            cols,
            peek,
            defaultMode,
            whyAgent: agent.why(),
            error,
          }),
        });
      });

      // The file viewer: GET only (it reads), the path checked inside a folder source before DuckDB sees it.
      app.get("/duckdb/files", async (c) => {
        const { data } = initServices(ctx.env, ctx);
        const sources = data.sources();
        const t = c.req.query("t") ?? "";
        const f = c.req.query("f") ?? "";
        if (!t) return ctx.page(c, { title: "Files", body: filesHome({ sources }) });
        const target = data.source(t);
        const opened = target ? open(target, f, c.req.query("all") === "1") : undefined;
        if (!target || !target.isDir || !opened) {
          c.status(404);
          return ctx.page(c, { title: "Files", body: notOpenPage({ target: target?.isDir ? target : undefined, t, f, sources }) });
        }
        if (opened.type === "dir") {
          return ctx.page(c, { title: opened.rel || target.label, body: folderPage({ target, dir: opened }) });
        }
        const n = Number(c.req.query("n"));
        const size = (PAGE_SIZES as readonly number[]).includes(n) ? n : 50;
        const page = Math.min(100_000, Math.max(0, Math.floor(Number(c.req.query("p")) || 0)));
        const cols = c.req.queries("c")?.slice(0, 1000);
        const q = { cols, size, page, stats: c.req.query("stats") === "1", ...sliceParams((k) => c.req.query(k)) };
        const seen = await look(data, t, opened, q);
        return ctx.page(c, { title: opened.rel.split("/").pop() || target.label, body: filePage({ target, file: opened, look: seen, q }) });
      });

      // The same slice as a download: a GET too (it only reads), the same path checks, capped rows.
      app.get("/duckdb/files/export", async (c) => {
        const { data } = initServices(ctx.env, ctx);
        const t = c.req.query("t") ?? "";
        const target = data.source(t);
        const opened = target ? open(target, c.req.query("f") ?? "", c.req.query("all") === "1") : undefined;
        if (!target || !opened || opened.type !== "file") return c.text("Not a file to export.", 404);
        const as = c.req.query("as") === "json" ? "json" : "csv";
        let out;
        try {
          out = await slice(data, t, opened, { cols: c.req.queries("c")?.slice(0, 1000), ...sliceParams((k) => c.req.query(k)) });
        } catch (e) {
          return c.text(`DuckDB said: ${String((e as Error)?.message ?? e).slice(0, 300)}`, 502);
        }
        const body = as === "csv" ? toCsv(out.columns, out.rows) : JSON.stringify(out.rows.map((r) => Object.fromEntries(out.columns.map((k) => [k, r[k] ?? null]))), null, 2);
        return c.body(body, 200, {
          "content-type": as === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${exportName(opened.rel, opened.all, as)}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          ...(out.capped ? { "x-dovre-capped": String(out.rows.length) } : {}),
        });
      });

      app.post("/duckdb/q", async (c) => {
        const { data } = initServices(ctx.env, ctx);
        const body = await c.req.parseBody();
        const t = typeof body.t === "string" ? body.t.trim() : "";
        const rawSql = typeof body.sql === "string" ? body.sql : "";
        const askId = typeof body.ask === "string" ? body.ask.trim() : undefined;
        const target = data.source(t);

        if (!target) return c.redirect("/duckdb", 303);

        const safe = sqlOk(rawSql);
        if (!safe) {
          return ctx.page(c, {
            title: "Query Error",
            body: duckdbResultPage({
              target,
              sql: rawSql,
              error: "Query rejected: DuckDB pack allows single SELECT or WITH … SELECT queries only. Writes, DDL, and dangerous statements are refused.",
              askId,
            }),
          });
        }

        let rows: any;
        let error: string | undefined;
        try {
          rows = await data.query(t, safe, MAX_ROWS);
        } catch (e) {
          error = String((e as Error)?.message ?? e);
        }

        return ctx.page(c, {
          title: "Query Result",
          body: duckdbResultPage({
            target,
            sql: safe,
            rows,
            error,
            askId,
          }),
        });
      });

      app.get("/duckdb/schema", async (c) => {
        const { data, schemas } = initServices(ctx.env, ctx);
        const t = c.req.query("t") ?? "";
        if (!data.source(t)) {
          return c.json({ error: `Unknown source: ${t}` }, 404);
        }
        try {
          const s = await schemas.get(t);
          return c.json(toAutocomplete(s));
        } catch (e) {
          return c.json({ error: String((e as Error)?.message ?? e) }, 502);
        }
      });

      app.post("/duckdb/ask", async (c) => {
        const { agent } = initServices(ctx.env, ctx);
        const body = await c.req.parseBody();
        const t = typeof body.t === "string" ? body.t.trim() : "";
        const question = typeof body.question === "string" ? body.question : "";
        const more = typeof body.more === "string" ? body.more : "";
        const fullQ = more ? `${question}\n${more}` : question;
        const mode = body.agentic === "1" || body.agentic === "true" ? "agentic" : "manual";

        const job = agent.start(t, fullQ, mode);
        return c.redirect(askHref(job.id), 303);
      });

      app.get("/duckdb/ask/:id", async (c) => {
        const { agent } = initServices(ctx.env, ctx);
        const id = c.req.param("id");
        const job = agent.get(id);
        if (!job) return c.redirect("/duckdb", 303);

        return ctx.page(c, {
          title: "Ask",
          body: duckdbAskPage({ job, model: agent.model }),
          head: html`<meta name="u-topics" content="duckdb duckdb-ask:${id}">`,
        });
      });

      app.post("/duckdb/ask/:id/review", async (c) => {
        const { data, agent } = initServices(ctx.env, ctx);
        const id = c.req.param("id");
        const job = agent.get(id);
        if (!job) return c.redirect("/duckdb", 303);

        const body = await c.req.parseBody();
        const t = typeof body.t === "string" ? body.t.trim() : job.t;
        const sql = typeof body.sql === "string" ? body.sql.trim() : job.proposal?.sql ?? "";

        if (sqlOk(sql)) {
          try {
            const rows = await data.query(t, sql, 100);
            agent.review(id, sql, rows);
          } catch (e) {
            agent.review(id, sql, { rows: [], columns: [], capped: false, ms: 0 });
          }
        }

        return c.redirect(`${askHref(id)}#review`, 303);
      });

      app.post("/duckdb/across", async (c) => {
        const { agent } = initServices(ctx.env, ctx);
        const body = await c.req.parseBody();
        const question = typeof body.question === "string" ? body.question : "";
        const more = typeof body.more === "string" ? body.more : "";
        const fullQ = more ? `${question}\n${more}` : question;
        const mode = body.agentic === "1" || body.agentic === "true" ? "agentic" : "manual";

        const a = agent.across(fullQ, mode);
        return c.redirect(acrossHref(a.id), 303);
      });

      app.get("/duckdb/across/:id", async (c) => {
        const { agent } = initServices(ctx.env, ctx);
        const id = c.req.param("id");
        const across = agent.getAcross(id);
        if (!across) return c.redirect("/duckdb", 303);

        return ctx.page(c, {
          title: "Ask Across Sources",
          body: duckdbAcrossPage({
            across,
            jobs: (jid) => agent.get(jid),
            model: agent.model,
          }),
          head: html`<meta name="u-topics" content="duckdb duckdb-ask:${id}">`,
        });
      });
    },
  };
}

export const duckdbPack: Pack = createDuckDbPack();
export const duckdbCrate = duckdbPack;
