/**
 * DuckDB Pack (`duckdb`) test suite:
 * - Manifest and PACK_API validation
 * - sqlOk read-only guard against writes, semicolons, and extensions
 * - Zero-row schema discovery and 24h caching
 * - schemaPart keyword and stem scoring
 * - Manual query execution flow (capped at 500 rows, not persisted)
 * - Agentic execution flow (up to 3 bounded exploratory queries)
 * - AI Result Review (/duckdb/ask/:id/review)
 * - Ask across sources (/duckdb/across)
 * - Hostile-input XSS and URL sanitization
 * - Bino states & counts privacy bounds
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { PACK_API } from "dovre/packs/types.ts";
import { testContext } from "dovre/packs/testing.ts";
import { createDuckDbPack, duckdbPack } from "../index.ts";
import {
  type DuckDbRunner,
  MAX_ROWS,
  MAX_SQL,
  parseDuckDbJson,
  parseSources,
} from "../data.ts";
import { createDuckDbSchemas, schemaOf, schemaPart, toAutocomplete } from "../schema.ts";
import {
  agenticPrompt,
  type Asker,
  createDuckDbAgent,
  jsonIn,
  pickPrompt,
  picksOf,
  proposalOf,
  reviewPrompt,
  sqlOk,
} from "../agent.ts";
import {
  cell,
  duckdbAcrossPage,
  duckdbAskPage,
  duckdbHome,
  duckdbResultPage,
  duckdbSourcePage,
  duckdbTablePage,
  rowsTable,
} from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const JS_URL = "javascript:alert(1)";

function fakeAsker(answers: string[]): Asker & { seen: string[] } {
  const seen: string[] = [];
  const queue = [...answers];
  return {
    model: "test-model",
    seen,
    why: () => undefined,
    async ask(prompt: string): Promise<string> {
      seen.push(prompt);
      const next = queue.shift();
      if (!next) throw new Error(`fakeAsker out of answers (asked: ${prompt.slice(0, 100)})`);
      return next;
    },
  };
}

test("duckdb: manifest adheres to PACK_API and declares settings", () => {
  assert.equal(duckdbPack.manifest.api, PACK_API);
  assert.equal(duckdbPack.manifest.id, "duckdb");
  assert.equal(duckdbPack.manifest.execution, "local-only");
  assert.deepEqual(duckdbPack.manifest.requiredBinaries, ["duckdb"]);

  const settingsKeys = duckdbPack.manifest.settings?.map((s) => s.key);
  assert.ok(settingsKeys?.includes("DUCKDB_SOURCES"));
  assert.ok(settingsKeys?.includes("DUCKDB_EXECUTION"));
});

test("duckdb: sqlOk enforces single read-only SELECT and rejects hostile/write/extension SQL", () => {
  // Valid queries
  assert.equal(sqlOk("SELECT * FROM users"), "SELECT * FROM users");
  assert.equal(sqlOk("  select id, name from users;  "), "select id, name from users");
  assert.equal(
    sqlOk("WITH active AS (SELECT * FROM users WHERE active = true) SELECT count(*) FROM active;"),
    "WITH active AS (SELECT * FROM users WHERE active = true) SELECT count(*) FROM active"
  );
  // String literal containing forbidden words should be permitted
  assert.equal(
    sqlOk("SELECT 'COPY file TO dest' AS col, 'ATTACH' AS a FROM orders"),
    "SELECT 'COPY file TO dest' AS col, 'ATTACH' AS a FROM orders"
  );

  // Multi-statement queries with semicolons
  assert.equal(sqlOk("SELECT 1; SELECT 2"), undefined);
  assert.equal(sqlOk("SELECT 1; DROP TABLE users;"), undefined);

  // DDL / DML writes
  assert.equal(sqlOk("DROP TABLE users"), undefined);
  assert.equal(sqlOk("INSERT INTO users VALUES (1)"), undefined);
  assert.equal(sqlOk("UPDATE users SET name = 'admin'"), undefined);
  assert.equal(sqlOk("DELETE FROM users"), undefined);
  assert.equal(sqlOk("CREATE TABLE test (id INT)"), undefined);
  assert.equal(sqlOk("ALTER TABLE test ADD COLUMN x INT"), undefined);
  assert.equal(sqlOk("TRUNCATE TABLE users"), undefined);
  assert.equal(sqlOk("WITH t AS (SELECT 1) INSERT INTO x SELECT * FROM t"), undefined);

  // Dangerous DuckDB extensions & maintenance commands
  assert.equal(sqlOk("COPY users TO 'out.parquet'"), undefined);
  assert.equal(sqlOk("ATTACH 'other.duckdb'"), undefined);
  assert.equal(sqlOk("INSTALL httpfs"), undefined);
  assert.equal(sqlOk("LOAD httpfs"), undefined);
  assert.equal(sqlOk("EXPORT DATABASE 'backup'"), undefined);
  assert.equal(sqlOk("PRAGMA version"), undefined);
  assert.equal(sqlOk("CALL checkpoint()"), undefined);

  // Limits and type checks
  assert.equal(sqlOk(null), undefined);
  assert.equal(sqlOk(123), undefined);
  assert.equal(sqlOk(""), undefined);
  assert.equal(sqlOk("SELECT ".padEnd(MAX_SQL + 10, "x")), undefined);
});

test("duckdb: zero-row schema exploration and 24h caching", async () => {
  let runnerInvocations = 0;
  const runner: DuckDbRunner = async (args, opts) => {
    runnerInvocations++;
    // Verify arguments run with -readonly and -json
    assert.ok(args.includes("-readonly"));
    assert.ok(args.includes("-json"));
    // Return sample schema rows
    return {
      stdout: JSON.stringify([
        { s: "main", t: "customers", c: "id", ty: "BIGINT" },
        { s: "main", t: "customers", c: "name", ty: "VARCHAR" },
        { s: "main", t: "customers", c: "email", ty: "VARCHAR" },
        { s: "main", t: "orders", c: "order_id", ty: "BIGINT" },
        { s: "main", t: "orders", c: "customer_id", ty: "BIGINT" },
        { s: "main", t: "orders", c: "amount", ty: "DECIMAL(10,2)" },
      ]),
      stderr: "",
      code: 0,
    };
  };

  const pack = createDuckDbPack({ run: runner });
  const ctx = testContext({ env: { DUCKDB_SOURCES: "analytics=/var/data/analytics.duckdb" } });
  const data = pack.data(ctx);
  const schemas = createDuckDbSchemas({ data });

  // First fetch runs discovery
  const schema1 = await schemas.get("analytics");
  assert.equal(schema1.from, "analytics");
  assert.equal(schema1.tables.length, 2);
  assert.equal(schema1.tables[0]!.name, "customers");
  assert.equal(schema1.tables[0]!.cols.length, 3);
  assert.equal(runnerInvocations, 1);

  // Second fetch within 24h uses in-memory cache without calling runner
  const schema2 = await schemas.get("analytics");
  assert.equal(schema2, schema1);
  assert.equal(runnerInvocations, 1);

  // Autocomplete representation
  const ac = toAutocomplete(schema1);
  assert.equal(ac.from, "analytics");
  assert.equal(ac.tables.length, 2);
  assert.deepEqual(ac.tables[0]![0], "customers");
});

test("duckdb: schemaPart keyword and stem scoring", () => {
  const schema = {
    from: "analytics",
    at: Date.now(),
    tables: [
      { name: "users", cols: [["id", "BIGINT"], ["name", "VARCHAR"]] as [string, string][] },
      { name: "orders", cols: [["id", "BIGINT"], ["amount", "DECIMAL"]] as [string, string][] },
      { name: "kunder", cols: [["kunde_nr", "INT"], ["navn", "VARCHAR"]] as [string, string][] },
    ],
  };

  // Small schema returns all tables directly
  const smallPart = schemaPart("how many orders?", schema);
  assert.ok(smallPart.includes("users(id BIGINT, name VARCHAR)"));
  assert.ok(smallPart.includes("orders(id BIGINT, amount DECIMAL)"));
  assert.ok(smallPart.includes("kunder(kunde_nr INT, navn VARCHAR)"));

  // Build large schema exceeding token budget
  const largeTables: { name: string; cols: [string, string][] }[] = [];
  for (let i = 0; i < 600; i++) {
    largeTables.push({
      name: `tbl_warehouse_records_${i}`,
      cols: [
        [`col_field_dimension_alpha_${i}`, "VARCHAR"],
        [`col_metric_value_beta_${i}`, "DECIMAL(12,2)"],
      ],
    });
  }
  // Add target table matching question
  largeTables.push({
    name: "kunde_transaksjoner",
    cols: [
      ["kunde_id", "BIGINT"],
      ["belop", "DECIMAL(10,2)"],
    ],
  });

  const largeSchema = { from: "test", at: Date.now(), tables: largeTables };
  const part = schemaPart("vis alle transaksjoner for kunde", largeSchema);

  // Scorer prioritizes matching stem "kunde" and "transaksjoner"
  assert.ok(part.includes("kunde_transaksjoner"));
  assert.ok(part.includes("All tables:"));
});

test("duckdb: manual execution flow via query runner (capped at 500 rows, not persisted)", async () => {
  // Generate 600 rows to test capping
  const testRows = Array.from({ length: 600 }, (_, i) => ({
    id: i + 1,
    category: `cat_${i % 5}`,
    val: i * 1.5,
  }));

  const runner: DuckDbRunner = async () => ({
    stdout: JSON.stringify(testRows),
    stderr: "",
    code: 0,
  });

  const pack = createDuckDbPack({ run: runner });
  const ctx = testContext({ env: { DUCKDB_SOURCES: "main=:memory:" } });
  const data = pack.data(ctx);

  const res = await data.query("main", "SELECT * FROM test_table");
  assert.equal(res.rows.length, MAX_ROWS);
  assert.equal(res.capped, true);
  assert.deepEqual(res.columns, ["id", "category", "val"]);
  assert.ok(res.ms >= 0);
});

test("duckdb: agentic execution flow with bounded exploratory queries", async () => {
  const runnerQueries: string[] = [];
  const runner: DuckDbRunner = async (args, opts) => {
    if (opts?.input) runnerQueries.push(opts.input);
    if (opts?.input?.includes("information_schema")) {
      return {
        stdout: JSON.stringify([
          { s: "main", t: "products", c: "id", ty: "INT" },
          { s: "main", t: "products", c: "status", ty: "VARCHAR" },
          { s: "main", t: "products", c: "price", ty: "DECIMAL" },
        ]),
        stderr: "",
        code: 0,
      };
    }
    // Return sample distinct values for exploratory query
    return {
      stdout: JSON.stringify([
        { status: "active", count: 120 },
        { status: "archived", count: 15 },
      ]),
      stderr: "",
      code: 0,
    };
  };

  const asker = fakeAsker([
    // Turn 1: exploratory query to inspect distinct status values
    JSON.stringify({
      explore: "SELECT status, count(*) AS count FROM products GROUP BY status",
      why: "inspecting distinct status values in products table",
    }),
    // Turn 2: final proposal using findings
    JSON.stringify({
      sql: "SELECT * FROM products WHERE status = 'active' ORDER BY price DESC LIMIT 10",
      says: "Returns the 10 most expensive active products.",
    }),
  ]);

  const pack = createDuckDbPack({ run: runner, asker });
  const ctx = testContext({ env: { DUCKDB_SOURCES: "main=:memory:", DUCKDB_EXECUTION: "agentic" } });
  const data = pack.data(ctx);
  const schemas = createDuckDbSchemas({ data });
  const agent = createDuckDbAgent({ asker, schemas, data, defaultMode: "agentic" });

  const job = agent.start("main", "Which active products are the most expensive?", "agentic");

  // Wait for background job to finish
  let tries = 0;
  while (job.state === "thinking" && tries++ < 30) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(job.state, "ready");
  assert.equal(job.explorations?.length, 1);
  assert.ok(job.explorations![0]!.query.includes("GROUP BY status"));
  assert.equal(job.proposal?.sql, "SELECT * FROM products WHERE status = 'active' ORDER BY price DESC LIMIT 10");
  assert.equal(job.proposal?.says, "Returns the 10 most expensive active products.");
});

test("duckdb: opt-in AI result review parses anomalies and proposes better query", async () => {
  const asker = fakeAsker([
    `The result is empty because the date filter was set to 2025 instead of 2026.
{"sql": "SELECT * FROM sales WHERE year = 2026", "says": "Returns sales for current year 2026."}`,
  ]);

  const runner: DuckDbRunner = async () => ({
    stdout: JSON.stringify([{ id: 1, val: 50 }]),
    stderr: "",
    code: 0,
  });

  const pack = createDuckDbPack({ run: runner, asker });
  const ctx = testContext({ env: { DUCKDB_SOURCES: "main=:memory:" } });
  const data = pack.data(ctx);
  const schemas = createDuckDbSchemas({ data });
  const agent = createDuckDbAgent({ asker, schemas, data });

  const job = agent.start("main", "Show 2026 sales");
  job.state = "ready";
  job.proposal = { sql: "SELECT * FROM sales WHERE year = 2025", says: "Sales" };

  agent.review(job.id, job.proposal.sql, {
    rows: [],
    columns: ["id", "val"],
    capped: false,
    ms: 5,
  });

  let tries = 0;
  while (job.review?.state === "thinking" && tries++ < 30) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(job.review?.state, "ready");
  assert.ok(job.review?.text?.includes("date filter was set to 2025"));
  assert.equal(job.review?.proposal?.sql, "SELECT * FROM sales WHERE year = 2026");
  assert.equal(job.review?.proposal?.says, "Returns sales for current year 2026.");
});

test("duckdb: ask across sources picks up to 4 sources and creates per-source cards", async () => {
  const runner: DuckDbRunner = async (args, opts) => {
    // Return schema for sources
    return {
      stdout: JSON.stringify([
        { s: "main", t: "customers", c: "id", ty: "BIGINT" },
        { s: "main", t: "orders", c: "id", ty: "BIGINT" },
      ]),
      stderr: "",
      code: 0,
    };
  };

  const asker = fakeAsker([
    // Across pick reply
    JSON.stringify({
      picks: [
        { source: "analytics", why: "contains aggregate customer statistics" },
        { source: "warehouse", why: "contains individual order history" },
      ],
    }),
    // Sub-job 1 proposal
    JSON.stringify({
      sql: "SELECT count(*) FROM customers",
      says: "Customer count",
    }),
    // Sub-job 2 proposal
    JSON.stringify({
      sql: "SELECT count(*) FROM orders",
      says: "Order count",
    }),
  ]);

  const pack = createDuckDbPack({ run: runner, asker });
  const ctx = testContext({
    env: { DUCKDB_SOURCES: "analytics=:memory:,warehouse=:memory:,logs=:memory:" },
  });
  const data = pack.data(ctx);
  const schemas = createDuckDbSchemas({ data });
  const agent = createDuckDbAgent({ asker, schemas, data });

  const across = agent.across("Where are our customer metrics?");

  let tries = 0;
  while (across.state === "picking" && tries++ < 30) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(across.state, "ready");
  assert.equal(across.picks.length, 2);
  assert.equal(across.picks[0]!.t, "analytics");
  assert.equal(across.picks[1]!.t, "warehouse");
});

test("duckdb: views escape hostile script tags, image payloads and javascript: links", async () => {
  // 1. Home page
  const homeOut = String(
    await duckdbHome({
      sources: [
        { id: "sec", label: H, path: H },
      ],
      defaultMode: "manual",
      whyAgent: H,
    })
  );
  assert.ok(!homeOut.includes("<script>"), "script tag in home");
  assert.ok(!homeOut.includes("<img"), "img tag in home");

  // 2. Source page
  const srcOut = String(
    await duckdbSourcePage({
      target: { id: "sec", label: H, path: H },
      tables: [{ schema: H, table: H, rows: 10 }],
      find: H,
      found: [{ schema: H, table: H, column: H, type: H }],
      defaultMode: "manual",
      whyAgent: H,
      error: H,
    })
  );
  assert.ok(!srcOut.includes("<script>"), "script tag in source page");
  assert.ok(!srcOut.includes("<img"), "img tag in source page");

  // 3. Table page
  const tblOut = String(
    await duckdbTablePage({
      target: { id: "sec", label: H, path: H },
      table: H,
      cols: [{ column: H, type: H, nullable: H }],
      peek: { rows: [{ [H]: H }], columns: [H], capped: false, ms: 1 },
      defaultMode: "manual",
      whyAgent: H,
      error: H,
    })
  );
  assert.ok(!tblOut.includes("<script>"), "script tag in table page");
  assert.ok(!tblOut.includes("<img"), "img tag in table page");

  // 4. Result page
  const resOut = String(
    await duckdbResultPage({
      target: { id: "sec", label: H, path: H },
      sql: H,
      rows: { rows: [{ [H]: H, link: JS_URL }], columns: [H, "link"], capped: true, ms: 5 },
      error: H,
      askId: "ask-1",
    })
  );
  assert.ok(!resOut.includes("<script>"), "script tag in result page");
  assert.ok(!resOut.includes("<img"), "img tag in result page");

  // 5. Ask page
  const askOut = String(
    await duckdbAskPage({
      job: {
        id: "test",
        t: H,
        question: H,
        mode: "agentic",
        at: Date.now(),
        state: "ready",
        proposal: { sql: "SELECT 1", says: H },
        explorations: [{ query: "SELECT 1", why: H, rowCount: 1 }],
        review: { state: "ready", text: H, proposal: { sql: "SELECT 2", says: H } },
      },
    })
  );
  assert.ok(!askOut.includes("<script>"), "script tag in ask page");
  assert.ok(!askOut.includes("<img"), "img tag in ask page");

  // 6. Across page
  const acrossOut = String(
    await duckdbAcrossPage({
      across: {
        id: "across-1",
        question: H,
        mode: "manual",
        at: Date.now(),
        state: "ready",
        picks: [{ t: H, why: H, job: "job-1" }],
      },
      jobs: () => undefined,
    })
  );
  assert.ok(!acrossOut.includes("<script>"), "script tag in across page");
  assert.ok(!acrossOut.includes("<img"), "img tag in across page");
});

test("duckdb: bino reports states and counts only, preserving privacy", async () => {
  const runner: DuckDbRunner = async () => ({
    stdout: JSON.stringify([
      { s: "main", t: "users" },
      { s: "main", t: "orders" },
    ]),
    stderr: "",
    code: 0,
  });

  const pack = createDuckDbPack({ run: runner });
  const ctx = testContext({ env: { DUCKDB_SOURCES: "analytics=:memory:" } });

  await pack.refresh!(ctx);
  const bino = pack.bino!(ctx);

  assert.ok(bino.includes("1 configured source"));
  assert.ok(bino.includes("analytics: 2 tables"));
  // Ensure no row data or sensitive leakage
  assert.ok(!bino.includes("SELECT"));
});

test("duckdb: HTTP routes respond with 200, 303 or 404 appropriately", async () => {
  const runner: DuckDbRunner = async (args, opts) => {
    return {
      stdout: JSON.stringify([{ id: 1, name: "Alice" }]),
      stderr: "",
      code: 0,
    };
  };

  const pack = createDuckDbPack({ run: runner });
  const app = new Hono();
  const ctx = testContext({
    env: { DUCKDB_SOURCES: "main=:memory:" },
    page: async (_c, opts) => new Response(typeof opts.body === "string" ? opts.body : String(opts.body)),
  });

  pack.routes!(app as any, ctx);

  // 1. GET /duckdb
  const rHome = await app.request("http://localhost/duckdb");
  assert.equal(rHome.status, 200);

  // 2. GET /duckdb/db?t=main
  const rDb = await app.request("http://localhost/duckdb/db?t=main");
  assert.equal(rDb.status, 200);

  // 3. GET /duckdb/schema?t=main
  const rSchema = await app.request("http://localhost/duckdb/schema?t=main");
  assert.equal(rSchema.status, 200);
  const schemaJson = (await rSchema.json()) as any;
  assert.equal(schemaJson.from, "main");

  // 4. GET /duckdb/schema?t=unknown (404)
  const rSchema404 = await app.request("http://localhost/duckdb/schema?t=unknown");
  assert.equal(rSchema404.status, 404);

  // 5. POST /duckdb/q with safe SELECT
  const rQ = await app.request("http://localhost/duckdb/q", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: "main", sql: "SELECT * FROM users;" }).toString(),
  });
  assert.equal(rQ.status, 200);
  const qHtml = await rQ.text();
  assert.ok(qHtml.includes("Query Result"));

  // 6. POST /duckdb/q with rejected write
  const rQBad = await app.request("http://localhost/duckdb/q", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: "main", sql: "DROP TABLE users;" }).toString(),
  });
  assert.equal(rQBad.status, 200);
  const qBadHtml = await rQBad.text();
  assert.ok(qBadHtml.includes("Query rejected"));
});
