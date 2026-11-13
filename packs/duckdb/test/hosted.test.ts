import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { activePacks, assertFragment, assertInert, assertScoped, assertStyled, HOSTILE, packApp, testContext } from "dovre/pack-testing.ts";
import { createDuckDbPack, duckJs } from "../index.ts";
import { HOSTED_MAX_UPLOAD, HOSTED_SCRIPT, hostedPage, listFiles, MAX_FILES, type R2Like, type R2Range, rangeOf, viewSql } from "../hosted.ts";
import { COI_WASM_SHA256, DUCK_JS_SHA256, DUCK_WASM_SHA256 } from "../duck.ts";

/** R2 in memory: what the pack calls, ranges as R2 reads them. */
function fakeR2(seed: Record<string, string | Uint8Array> = {}) {
  const objs = new Map<string, { bytes: Uint8Array; at: number }>();
  let t = Date.UTC(2026, 10, 13, 9);
  const enc = (v: string | Uint8Array) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  for (const [k, v] of Object.entries(seed)) objs.set(k, { bytes: enc(v), at: (t += 60_000) });
  const meta = (key: string) => {
    const o = objs.get(key)!;
    return { key, size: o.bytes.byteLength, uploaded: new Date(o.at), httpEtag: `"${key.length}-${o.bytes.byteLength}"` };
  };
  const ranged: R2Range[] = [];
  const bucket: R2Like = {
    async list() {
      return { objects: [...objs.keys()].sort().map(meta), truncated: false };
    },
    async head(key) {
      return objs.has(key) ? meta(key) : null;
    },
    async get(key, o) {
      const x = objs.get(key);
      if (!x) return null;
      let bytes = x.bytes;
      if (o?.range) {
        ranged.push(o.range);
        const r = o.range;
        bytes = "suffix" in r ? bytes.slice(bytes.byteLength - r.suffix) : bytes.slice(r.offset, r.length === undefined ? undefined : r.offset + r.length);
      }
      return { ...meta(key), body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() };
    },
    async put(key, body) {
      objs.set(key, { bytes: body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer), at: (t += 60_000) });
      return {};
    },
    async delete(key) {
      objs.delete(key);
    },
  };
  return { bucket, objs, ranged };
}

/** The pack hosted, its routes on a bare app; `ctx.page` renders just the body. */
function hostedApp(bucket?: R2Like, env: Record<string, string> = {}) {
  const pack = createDuckDbPack();
  const app = new Hono();
  const logs: string[] = [];
  const ctx = testContext({
    hosted: true,
    env,
    bindings: bucket ? { DUCKDB_FILES: bucket } : {},
    log: (l: string) => void logs.push(l),
    wasm: (n: string) => `/assets/wasm/duckdb.${n}.x.wasm`,
    page: async (c, o) => c.html(String(await o.body)),
  });
  pack.routes!(app as never, ctx);
  const req = (path: string, init: RequestInit = {}) => app.request(`http://localhost${path}`, init);
  return { pack, app, ctx, req, logs };
}

test("rangeOf: one byte range, a suffix, an open end; past the end is unsatisfiable, anything else reads whole", () => {
  assert.equal(rangeOf(undefined, 100), "whole");
  assert.deepEqual(rangeOf("bytes=0-9", 100), { r2: { offset: 0, length: 10 }, start: 0, end: 9 });
  assert.deepEqual(rangeOf("bytes=90-", 100), { r2: { offset: 90, length: 10 }, start: 90, end: 99 });
  assert.deepEqual(rangeOf("bytes=95-500", 100), { r2: { offset: 95, length: 5 }, start: 95, end: 99 }, "an end past the file is clamped");
  assert.deepEqual(rangeOf("bytes=-8", 100), { r2: { suffix: 8 }, start: 92, end: 99 }, "Parquet's footer");
  assert.deepEqual(rangeOf("bytes=-800", 100), { r2: { suffix: 100 }, start: 0, end: 99 });
  assert.equal(rangeOf("bytes=100-", 100), "unsatisfiable");
  assert.equal(rangeOf("bytes=-0", 100), "unsatisfiable");
  assert.equal(rangeOf("bytes=9-3", 100), "unsatisfiable");
  for (const h of ["bytes=0-1,5-6", "items=0-1", "bytes=-", "bytes=a-b"]) assert.equal(rangeOf(h, 100), "whole", h);
});

test("listFiles: data files only, under clean names, newest first; each view named once", async () => {
  const { bucket } = fakeR2({ "orders.parquet": "a", "orders.csv": "b", "notes.txt": "c", "dir/x.parquet": "d", ".hidden.csv": "e", [`${HOSTILE}.csv`]: "f", "Sales-2026.jsonl": "g" });
  const { files, more } = await listFiles(bucket);
  assert.equal(more, false);
  assert.deepEqual(files.map((f) => [f.name, f.kind, f.view]), [
    ["Sales-2026.jsonl", "json", "sales_2026"],
    ["orders.csv", "csv", "orders"],
    ["orders.parquet", "parquet", "orders_2"],
  ]);
  assert.equal(viewSql(files[2]!), `CREATE OR REPLACE VIEW "orders_2" AS SELECT * FROM read_parquet('/duckdb/r2/orders.parquet')`);
  const many = fakeR2(Object.fromEntries(Array.from({ length: MAX_FILES + 3 }, (_v, i) => [`f${i}.csv`, "x"])));
  const capped = await listFiles(many.bucket);
  assert.deepEqual([capped.files.length, capped.more], [MAX_FILES, true]);
});

test("hosted: on with the R2 binding (no DuckDB on PATH, no sources set), off without it; locally sources are optional now", () => {
  const pack = createDuckDbPack();
  assert.deepEqual(activePacks([pack], { env: {}, bindings: { DUCKDB_FILES: {} }, hosted: true }).on.length, 1);
  const off = activePacks([pack], { env: {}, bindings: {}, hosted: true }).off;
  assert.match(off[0]?.why ?? "", /missing binding DUCKDB_FILES/);
  assert.equal(activePacks([pack], { env: {}, hosted: false, which: () => "/bin/duckdb" }).on.length, 1);
});

test("the hosted page: the files with their views, the query box off until its script runs, both DuckDB builds", async () => {
  const { bucket } = fakeR2({ "orders.parquet": "PAR1", "events.jsonl": "{}" });
  const { req } = hostedApp(bucket, { DUCKDB_SOURCES: "s=/data/local.duckdb" });
  const res = await req("/duckdb?f=orders.parquet");
  assert.equal(res.status, 200);
  const page = await res.text();
  assertFragment("hosted page", page);
  assert.match(page, /data-wasm="\/assets\/wasm\/duckdb\.duckdb\.x\.wasm" data-wasm-coi="\/assets\/wasm\/duckdb\.duckdb-coi\.x\.wasm"/);
  assert.match(page, /<button type="button" class="primary" data-dd-run disabled>Run<\/button>/);
  assert.match(page, /aria-label="SQL">SELECT \* FROM &quot;orders&quot; LIMIT 100<\/textarea>/, "the file asked for, picked");
  assert.match(page, /data-view="events" data-sql="CREATE OR REPLACE VIEW &quot;events&quot; AS SELECT \* FROM read_json\(&#39;\/duckdb\/r2\/events\.jsonl&#39;\)"/);
  assert.match(page, /read only where Dovre runs on your machine/, "DUCKDB_SOURCES is set: says it's local");
  assert.doesNotMatch(page, /data\/local\.duckdb/, "and doesn't show it");
});

test("the hosted page with hostile input: a hostile key is never listed, a hostile ?f is never echoed", async () => {
  const { bucket } = fakeR2({ [`${HOSTILE}.parquet`]: "x", "ok.csv": "y" });
  const { req } = hostedApp(bucket);
  const page = await (await req(`/duckdb?f=${encodeURIComponent(HOSTILE)}`)).text();
  assertInert("hosted page", page);
  assertFragment("hosted page", page);
  assert.doesNotMatch(page, /onerror/);
  assert.match(page, /SELECT \* FROM &quot;ok&quot; LIMIT 100/);
});

test("the hosted page without the binding, or with R2 failing, says so", async () => {
  assert.match(await (await hostedApp().req("/duckdb")).text(), /no R2 bucket bound as DUCKDB_FILES/);
  const { bucket } = fakeR2();
  const broken = hostedApp({ ...bucket, list: async () => Promise.reject(new Error("R2 down")) });
  assert.match(await (await broken.req("/duckdb")).text(), /couldn&#39;t be listed/);
  assert.deepEqual(broken.logs, ["R2 list failed: R2 down"]);
  assert.match(await (await hostedApp(bucket).req("/duckdb")).text(), /No files yet/);
});

test("a file's bytes for DuckDB: HEAD for its size, ranges as 206, past the end 416; bad names and other sites get nothing", async () => {
  const { bucket, ranged } = fakeR2({ "orders.parquet": "0123456789", [`x${HOSTILE}.csv`]: "no" });
  const { req } = hostedApp(bucket);
  const head = await req("/duckdb/r2/orders.parquet", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("content-type"), "application/octet-stream");
  assert.equal(await head.text(), "");
  const whole = await req("/duckdb/r2/orders.parquet");
  assert.deepEqual([whole.status, await whole.text()], [200, "0123456789"]);
  const part = await req("/duckdb/r2/orders.parquet", { headers: { range: "bytes=2-4" } });
  assert.deepEqual([part.status, part.headers.get("content-range"), part.headers.get("content-length"), await part.text()], [206, "bytes 2-4/10", "3", "234"]);
  const tail = await req("/duckdb/r2/orders.parquet", { headers: { range: "bytes=-3" } });
  assert.deepEqual([tail.status, tail.headers.get("content-range"), await tail.text()], [206, "bytes 7-9/10", "789"]);
  assert.deepEqual(ranged, [{ offset: 2, length: 3 }, { suffix: 3 }], "only the bytes asked for are read from R2");
  const past = await req("/duckdb/r2/orders.parquet", { headers: { range: "bytes=10-" } });
  assert.deepEqual([past.status, past.headers.get("content-range")], [416, "bytes */10"]);
  assert.equal((await req("/duckdb/r2/missing.parquet")).status, 404);
  assert.equal((await req(`/duckdb/r2/${encodeURIComponent(`x${HOSTILE}.csv`)}`)).status, 404, "a key that isn't a clean name is never served");
  assert.equal((await req("/duckdb/r2/..%2Forders.parquet")).status, 404);
  assert.equal((await req("/duckdb/r2/orders.parquet", { headers: { "sec-fetch-site": "cross-site" } })).status, 404, "another site can't read it");
  assert.equal((await hostedApp().req("/duckdb/r2/orders.parquet")).status, 404, "no binding");
});

test("adding a file puts it in R2 under a clean name and picks it; other kinds, empty and cross-site posts are refused", async () => {
  const { bucket, objs } = fakeR2();
  const { req } = hostedApp(bucket);
  const send = (name: string, body: string, origin = "http://localhost") => {
    const f = new FormData();
    f.set("file", new File([body], name));
    return req("/duckdb/upload", { method: "POST", body: f, headers: { origin } });
  };
  const ok = await send("my orders (1).parquet", "PAR1");
  assert.deepEqual([ok.status, ok.headers.get("location")], [303, "/duckdb?f=my_orders_1_.parquet"]);
  assert.equal(new TextDecoder().decode(objs.get("my_orders_1_.parquet")!.bytes), "PAR1");
  const txt = await send("notes.txt", "x");
  assert.equal(txt.status, 400);
  assert.match(await txt.text(), /Only Parquet, CSV\/TSV and JSON lines/);
  assert.equal((await send("e.csv", "")).status, 400);
  assert.equal((await send("e.csv", "x", "https://evil.example")).status, 403);
  assert.deepEqual([...objs.keys()], ["my_orders_1_.parquet"]);
  assert.ok(HOSTED_MAX_UPLOAD < 100 * 1024 * 1024, "under a Worker's request body limit");
});

test("removing a file deletes it from R2; a name that isn't clean, or a post from another site, removes nothing", async () => {
  const { bucket, objs } = fakeR2({ "a.csv": "1", "b.csv": "2" });
  const { req } = hostedApp(bucket);
  const del = (name: string, origin = "http://localhost") => req("/duckdb/delete", { method: "POST", body: new URLSearchParams({ name }), headers: { origin, "content-type": "application/x-www-form-urlencoded" } });
  assert.deepEqual([(await del("a.csv")).status], [303]);
  assert.equal((await del("../b.csv")).status, 400);
  assert.equal((await del("b.csv", "https://evil.example")).status, 403);
  assert.deepEqual([...objs.keys()], ["b.csv"]);
});

test("hosted, the native parts are off: refresh reads nothing, no lookups, only the one page", async () => {
  const pack = createDuckDbPack({ run: async () => assert.fail("the native DuckDB ran hosted") });
  const ctx = testContext({ hosted: true, bindings: { DUCKDB_FILES: fakeR2().bucket } });
  await pack.refresh!(ctx);
  assert.equal(pack.kept(), undefined);
  assert.deepEqual(pack.lookups!(ctx), []);
  assert.deepEqual(pack.pages!(ctx).map((p) => p.href), ["/duckdb"]);
  assert.match(pack.bino!(ctx), /hosted/);
  assert.deepEqual(pack.pages!(testContext()).map((p) => p.href), ["/duckdb", "/duckdb/files"], "locally both, as before");
});

test("its script draws with textContent only, its styles are its own, and every class it uses is styled", () => {
  assert.doesNotMatch(HOSTED_SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const pack = createDuckDbPack();
  assertScoped(pack);
  assertStyled("hosted page", hostedPage({ files: [{ name: "a.csv", kind: "csv", size: 1, at: 0, view: "a" }], more: false, sourcesSet: true, error: "x" }).toString(), pack.styles);
});

test("DuckDB's files: duckdb.js is the bundle duck.build.sh hashed; core serves it and both modules; the pages are isolated", async () => {
  assert.equal(createHash("sha256").update(duckJs()).digest("hex").slice(0, 16), DUCK_JS_SHA256, "run duck.build.sh");
  const pack = createDuckDbPack();
  assert.equal(pack.isolated, true);
  assert.deepEqual(Object.keys(pack.wasm ?? {}), ["duckdb", "duckdb-coi"]);
  assert.equal((pack.wasm!.duckdb as { sha256: string }).sha256, DUCK_WASM_SHA256);
  assert.equal((pack.wasm!["duckdb-coi"] as { sha256: string }).sha256, COI_WASM_SHA256);
  const { get } = packApp([pack], { env: { DUCKDB_SOURCES: ":memory:" } });
  const js = await get(`/assets/files/duckdb.duckdb.${DUCK_JS_SHA256}.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /^\/\* @duckdb\/duckdb-wasm .*\(MIT\)/);
});
