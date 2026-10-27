/**
 * Private buckets (#63): S3 / GCS keys from Settings become a temporary DuckDB secret for the one
 * bucket being read, created before the lock with its output thrown away. https URLs and other
 * schemes never get them, errors never carry them, and a query can't list them. A fake runner, and
 * the real CLI against a local S3-style endpoint.
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
import { sqlOk } from "../agent.ts";
import { createDuckDbData, type DuckDbRunner, remoteKeys, remoteSource, scrub, secretSql } from "../data.ts";
import { lit, look, open } from "../files.ts";

const base = mkdtempSync(join(tmpdir(), "duckdb-keys-"));
after(() => rmSync(base, { recursive: true, force: true }));

const KEYS = { DUCKDB_S3_KEY_ID: "AKIATESTKEY0001", DUCKDB_S3_SECRET: "s3cr3t'value/xyz", DUCKDB_S3_REGION: "eu-north-1" };

function fake(o: { fail?: string } = {}): DuckDbRunner & { seen: string[] } {
  const seen: string[] = [];
  const run = (async (_a: string[], opts?: { input?: string }) => {
    seen.push(opts?.input ?? "");
    if (o.fail) return { stdout: "", stderr: o.fail, code: 1 };
    return { stdout: "[]", stderr: "", code: 0 };
  }) as DuckDbRunner & { seen: string[] };
  run.seen = seen;
  return run;
}

function mount(run: DuckDbRunner, env: Record<string, string>) {
  const ctx = testContext({ env: { DUCKDB_SOURCES: "", ...env }, page: async (c, o) => c.html(String(await o.body)) });
  const app = new Hono();
  const pack = createDuckDbPack({ run, uploadsDir: join(base, "never") });
  pack.routes!(app as any, ctx);
  return { pack, get: (p: string) => app.request(`http://localhost${p}`) };
}

test("keys: read from Settings only as whole, well-formed pairs", () => {
  assert.deepEqual(remoteKeys({}), {});
  assert.deepEqual(remoteKeys({ DUCKDB_S3_KEY_ID: "a" }), {}, "half a pair is none");
  assert.deepEqual(remoteKeys({ ...KEYS, DUCKDB_S3_REGION: "eu north'1" }), {}, "a bad region drops the pair");
  assert.deepEqual(remoteKeys({ ...KEYS, DUCKDB_S3_SECRET: "a\nb" }), {});
  assert.deepEqual(remoteKeys({ ...KEYS, DUCKDB_S3_ENDPOINT: "https://h/path" }), {}, "an endpoint is a host, nothing more");
  assert.deepEqual(remoteKeys(KEYS).s3, { keyId: "AKIATESTKEY0001", secret: "s3cr3t'value/xyz", region: "eu-north-1", ssl: true });
  assert.deepEqual(remoteKeys({ ...KEYS, DUCKDB_S3_ENDPOINT: "http://127.0.0.1:9000" }).s3?.endpoint, "127.0.0.1:9000");
  assert.equal(remoteKeys({ ...KEYS, DUCKDB_S3_ENDPOINT: "http://127.0.0.1:9000" }).s3?.ssl, false);
  assert.equal(remoteKeys({ ...KEYS, DUCKDB_S3_ENDPOINT: "acct.r2.cloudflarestorage.com" }).s3?.ssl, true);
  assert.deepEqual(remoteKeys({ DUCKDB_GCS_KEY_ID: "GOOG1", DUCKDB_GCS_SECRET: "gsecret" }), { gcs: { keyId: "GOOG1", secret: "gsecret" } });
});

test("keys: a secret only for that scheme's bucket, quoted, output thrown away", () => {
  const keys = remoteKeys({ ...KEYS, DUCKDB_GCS_KEY_ID: "GOOG1", DUCKDB_GCS_SECRET: "gsecret" });
  const s3 = secretSql("s3://my-bucket/a/b.parquet", keys);
  assert.equal(
    s3,
    ".mode trash\nCREATE TEMPORARY SECRET dovre_bucket (TYPE s3, KEY_ID 'AKIATESTKEY0001', SECRET 's3cr3t''value/xyz', REGION 'eu-north-1', SCOPE 's3://my-bucket');\n.mode json\n"
  );
  assert.match(secretSql("gs://g/x.csv", keys), /TYPE gcs, KEY_ID 'GOOG1', SECRET 'gsecret', SCOPE 'gs:\/\/g'/);
  assert.equal(secretSql("https://my-bucket.s3.amazonaws.com/x.parquet", keys), "", "https never gets keys");
  assert.equal(secretSql("gs://g/x.csv", remoteKeys(KEYS)), "", "S3 keys don't go to GCS");
  assert.equal(secretSql("s3://b/x.csv", undefined), "");
  assert.match(secretSql("s3://b/x.csv", remoteKeys({ ...KEYS, DUCKDB_S3_ENDPOINT: "http://minio:9000" })), /ENDPOINT 'minio:9000', URL_STYLE 'path', USE_SSL false, SCOPE/);
  assert.equal(scrub("bad key AKIATESTKEY0001 / s3cr3t'value/xyz", keys), "bad key … / …");
});

test("keys: a typed s3 URL gets the secret before the lock; https doesn't; errors and pages never show them", async () => {
  const run = fake();
  const { get } = mount(run, KEYS);
  assert.equal((await get(`/duckdb/files?u=${encodeURIComponent("s3://my-bucket/d/o.parquet")}`)).status, 200);
  assert.ok(run.seen.length > 0);
  for (const sql of run.seen) {
    const at = sql.indexOf("CREATE TEMPORARY SECRET dovre_bucket (TYPE s3");
    assert.ok(at > sql.indexOf("LOAD httpfs;") && at < sql.indexOf("SET allowed_paths"), "after httpfs, before the lock");
    assert.ok(sql.startsWith("SET allow_persistent_secrets = false;"), "no saved secrets read");
    assert.match(sql, /\.mode json\nSET allowed_paths = \['s3:\/\/my-bucket\/d\/o\.parquet'/);
  }
  const n = run.seen.length;
  await get(`/duckdb/files?u=${encodeURIComponent("https://h/o.parquet")}`);
  assert.ok(run.seen.slice(n).every((s) => !s.includes("SECRET")), "https gets no secret");

  const failing = mount(fake({ fail: `IO Error: denied for AKIATESTKEY0001 with s3cr3t'value/xyz` }), KEYS);
  const body = await (await failing.get(`/duckdb/files?u=${encodeURIComponent("s3://my-bucket/o.parquet")}`)).text();
  assert.ok(!body.includes("AKIATESTKEY0001") && !body.includes("s3cr3t"), "the error is scrubbed");
  const exp = await (await failing.get(`/duckdb/files/export?u=${encodeURIComponent("s3://my-bucket/o.parquet")}`)).text();
  assert.ok(!exp.includes("AKIATESTKEY0001") && !exp.includes("s3cr3t"));
});

test("keys: Settings marks them secret; a query can't list secrets", () => {
  const settings = createDuckDbPack().manifest.settings!;
  for (const k of ["DUCKDB_S3_KEY_ID", "DUCKDB_S3_SECRET", "DUCKDB_GCS_KEY_ID", "DUCKDB_GCS_SECRET"]) assert.equal(settings.find((s) => s.key === k)?.secret, true, k);
  assert.equal(sqlOk("SELECT * FROM duckdb_secrets()"), undefined);
  assert.equal(sqlOk("FROM which_secret('s3://b/x', 's3')"), undefined);
  assert.equal(sqlOk("SELECT 1"), "SELECT 1");
});

// ── The real CLI against a local S3-style endpoint (skipped without duckdb or its httpfs) ──

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

test("real duckdb: a private bucket is read with signed requests, to that endpoint only, and the secret stays redacted", { skip: !httpfs && "duckdb or its httpfs extension not installed" }, async () => {
  const env = { ...process.env };
  delete env.AI_AGENT;
  const f = join(base, "t.parquet");
  execFileSync("duckdb", [":memory:", "-c", `COPY (SELECT range AS id FROM range(12)) TO ${lit(f)};`], { env, stdio: "ignore" });
  const bytes = readFileSync(f);
  const auth: string[] = [];
  const server = createServer((req, res) => {
    auth.push(String(req.headers.authorization ?? ""));
    if (!/Credential=AKIATESTKEY0001\//.test(String(req.headers.authorization))) return void res.writeHead(403).end();
    if (!req.url?.startsWith("/bkt/t.parquet")) return void res.writeHead(404).end();
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    const to = range && range[2] ? Number(range[2]) : bytes.length - 1;
    res.writeHead(range ? 206 : 200, { "content-length": to - from + 1, "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${from}-${to}/${bytes.length}` } : {}) });
    res.end(req.method === "HEAD" ? undefined : bytes.subarray(from, to + 1));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const keys = remoteKeys({ ...KEYS, DUCKDB_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const t = remoteSource("s3://bkt/t.parquet", "parquet");
    const data = createDuckDbData({ sources: [t], keys });
    const seen = await look(data, "url", open(t, "") as Extract<ReturnType<typeof open>, { type: "file" }>, { size: 5, page: 1 });
    assert.equal(seen.error, undefined);
    assert.equal(seen.facts?.rows, 12);
    assert.deepEqual(seen.page.rows.map((r) => Number(r.id)), [5, 6, 7, 8, 9]);
    assert.ok(auth.length > 0 && auth.every((a) => a.startsWith("AWS4-HMAC-SHA256 Credential=AKIATESTKEY0001/")), "every request signed");
    assert.ok(auth.every((a) => !a.includes("s3cr3t")), "the secret itself never travels");

    const listed = JSON.stringify((await data.scan("url", "SELECT * FROM duckdb_secrets()")).rows);
    assert.ok(listed.includes("secret=redacted") && !listed.includes("s3cr3t"), listed);
    await assert.rejects(data.scan("url", "SELECT * FROM duckdb_secrets(redact=false)"), /disabled/i);
    await assert.rejects(data.scan("url", "SELECT * FROM read_parquet('s3://bkt/other.parquet')"), /disabled|Permission/i);
  } finally {
    server.close();
  }
});
