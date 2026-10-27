/**
 * The DuckDB pack's file viewer (`/duckdb/files`): paths stay inside a folder source (no `..`, no
 * symlink out), the SQL it builds quotes what the file says, every run is shut in without the
 * directory's views, and a hostile file (names, values) renders inert. No real duckdb: a fake runner.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { html } from "hono/html";
import { testContext } from "dovre/packs/testing.ts";
import { createDuckDbPack } from "../index.ts";
import { createDuckDbData, type DuckDbRunner, parseSources } from "../data.ts";
import { cleanRel, columnsOf, columnMetaSql, exportName, fromSql, handoffSql, ident, lit, look, open, orderSql, previewSql, slice, sliceOf, toCsv, whereSql } from "../files.ts";
import { exportHref, fileCell, filesHref, sliceParams } from "../filesview.ts";

const H = `<script>alert(1)</script>`;
const IMG = `<img src=x onerror=alert(1)>`;
const JS_URL = "javascript:alert(1)";
// Windows refuses < > : in file names, so the hostile names are only made where they can exist.
const NAMES = process.platform !== "win32";

const base = mkdtempSync(join(tmpdir(), "duckdb-files-"));
const lake = join(base, "lake");
const outside = join(base, "outside");
mkdirSync(join(lake, "sub"), { recursive: true });
if (NAMES) mkdirSync(join(lake, JS_URL), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(lake, "t.parquet"), "PAR1");
writeFileSync(join(lake, "t2.parquet"), "PAR1");
writeFileSync(join(lake, "it's.csv"), "a\n1\n");
writeFileSync(join(lake, "notes.txt"), "x");
writeFileSync(join(lake, ".hidden.parquet"), "PAR1");
if (NAMES) writeFileSync(join(lake, `${IMG}.parquet`), "PAR1");
writeFileSync(join(lake, "sub", "e.jsonl"), "{}\n");
writeFileSync(join(outside, "secret.parquet"), "PAR1");
symlinkSync(join(outside, "secret.parquet"), join(lake, "link.parquet"));
symlinkSync(outside, join(lake, "out"));
after(() => rmSync(base, { recursive: true, force: true }));

const source = () => parseSources(`lake=${lake}`)[0]!;

test("files: cleanRel refuses absolute paths, .., backslashes and NUL", () => {
  assert.equal(cleanRel(""), "");
  assert.equal(cleanRel("sub/./e.jsonl"), "sub/e.jsonl");
  assert.equal(cleanRel("sub//e.jsonl"), "sub/e.jsonl");
  for (const bad of ["../x", "sub/../../x", "/etc/passwd", "a\\..\\b", "a\0b", "x".repeat(1025)]) {
    assert.equal(cleanRel(bad), undefined, bad);
  }
});

test("files: open stays inside the source, symlinks followed", () => {
  const t = source();
  assert.equal(t.isDir, true);
  const file = open(t, "t.parquet");
  assert.equal(file?.type, "file");
  assert.equal(file?.type === "file" && file.kind, "parquet");
  assert.equal(open(t, "sub/e.jsonl")?.type, "file");
  assert.equal(open(t, "it's.csv")?.type, "file");

  assert.equal(open(t, "../outside/secret.parquet"), undefined, "..");
  assert.equal(open(t, "link.parquet"), undefined, "a symlinked file out of the source");
  assert.equal(open(t, "out/secret.parquet"), undefined, "a symlinked folder out of the source");
  assert.equal(open(t, "out"), undefined);
  assert.equal(open(t, "missing.parquet"), undefined);
  assert.equal(open(t, "notes.txt"), undefined, "not a kind it reads");
  assert.equal(open({ ...t, isDir: false }, "t.parquet"), undefined, "a database source has no files");

  const dir = open(t, "");
  assert.equal(dir?.type, "dir");
  if (dir?.type !== "dir") return;
  const names = dir.entries.map((e) => e.name);
  assert.ok(names.includes("sub") && names.includes("t.parquet") && names.includes("it's.csv"));
  assert.ok(!names.includes("link.parquet") && !names.includes("out"), "symlinks out aren't listed");
  assert.ok(!names.includes(".hidden.parquet") && !names.includes("notes.txt"));
  assert.equal(dir.entries[0]!.isDir, true, "folders first");

  const all = open(t, "", true);
  assert.equal(all?.type, "file");
  if (all?.type !== "file") return;
  assert.equal(all.all, true);
  assert.deepEqual(all.files.map((f) => f.slice(lake.length + 1)).sort(), [...(NAMES ? [`${IMG}.parquet`] : []), "t.parquet", "t2.parquet"].sort());
  assert.equal(open(t, "sub", true), undefined, "no Parquet files there");
});

test("files: SQL quotes paths and column names", () => {
  assert.equal(lit("it's"), "'it''s'");
  assert.equal(ident(`a"b`), `"a""b"`);
  assert.equal(fromSql("csv", ["/d/it's.csv"]), "read_csv('/d/it''s.csv')");
  assert.equal(fromSql("parquet", ["/a.parquet", "/b.parquet"]), "read_parquet(['/a.parquet', '/b.parquet'], union_by_name = true)");
  assert.equal(fromSql("json", ["/e.jsonl"]), "read_json('/e.jsonl')");
  assert.equal(previewSql("read_parquet('/a')", [`x"; DROP TABLE y; --`], 51, 100), `SELECT "x""; DROP TABLE y; --" FROM read_parquet('/a') LIMIT 51 OFFSET 100;`);
  assert.match(columnMetaSql(["/a"]), /FROM parquet_metadata\('\/a'\) GROUP BY path_in_schema/);
  const many = Array.from({ length: 400 }, (_, i) => `/lake/part-${i}-${"x".repeat(40)}.parquet`);
  const sql = handoffSql({ kind: "parquet", files: many, abs: "/lake", all: true }, 20_000);
  assert.ok(sql.length <= 20_000);
  assert.ok(sql.includes(`read_parquet(${lit(join("/lake", "*.parquet"))}`), sql);
});

test("files: columnsOf reads top-level nullability from parquet's schema tree", () => {
  const described = [
    { column_name: "id", column_type: "BIGINT" },
    { column_name: "s", column_type: "STRUCT(a BIGINT, b BIGINT[])" },
    { column_name: "l", column_type: "BIGINT[]" },
    { column_name: "n", column_type: "VARCHAR" },
  ];
  const tree = [
    { name: "duckdb_schema", repetition_type: "REQUIRED", num_children: 4 },
    { name: "id", repetition_type: "REQUIRED", num_children: null },
    { name: "s", repetition_type: "OPTIONAL", num_children: 2 },
    { name: "a", repetition_type: "REQUIRED", num_children: null },
    { name: "b", repetition_type: "OPTIONAL", num_children: 1 },
    { name: "list", repetition_type: "REPEATED", num_children: 1 },
    { name: "element", repetition_type: "OPTIONAL", num_children: null },
    { name: "l", repetition_type: "REQUIRED", num_children: 1 },
    { name: "list", repetition_type: "REPEATED", num_children: 1 },
    { name: "element", repetition_type: "OPTIONAL", num_children: null },
    { name: "n", repetition_type: "OPTIONAL", num_children: null },
  ];
  assert.deepEqual(
    columnsOf(described, tree).map((c) => [c.name, c.nullable]),
    [["id", "no"], ["s", "yes"], ["l", "no"], ["n", "yes"]],
  );
  assert.deepEqual(columnsOf(described.slice(0, 1), []).map((c) => c.nullable), [undefined], "CSV: unknown");
});

/** A fake duckdb answering each kind of statement the viewer runs, keeping what it was sent. */
function fakeRunner(o: { cols?: string[]; fail?: RegExp } = {}): DuckDbRunner & { seen: string[]; argv: string[][] } {
  const cols = o.cols ?? [H, "x", "nest"];
  const seen: string[] = [];
  const argv: string[][] = [];
  const run = (async (args: string[], opts?: { input?: string }) => {
    const sql = opts?.input ?? "";
    seen.push(sql);
    argv.push(args);
    if (o.fail?.test(sql)) return { stdout: "", stderr: `Error: ${H} failed`, code: 1 };
    const out = (rows: unknown[]) => ({ stdout: JSON.stringify(rows), stderr: "", code: 0 });
    if (sql.includes("DESCRIBE SELECT")) return out(cols.map((c) => ({ column_name: c, column_type: c === "nest" ? "STRUCT(a VARCHAR)" : `VARCHAR ${H}` })));
    if (sql.includes("parquet_schema(")) return out([{ name: "schema", num_children: cols.length }, ...cols.map((c) => ({ name: c, repetition_type: "OPTIONAL", num_children: null }))]);
    if (sql.includes("parquet_file_metadata(")) return out([{ file_name: "f", num_rows: 3, num_row_groups: 1, created_by: H, format_version: 2 }]);
    if (sql.includes("parquet_metadata(")) return out([{ col: H, ty: "BYTE_ARRAY", codec: H, packed: "10", unpacked: "20", nulls: "0", lo: JS_URL, hi: H, distinct_count: null }]);
    if (sql.includes("SUMMARIZE")) return out([{ column_name: H, column_type: "VARCHAR", min: JS_URL, max: H, approx_unique: 2, null_percentage: "0.00", count: 3 }]);
    if (/SELECT .* FROM read_/.test(sql)) {
      return out([
        { [H]: H, x: JS_URL, nest: { a: `${H}${"y".repeat(100)}` } },
        { [H]: IMG, x: null, nest: null },
      ]);
    }
    return out([]);
  }) as DuckDbRunner & { seen: string[]; argv: string[][] };
  run.seen = seen;
  run.argv = argv;
  return run;
}

function mount(run: DuckDbRunner, sources = `lake=${lake}`) {
  const ctx = testContext({
    env: { DUCKDB_SOURCES: sources },
    page: async (c, o) => c.html(String(await o.body)),
  });
  const app = new Hono();
  createDuckDbPack({ run }).routes!(app as any, ctx);
  return (path: string) => app.request(`http://localhost${path}`);
}

const inert = (body: string) => {
  assert.ok(!body.includes("<script>alert(1)"), "no live script tag");
  assert.ok(!body.includes("<img src=x"), "no live img tag");
  assert.ok(!/href="javascript:/i.test(body), "no javascript: link");
  assert.ok(!/<[^>]+\sonerror=/i.test(body), "no live event handler");
};

test("files: a hostile file renders inert, every run shut in without the directory's views", async () => {
  const run = fakeRunner();
  const get = mount(run);
  const r = await get(`/duckdb/files?t=lake&f=t.parquet&stats=1&c=${encodeURIComponent(H)}&c=nest&c=x`);
  assert.equal(r.status, 200);
  const body = await r.text();
  inert(body);
  assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the hostile column name, escaped");
  assert.ok(body.includes(`<details class="nest">`), "a nested value opens");
  assert.ok(body.includes("Computed stats"));
  assert.ok(body.includes("Open in DuckDB") && body.includes('action="/duckdb/q"'));

  assert.ok(run.seen.length >= 5);
  for (const sql of run.seen) {
    assert.ok(sql.includes(`SET allowed_directories = [${lit(join(lake, "/"))}];`), sql);
    assert.match(sql, /SET enable_external_access = false;/);
    assert.match(sql, /SET lock_configuration = true;/);
    assert.ok(!sql.includes("CREATE OR REPLACE TEMPORARY VIEW"), "no directory views");
  }
  for (const a of run.argv) assert.deepEqual(a, ["-json", ":memory:"]);
  const preview = run.seen.find((s) => s.includes("OFFSET"))!;
  assert.ok(preview.includes(`"${H}", "nest", "x"`), "picked columns, quoted");
});

test("files: picked columns are only the file's own; paging and sizes are bounded", async () => {
  const run = fakeRunner();
  const get = mount(run);
  const r = await get(`/duckdb/files?t=lake&f=t.parquet&c=${encodeURIComponent(`x" FROM read_text('/etc/passwd') --`)}&n=100000&p=-3`);
  assert.equal(r.status, 200);
  const preview = run.seen.find((s) => s.includes("OFFSET"))!;
  assert.ok(!preview.includes("/etc/passwd"), "an unknown column never reaches SQL");
  assert.match(preview, /LIMIT 51 OFFSET 0;/, "default size, page 0");
  assert.ok(!run.seen.some((s) => s.includes("SUMMARIZE")), "stats only when asked");
});

test("files: folders, CSV and refusals", async () => {
  const run = fakeRunner();
  const get = mount(run);

  const home = await get("/duckdb/files");
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes(`href="/duckdb/files?t=lake"`));

  const root = await get("/duckdb/files?t=lake");
  assert.equal(root.status, 200);
  const listing = await root.text();
  inert(listing);
  assert.ok(listing.includes(`Open the ${NAMES ? 3 : 2} Parquet files here as one`));
  if (NAMES) {
    assert.ok(listing.includes(`href="/duckdb/files?t=lake&amp;f=javascript%3Aalert%281%29"`), "a hostile folder name is a path on this app");
    assert.ok(listing.includes("&lt;img src=x onerror=alert(1)&gt;.parquet"));
  }
  assert.ok(!listing.includes("link.parquet"));

  const csv = await get(`/duckdb/files?t=lake&f=${encodeURIComponent("it's.csv")}`);
  assert.equal(csv.status, 200);
  assert.ok(run.seen.some((s) => s.includes("read_csv('") && s.includes("it''s.csv')")));
  assert.ok(!run.seen.some((s) => s.includes("parquet_metadata(") && s.includes("it''s.csv")), "no parquet metadata for a CSV");

  for (const bad of ["../outside/secret.parquet", "link.parquet", "out/secret.parquet", "notes.txt", "/etc/passwd"]) {
    const n = run.seen.length;
    const r = await get(`/duckdb/files?t=lake&f=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 404, bad);
    assert.equal(run.seen.length, n, `duckdb never runs for ${bad}`);
    inert(await r.text());
  }
  const unknown = await get(`/duckdb/files?t=${encodeURIComponent(H)}`);
  assert.equal(unknown.status, 404);
  inert(await unknown.text());
});

test("files: DuckDB's error is shown escaped, the page still draws", async () => {
  const get = mount(fakeRunner({ fail: /DESCRIBE/ }));
  const r = await get("/duckdb/files?t=lake&f=t.parquet");
  assert.equal(r.status, 200);
  const body = await r.text();
  inert(body);
  assert.ok(body.includes("DuckDB said:"));
});

test("files: cells and links", () => {
  assert.equal(String(fileCell({ a: 1 })), `{"a":1}`);
  assert.ok(String(fileCell({ a: H.repeat(10) })).includes("&lt;script&gt;"));
  assert.ok(!String(html`${fileCell(H)}`).includes("<script>"));
  assert.equal(filesHref({ t: "lake", f: "a b/c.parquet", cols: ["x", "y"], size: 25, page: 2 }), "/duckdb/files?t=lake&f=a+b%2Fc.parquet&c=x&c=y&n=25&p=2");
  assert.ok(filesHref({ t: JS_URL }).startsWith("/duckdb/files?"));
});

test("files: a filter's value only reaches SQL as a literal, on the file's own columns", () => {
  const evil = `x'); COPY (SELECT 1) TO '/tmp/pwn' --`;
  assert.equal(whereSql({ col: `a"b`, op: "eq", val: evil }), ` WHERE "a""b" = 'x''); COPY (SELECT 1) TO ''/tmp/pwn'' --'`);
  assert.equal(whereSql({ col: "n", op: "ge", val: "3" }), ` WHERE "n" >= '3'`);
  assert.equal(whereSql({ col: "n", op: "null", val: evil }), ` WHERE "n" IS NULL`);
  assert.equal(whereSql({ col: "s", op: "contains", val: "50%_" }), ` WHERE contains(lower(CAST("s" AS VARCHAR)), lower('50%_'))`);
  assert.equal(orderSql({ col: `x"`, desc: true }), ` ORDER BY "x""" DESC NULLS LAST`);
  const known = new Set(["a", "n"]);
  assert.deepEqual(sliceOf(known, { filter: { col: "zz", op: "eq", val: "1" }, sort: { col: "zz", desc: false } }), { filter: undefined, sort: undefined });
  assert.equal(sliceOf(known, { filter: { col: "a", op: "eq", val: "" } }).filter, undefined, "a comparison needs a value");
  assert.equal(sliceOf(known, { filter: { col: "a", op: "drop" as any, val: "1" } }).filter, undefined);
  assert.deepEqual(sliceOf(known, { filter: { col: "a", op: "notnull", val: "" } }).filter, { col: "a", op: "notnull", val: "" });
  const p = new URLSearchParams("fc=a&fo=lt&fv=5&s=n&sd=1");
  assert.deepEqual(sliceParams((k) => p.get(k) ?? undefined), { filter: { col: "a", op: "lt", val: "5" }, sort: { col: "n", desc: true } });
  assert.deepEqual(sliceParams(() => undefined), { filter: undefined, sort: undefined });
  assert.equal(
    exportHref({ t: "lake", f: "t.parquet", cols: ["a"], page: 3, filter: { col: "a", op: "null", val: "x" }, sort: { col: "a", desc: false } }, "csv"),
    "/duckdb/files/export?t=lake&f=t.parquet&c=a&fc=a&fo=null&s=a&as=csv",
  );
});

test("files: CSV defuses formulas and quotes what needs it; export names are safe", () => {
  const csv = toCsv(["a", `b,"c"`], [{ a: "=HYPERLINK(1)", [`b,"c"`]: "line\nbreak" }, { a: -5, [`b,"c"`]: { n: [1] } }, { a: null, [`b,"c"`]: "@x" }]);
  assert.equal(csv, `a,"b,""c"""\r\n'=HYPERLINK(1),"line\nbreak"\r\n-5,"{""n"":[1]}"\r\n,'@x\r\n`);
  assert.equal(exportName("sub/my data.parquet", false, "csv"), "my_data-slice.csv");
  assert.equal(exportName(`${IMG}.parquet`, false, "json"), "_img_src_x_onerror_alert_1_-slice.json");
  assert.equal(exportName("", true, "csv"), "dataset-all-slice.csv");
});

test("files: filter and sort reach the preview; unknown columns never do", async () => {
  const run = fakeRunner({ cols: ["a", "n", H] });
  const get = mount(run);
  const r = await get(`/duckdb/files?t=lake&f=t.parquet&fc=n&fo=gt&fv=${encodeURIComponent("3' OR 1=1 --")}&s=a&sd=1`);
  assert.equal(r.status, 200);
  const body = await r.text();
  inert(body);
  const preview = run.seen.find((s) => s.includes("OFFSET"))!;
  assert.ok(preview.includes(`WHERE "n" > '3'' OR 1=1 --' ORDER BY "a" DESC NULLS LAST LIMIT 51 OFFSET 0;`), preview);
  assert.ok(run.seen.some((s) => s.includes("SELECT count(*) AS n FROM")), "counts what matches");
  assert.ok(body.includes("fc=n&amp;fo=gt"), "paging and export keep the filter");
  assert.ok(body.includes(`href="/duckdb/files/export?t=lake&amp;f=t.parquet&amp;fc=n`));
  assert.ok(body.includes(`<option value="n" selected>`));

  const run2 = fakeRunner({ cols: ["a"] });
  await mount(run2)(`/duckdb/files?t=lake&f=t.parquet&fc=${encodeURIComponent(`a" OR 1=1 --`)}&fo=eq&fv=1&s=${encodeURIComponent("/etc/passwd")}`);
  const p2 = run2.seen.find((s) => s.includes("OFFSET"))!;
  assert.ok(!p2.includes("WHERE") && !p2.includes("ORDER BY") && !p2.includes("passwd"), "a filter or sort on an unknown column is dropped");
});

test("files: export downloads the slice, inside the source only", async () => {
  const run = fakeRunner();
  const get = mount(run);
  const r = await get(`/duckdb/files/export?t=lake&f=t.parquet&c=x&c=${encodeURIComponent(H)}&fc=x&fo=notnull&as=csv`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(r.headers.get("content-disposition"), `attachment; filename="t-slice.csv"`);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const text = await r.text();
  assert.ok(text.startsWith(`x,${H}\r\njavascript:alert(1),${H}\r\n`), text);
  const sql = run.seen.find((s) => s.includes("LIMIT 10001"))!;
  assert.ok(sql.includes(`SELECT "x", "${H}" FROM read_parquet(`) && sql.includes(`WHERE "x" IS NOT NULL`));
  for (const s of run.seen) assert.match(s, /SET enable_external_access = false;/);

  const j = await get(`/duckdb/files/export?t=lake&f=t.parquet&c=x&as=json`);
  assert.equal(j.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(await j.text()), [{ x: JS_URL }, { x: null }]);

  for (const bad of ["../outside/secret.parquet", "link.parquet", "", "sub"]) {
    const n = run.seen.length;
    const b = await get(`/duckdb/files/export?t=lake&f=${encodeURIComponent(bad)}`);
    assert.equal(b.status, 404, bad);
    assert.equal(run.seen.length, n, `duckdb never runs for ${bad}`);
  }
  assert.equal((await get(`/duckdb/files/export?t=nope&f=t.parquet`)).status, 404);
  const failing = await mount(fakeRunner({ fail: /DESCRIBE/ }))(`/duckdb/files/export?t=lake&f=t.parquet`);
  assert.equal(failing.status, 502);
});

test("files: a single file listed as a source opens on its own, shut in to that file", async () => {
  const one = NAMES ? join(lake, `${IMG}.parquet`) : join(lake, "t.parquet");
  const linked = join(lake, "link.parquet");
  const [t, l, db] = parseSources(`one=${one},linked=${linked},db=${join(lake, "x.duckdb")}`);
  assert.equal(t!.file, "parquet");
  assert.equal(t!.isDir, false);
  assert.equal(l!.file, "parquet");
  assert.equal(db!.file, undefined, "a database file stays one");
  assert.equal(parseSources(`d=${lake}`)[0]!.file, undefined, "a folder is never a file source");

  // Only the file itself: no path under it, no folder mode.
  assert.equal(open(t!, "")?.type, "file");
  assert.equal(open(t!, "t2.parquet"), undefined);
  assert.equal(open(t!, "../t2.parquet"), undefined);
  assert.equal(open(t!, "", true), undefined);

  const run = fakeRunner();
  const get = mount(run, `one=${one},linked=${linked}`);
  const r = await get("/duckdb/files?t=one&stats=1");
  assert.equal(r.status, 200);
  const body = await r.text();
  inert(body);
  assert.ok(body.includes("Open in DuckDB"));
  assert.ok(run.seen.length >= 5);
  for (const sql of run.seen) {
    assert.ok(sql.includes(`SET allowed_paths = [${lit(realpathSync(one))}];`), sql);
    assert.ok(!sql.includes("allowed_directories"), sql);
    assert.match(sql, /SET lock_configuration = true;/);
  }
  for (const a of run.argv) assert.deepEqual(a, ["-json", ":memory:"]);

  // A symlinked file source names the real file, which is what DuckDB is allowed to open.
  const run2 = fakeRunner();
  const r2 = await mount(run2, `linked=${linked}`)("/duckdb/files?t=linked");
  assert.equal(r2.status, 200);
  for (const sql of run2.seen) assert.ok(sql.includes(`SET allowed_paths = [${lit(realpathSync(join(outside, "secret.parquet")))}];`), sql);

  for (const q of ["t=one&f=t2.parquet", "t=one&all=1", "t=one&f=..%2Fsecret.parquet"]) {
    const before = run.seen.length;
    assert.equal((await get(`/duckdb/files?${q}`)).status, 404, q);
    assert.equal(run.seen.length, before, `${q}: duckdb never ran`);
  }
  const home = await (await get("/duckdb/files")).text();
  inert(home);
  assert.ok(home.includes("parquet ·"), "listed as a file source");

  // Queries on it see one view named after the file, and nothing else.
  const run3 = fakeRunner();
  const data = createDuckDbData({ sources: [parseSources(`o=${join(lake, "it's.csv")}`)[0]!], run: run3 });
  await data.query("o", "SELECT 1");
  assert.ok(run3.seen[0]!.includes(`CREATE OR REPLACE TEMPORARY VIEW "it_s" AS SELECT * FROM read_csv(${lit(realpathSync(join(lake, "it's.csv")))});`), run3.seen[0]);
});

// ── Against the real duckdb CLI (skipped where it isn't installed) ──

const hasDuckDb = (() => {
  try {
    execFileSync("duckdb", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("real duckdb: the viewer reads a Parquet file's schema, metadata, rows and stats, and nothing outside", { skip: !hasDuckDb && "duckdb not installed" }, async () => {
  const dir = join(base, "real");
  mkdirSync(dir);
  const f = join(dir, "t.parquet");
  const env = { ...process.env };
  delete env.AI_AGENT;
  execFileSync("duckdb", [":memory:", "-c", `COPY (SELECT range AS id, CASE WHEN range % 2 = 0 THEN NULL ELSE 'n' || range END AS name, {'a': range, 'b': [range]} AS s FROM range(30)) TO ${lit(f)};`], { env, stdio: "ignore" });
  symlinkSync(join(outside, "secret.parquet"), join(dir, "link.parquet"));
  const t = parseSources(`real=${dir}`)[0]!;
  const data = createDuckDbData({ sources: [t] });
  const opened = open(t, "t.parquet");
  assert.equal(opened?.type, "file");
  if (opened?.type !== "file") return;
  const seen = await look(data, "real", opened, { size: 10, page: 1, stats: true, cols: ["id", "s"] });
  assert.equal(seen.error, undefined);
  assert.deepEqual(seen.columns.map((c) => c.name), ["id", "name", "s"]);
  assert.match(seen.columns[2]!.type, /^STRUCT/);
  assert.equal(seen.facts?.rows, 30);
  assert.equal(seen.leaves?.find((l) => l.col === "name")?.nulls, 15);
  assert.equal(seen.leaves?.find((l) => l.col === "id")?.hi, "29");
  assert.deepEqual(seen.page.rows.map((r) => Number(r.id)), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(seen.page.more, true);
  assert.deepEqual(seen.page.columns, ["id", "s"]);
  assert.equal(seen.stats?.length, 2);
  // Filter, sort, the count of what matches, and the export of that slice.
  const filtered = await look(data, "real", opened, { size: 5, page: 0, cols: ["id", "name"], filter: { col: "name", op: "contains", val: "N2" }, sort: { col: "id", desc: true } });
  assert.equal(filtered.error, undefined);
  assert.deepEqual(filtered.page.rows.map((r) => Number(r.id)), [29, 27, 25, 23, 21]);
  assert.equal(filtered.matching, 5, "n21, n23, n25, n27, n29 (even ids have no name)");
  const gt = await look(data, "real", opened, { size: 50, page: 0, cols: ["id"], filter: { col: "id", op: "ge", val: "27" } });
  assert.deepEqual(gt.page.rows.map((r) => Number(r.id)), [27, 28, 29]);
  const nulls = await look(data, "real", opened, { size: 50, page: 0, cols: ["id"], filter: { col: "name", op: "null", val: "" } });
  assert.equal(nulls.matching, 15);
  const out = await slice(data, "real", opened, { cols: ["id", "s"], filter: { col: "id", op: "lt", val: "2" } });
  assert.equal(out.capped, false);
  assert.equal(toCsv(out.columns, out.rows), `id,s\r\n0,"{""a"":0,""b"":[0]}"\r\n1,"{""a"":1,""b"":[1]}"\r\n`);
  // Even if a symlink out got past the viewer's own check, DuckDB is shut in to the source.
  await assert.rejects(data.scan("real", `SELECT * FROM read_parquet(${lit(join(outside, "secret.parquet"))})`), /disabled|Permission/i);
});

test("real duckdb: a file source is one view, and its siblings stay out of reach", { skip: !hasDuckDb && "duckdb not installed" }, async () => {
  const dir = join(base, "real-one");
  mkdirSync(dir);
  const f = join(dir, "orders.parquet");
  const sib = join(dir, "sibling.csv");
  const env = { ...process.env };
  delete env.AI_AGENT;
  execFileSync("duckdb", [":memory:", "-c", `COPY (SELECT range AS id FROM range(7)) TO ${lit(f)}; COPY (SELECT 1 AS a) TO ${lit(sib)};`], { env, stdio: "ignore" });
  const t = parseSources(`orders=${f}`)[0]!;
  const data = createDuckDbData({ sources: [t] });
  const n = await data.query("orders", "SELECT count(*) AS n FROM orders;");
  assert.equal(Number(n.rows[0]!.n), 7);
  assert.deepEqual((await data.tables("orders")).map((x) => x.table), ["orders"]);
  const opened = open(t, "");
  assert.equal(opened?.type, "file");
  if (opened?.type !== "file") return;
  const seen = await look(data, "orders", opened, { size: 25, page: 0 });
  assert.equal(seen.error, undefined);
  assert.equal(seen.facts?.rows, 7);
  await assert.rejects(data.query("orders", `SELECT * FROM read_text(${lit(sib)})`), /disabled|Permission/i);
  await assert.rejects(data.scan("orders", `SELECT * FROM read_csv(${lit(sib)})`), /disabled|Permission/i);
});
