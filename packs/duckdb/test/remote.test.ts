/**
 * Remote files (a URL typed on the Files page, or `name=https://…` in DUCKDB_SOURCES): only public
 * http(s)/s3/gs URLs without credentials or globs, every run loads httpfs by name before the lock
 * and is shut in to that one URL (plus the CA bundle), and a hostile URL renders inert. A fake
 * runner, and the real CLI against a local HTTP server where httpfs is installed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { testContext } from "dovre/packs/testing.ts";
import { createDuckDbPack } from "../index.ts";
import { cleanUrl, createDuckDbData, type DuckDbRunner, parseSources, remoteSource, urlKind } from "../data.ts";
import { lit, look, open } from "../files.ts";

const H = `<script>alert(1)</script>`;
const base = mkdtempSync(join(tmpdir(), "duckdb-remote-"));
after(() => rmSync(base, { recursive: true, force: true }));

function fake(o: { fail?: string } = {}): DuckDbRunner & { seen: string[] } {
  const seen: string[] = [];
  const run = (async (_a: string[], opts?: { input?: string }) => {
    const sql = opts?.input ?? "";
    seen.push(sql);
    if (o.fail) return { stdout: "", stderr: o.fail, code: 1 };
    const out = (rows: unknown[]) => ({ stdout: JSON.stringify(rows), stderr: "", code: 0 });
    if (sql.includes("DESCRIBE SELECT")) return out([{ column_name: H, column_type: "VARCHAR" }, { column_name: "id", column_type: "BIGINT" }]);
    if (/SELECT .* FROM read_/.test(sql)) return out([{ [H]: H, id: 1 }]);
    return out([]);
  }) as DuckDbRunner & { seen: string[] };
  run.seen = seen;
  return run;
}

function mount(run: DuckDbRunner, sources = "") {
  const ctx = testContext({ env: { DUCKDB_SOURCES: sources }, page: async (c, o) => c.html(String(await o.body)) });
  const app = new Hono();
  createDuckDbPack({ run, uploadsDir: join(base, "never") }).routes!(app as any, ctx);
  return (p: string, headers: Record<string, string> = {}) => app.request(`http://localhost${p}`, { headers });
}

const inert = (body: string) => {
  assert.ok(!body.includes("<script>alert(1)"), "no live script tag");
  assert.ok(!body.includes("<img src=x"), "no live img tag");
  assert.ok(!/href="javascript:/i.test(body), "no javascript: link");
};

const shutIn = (sql: string, url: string) => {
  const lines = sql.split("\n");
  assert.equal(lines[0], "SET allow_persistent_secrets = false;", sql);
  assert.equal(lines[1], "LOAD httpfs;", sql);
  assert.ok(lines[2]!.startsWith(`SET allowed_paths = [${lit(url)}`), sql);
  assert.ok(sql.indexOf("SET lock_configuration = true;") < sql.search(/SELECT|DESCRIBE/), "locked before it reads");
  assert.match(sql, /SET enable_external_access = false;/);
  assert.match(sql, /SET autoload_known_extensions = false;/);
};

test("remote: only public http(s), s3 and gs URLs, without credentials or globs", () => {
  assert.equal(cleanUrl(" https://example.com/d/o.parquet "), "https://example.com/d/o.parquet");
  assert.equal(cleanUrl("s3://bucket/a/b.csv"), "s3://bucket/a/b.csv");
  assert.equal(cleanUrl("gs://bucket/x.jsonl"), "gs://bucket/x.jsonl");
  assert.equal(cleanUrl("https://h/o.parquet?X-Amz-Signature=abc"), "https://h/o.parquet?X-Amz-Signature=abc");
  for (const bad of [
    "file:///etc/passwd",
    "ftp://h/x.csv",
    "javascript:alert(1)",
    "https://user:pw@h/x.parquet",
    "https://user@h/x.parquet",
    "https://h/a b.csv",
    "https://h/x\n.csv",
    "s3://bucket/*.parquet",
    "s3://bucket/[ab].parquet",
    "https://h/%2A.parquet",
    "https://h/{a,b}.parquet",
    `https://h/${"x".repeat(2100)}.csv`,
    "/local/path.parquet",
    "",
  ])
    assert.equal(cleanUrl(bad), undefined, bad);
  assert.equal(urlKind("https://h/o.parquet?sig=1.csv"), "parquet", "the path's ending, not the query's");
  assert.equal(urlKind("https://h/data"), undefined);

  const [taxi, s3, dropped] = parseSources("taxi=https://h/d/taxi.parquet,ev=s3://b/ev.csv,bad=https://u:p@h/x.parquet,local=/x/y.parquet");
  assert.deepEqual(taxi, { id: "taxi", label: "taxi", path: "https://h/d/taxi.parquet", url: "https://h/d/taxi.parquet", file: "parquet" });
  assert.equal(s3!.file, "csv");
  assert.equal(dropped!.id, "local", "a URL with credentials is never a source");
  assert.equal(open(taxi!, "x"), undefined);
  assert.equal(open(taxi!, "", true), undefined);
});

test("remote: a typed URL opens shut in to that URL; links keep it; nothing goes to the query form", async () => {
  const run = fake();
  const get = mount(run);
  const url = "https://example.com/d/orders.parquet";
  const r = await get(`/duckdb/files?u=${encodeURIComponent(url)}&stats=1`);
  assert.equal(r.status, 200);
  const body = await r.text();
  inert(body);
  assert.ok(run.seen.length >= 4);
  for (const sql of run.seen) {
    shutIn(sql, url);
    assert.ok(!sql.includes("CREATE OR REPLACE TEMPORARY VIEW"), "the viewer names the file itself");
  }
  assert.ok(body.includes(`u=${encodeURIComponent(url)}`), "paging and filter links keep the URL");
  assert.ok(body.includes(`<input type="hidden" name="u" value="${url}">`));
  assert.ok(!body.includes('action="/duckdb/q"'), "no query form for a URL that isn't a source");
  assert.ok(body.includes("orders=https://example.com/d/orders.parquet"), "says how to make it a source");

  const csv = await get(`/duckdb/files/export?u=${encodeURIComponent(url)}&as=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition") ?? "", /filename="orders-slice\.csv"/);
});

test("remote: refused when it isn't one, from another site, or its kind is unknown; hostile URLs render inert", async () => {
  const run = fake();
  const get = mount(run);
  for (const u of ["javascript:alert(1)", `https://h/${H}.parquet"><img src=x onerror=alert(1)>`, "file:///etc/passwd", "https://u:p@h/x.parquet"]) {
    const r = await get(`/duckdb/files?u=${encodeURIComponent(u)}`);
    const body = await r.text();
    inert(body);
    if (r.status === 200) assert.ok(u.startsWith("https://h/"), `${u} opened`);
    else assert.equal(r.status, 400, u);
  }
  assert.equal(run.seen.filter((s) => s.includes("file://") || s.includes("u:p@") || s.includes("javascript:")).length, 0, "never reached DuckDB");
  for (const s of run.seen) assert.ok(!s.includes("<script>"), "the URL reaches SQL percent-encoded");

  const before = run.seen.length;
  assert.equal((await get(`/duckdb/files?u=${encodeURIComponent("https://h/x.parquet")}`, { "sec-fetch-site": "cross-site" })).status, 404);
  assert.equal((await get(`/duckdb/files/export?u=${encodeURIComponent("https://h/x.parquet")}`, { "sec-fetch-site": "same-site" })).status, 404);
  assert.equal(run.seen.length, before, "another site's request never runs DuckDB");

  const noKind = await get(`/duckdb/files?u=${encodeURIComponent("https://h/data")}`);
  assert.equal(noKind.status, 400);
  assert.ok((await noKind.text()).includes("pick its kind"));
  const csv = await get(`/duckdb/files?u=${encodeURIComponent("https://h/data")}&k=csv`);
  assert.equal(csv.status, 200);
  assert.ok(run.seen.at(-1)!.includes(`read_csv(${lit("https://h/data")})`));
  assert.ok((await csv.text()).includes('name="k" value="csv"'), "the picked kind stays on the page's forms");
});

test("remote: a URL source gets one view and a query form; a missing httpfs says how to install it", async () => {
  const run = fake();
  const data = createDuckDbData({ sources: parseSources("taxi=https://h/d/Taxi-2019.parquet"), run });
  await data.query("taxi", "SELECT count(*) FROM taxi_2019");
  shutIn(run.seen[0]!, "https://h/d/Taxi-2019.parquet");
  assert.ok(run.seen[0]!.includes(`CREATE OR REPLACE TEMPORARY VIEW "taxi_2019" AS SELECT * FROM read_parquet('https://h/d/Taxi-2019.parquet');`));

  const page = await (await mount(fake(), "taxi=https://h/d/Taxi-2019.parquet")("/duckdb/files?t=taxi")).text();
  assert.ok(page.includes('action="/duckdb/q"') && page.includes("FROM &quot;taxi_2019&quot;"));

  const missing = createDuckDbData({ sources: [remoteSource("https://h/x.csv", "csv")], run: fake({ fail: `IO Error: Extension "/x/httpfs.duckdb_extension" not found.` }) });
  await assert.rejects(missing.scan("url", "SELECT 1"), /INSTALL httpfs/);
});

// ── The real CLI, against a local HTTP server (skipped without duckdb or its httpfs) ──

const httpfs = (() => {
  try {
    const env = { ...process.env };
    delete env.AI_AGENT;
    delete env.CLAUDECODE;
    const out = execFileSync("duckdb", ["-json", ":memory:", "-c", "SELECT installed FROM duckdb_extensions() WHERE extension_name = 'httpfs';"], { env, encoding: "utf8" });
    return JSON.parse(out)[0]?.installed === true;
  } catch {
    return false;
  }
})();

test("real duckdb: a URL is read through httpfs, and nothing beside it", { skip: !httpfs && "duckdb or its httpfs extension not installed" }, async () => {
  const env = { ...process.env };
  delete env.AI_AGENT;
  const f = join(base, "t.parquet");
  const local = join(base, "local.csv");
  execFileSync("duckdb", [":memory:", "-c", `COPY (SELECT range AS id FROM range(12)) TO ${lit(f)}; COPY (SELECT 1 AS a) TO ${lit(local)};`], { env, stdio: "ignore" });
  const bytes = readFileSync(f);
  const server = createServer((req, res) => {
    if (req.url !== "/t.parquet" && req.url !== "/other.parquet") return void res.writeHead(404).end();
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    const to = range && range[2] ? Number(range[2]) : bytes.length - 1;
    res.writeHead(range ? 206 : 200, { "content-length": to - from + 1, "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${from}-${to}/${bytes.length}` } : {}) });
    res.end(req.method === "HEAD" ? undefined : bytes.subarray(from, to + 1));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const t = remoteSource(`${root}/t.parquet`, "parquet");
    const data = createDuckDbData({ sources: [t] });
    const seen = await look(data, "url", open(t, "") as Extract<ReturnType<typeof open>, { type: "file" }>, { size: 5, page: 1 });
    assert.equal(seen.error, undefined);
    assert.equal(seen.facts?.rows, 12);
    assert.deepEqual(seen.page.rows.map((r) => Number(r.id)), [5, 6, 7, 8, 9]);
    await assert.rejects(data.scan("url", `SELECT * FROM read_parquet(${lit(`${root}/other.parquet`)})`), /disabled|Permission/i);
    await assert.rejects(data.scan("url", `SELECT * FROM read_csv(${lit(local)})`), /disabled|Permission/i);
    await assert.rejects(data.scan("url", "SELECT * FROM getenv('HOME')"), /getenv|Catalog/i);
  } finally {
    server.close();
  }
});
