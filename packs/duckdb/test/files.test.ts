/**
 * The DuckDB pack's file viewer (`/duckdb/files`): paths stay inside a folder source (no `..`, no
 * symlink out), the SQL it builds quotes what the file says, every run is shut in without the
 * directory's views, and a hostile file (names, values) renders inert. No real duckdb: a fake runner.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { html } from "hono/html";
import { testContext } from "dovre/packs/testing.ts";
import { createDuckDbPack } from "../index.ts";
import { createDuckDbData, type DuckDbRunner, parseSources } from "../data.ts";
import { cleanRel, columnsOf, columnMetaSql, fromSql, handoffSql, ident, lit, look, open, previewSql } from "../files.ts";
import { fileCell, filesHref } from "../filesview.ts";

const H = `<script>alert(1)</script>`;
const IMG = `<img src=x onerror=alert(1)>`;
const JS_URL = "javascript:alert(1)";

const base = mkdtempSync(join(tmpdir(), "duckdb-files-"));
const lake = join(base, "lake");
const outside = join(base, "outside");
mkdirSync(join(lake, "sub"), { recursive: true });
mkdirSync(join(lake, JS_URL), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(lake, "t.parquet"), "PAR1");
writeFileSync(join(lake, "t2.parquet"), "PAR1");
writeFileSync(join(lake, "it's.csv"), "a\n1\n");
writeFileSync(join(lake, "notes.txt"), "x");
writeFileSync(join(lake, ".hidden.parquet"), "PAR1");
writeFileSync(join(lake, `${IMG}.parquet`), "PAR1");
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
  assert.deepEqual(all.files.map((f) => f.slice(lake.length + 1)).sort(), [`${IMG}.parquet`, "t.parquet", "t2.parquet"].sort());
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
  assert.match(sql, /read_parquet\('\/lake\/\*\.parquet'/);
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

function mount(run: DuckDbRunner) {
  const ctx = testContext({
    env: { DUCKDB_SOURCES: `lake=${lake}` },
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
    assert.match(sql, /SET allowed_directories = \['.*\/lake\/'\];/);
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
  assert.ok(listing.includes("Open the 3 Parquet files here as one"));
  assert.ok(listing.includes(`href="/duckdb/files?t=lake&amp;f=javascript%3Aalert%281%29"`), "a hostile folder name is a path on this app");
  assert.ok(listing.includes("&lt;img src=x onerror=alert(1)&gt;.parquet"));
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
  // Even if a symlink out got past the viewer's own check, DuckDB is shut in to the source.
  await assert.rejects(data.scan("real", `SELECT * FROM read_parquet(${lit(join(outside, "secret.parquet"))})`), /disabled|Permission/i);
});
