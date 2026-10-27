/**
 * Files added from this computer (`POST /duckdb/files/upload`): only from Dovre's own pages, only
 * the kinds the viewer reads, under a clean name inside the uploads folder, size-capped, swept after
 * a day. Then they open as any folder source's file does, shut in to that folder. A fake runner.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { testContext } from "dovre/packs/testing.ts";
import { createDuckDbPack } from "../index.ts";
import type { DuckDbRunner } from "../data.ts";
import { lit } from "../files.ts";
import { cleanName, KEEP_MS, save, sweep, uploadsSource } from "../uploads.ts";

const base = mkdtempSync(join(tmpdir(), "duckdb-up-"));
after(() => rmSync(base, { recursive: true, force: true }));
const H = `<script>alert(1)</script>`;

function fake(): DuckDbRunner & { seen: string[] } {
  const seen: string[] = [];
  const run = (async (_args: string[], o?: { input?: string }) => {
    seen.push(o?.input ?? "");
    return { stdout: "[]", stderr: "", code: 0 };
  }) as DuckDbRunner & { seen: string[] };
  run.seen = seen;
  return run;
}

function mount(dir: string, run = fake(), maxUpload?: number) {
  const ctx = testContext({ env: { DUCKDB_SOURCES: "" }, page: async (c, o) => c.html(String(await o.body)) });
  const app = new Hono();
  createDuckDbPack({ run, uploadsDir: dir, maxUpload }).routes!(app as any, ctx);
  const send = (name: string, body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = { origin: "http://localhost" }) => {
    const form = new FormData();
    form.set("file", new File([body], name));
    return app.request("http://localhost/duckdb/files/upload", { method: "POST", body: form, headers });
  };
  return { app, run, send, get: (p: string) => app.request(`http://localhost${p}`) };
}

test("uploads: names are cleaned to a plain file of a kind the viewer reads", () => {
  assert.equal(cleanName("orders.parquet"), "orders.parquet");
  assert.equal(cleanName("C:\\Users\\me\\orders.CSV"), "orders.CSV");
  assert.equal(cleanName("../../etc/passwd"), undefined);
  assert.equal(cleanName("../../x.jsonl"), "x.jsonl");
  assert.equal(cleanName(".hidden.parquet"), "hidden.parquet");
  assert.equal(cleanName("..parquet"), undefined);
  assert.equal(cleanName(`${H}.parquet`), "script_.parquet", "the last part after a slash");
  assert.equal(cleanName(`<img src=x onerror=alert(1)>.parquet`), "img_src_x_onerror_alert_1_.parquet");
  assert.equal(cleanName("a b\0c.tsv"), "a_b_c.tsv");
  assert.equal(cleanName("run.sh"), undefined);
  assert.equal(cleanName("data.duckdb"), undefined);
  assert.equal(cleanName(`${"x".repeat(300)}.ndjson`)?.length, 120);
  assert.equal(uploadsSource("/u", [{ id: "uploads", label: "u", path: "/x" }]).id, "uploads_");
});

test("uploads: a day old goes, and the oldest go first past the cap", () => {
  const dir = mkdtempSync(join(base, "sweep-"));
  const now = Date.now();
  const at = (name: string, ageMs: number, bytes: number) => {
    writeFileSync(join(dir, name), "x".repeat(bytes));
    const t = (now - ageMs) / 1000;
    utimesSync(join(dir, name), t, t);
  };
  at("old.csv", KEEP_MS + 1000, 1);
  at("a.csv", 3000, 10);
  at("b.csv", 2000, 10);
  at("c.csv", 1000, 10);
  sweep(dir, now, 5, 20);
  assert.deepEqual(readdirSync(dir).sort(), ["c.csv"]);
  save(dir, "c.csv", new TextEncoder().encode("new"), now);
  assert.equal(readFileSync(join(dir, "c.csv"), "utf8"), "new", "the same name is replaced");
  assert.deepEqual(readdirSync(dir), ["c.csv"], "nothing left aside");
});

test("uploads: a file from Dovre's own page is saved under its clean name and opens shut in to the folder", async () => {
  const dir = join(base, "up1");
  const { send, get, run } = mount(dir);
  const home = await (await get("/duckdb/files")).text();
  assert.ok(home.includes('action="/duckdb/files/upload"') && home.includes('enctype="multipart/form-data"'));
  assert.ok(!existsSync(dir), "nothing made before the first upload");
  assert.ok(!home.includes('href="/duckdb/files?t=uploads"'), "not listed as a source yet");

  const r = await send("../../orders.parquet", "PAR1");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/duckdb/files?t=uploads&f=orders.parquet");
  assert.deepEqual(readdirSync(dir), ["orders.parquet"]);
  assert.equal(readFileSync(join(dir, "orders.parquet"), "utf8"), "PAR1");

  const page = await get("/duckdb/files?t=uploads&f=orders.parquet");
  assert.equal(page.status, 200);
  assert.ok(run.seen.length > 0);
  for (const sql of run.seen) assert.ok(sql.includes(`SET allowed_directories = [${lit(join(dir, "/"))}];`), sql);
  assert.ok((await (await get("/duckdb/files")).text()).includes('href="/duckdb/files?t=uploads"'), "listed once it has a file");
  assert.equal((await get("/duckdb/files?t=uploads&f=..%2F..%2Fetc%2Fpasswd")).status, 404);
});

test("uploads: refused from elsewhere, of other kinds, empty or too big; a hostile name renders inert", async () => {
  const dir = join(base, "up2");
  const { send } = mount(dir, fake(), 1000);
  assert.equal((await send("a.csv", "a\n1\n", {})).status, 403, "no Origin");
  assert.equal((await send("a.csv", "a\n1\n", { origin: "https://evil.example" })).status, 403);
  assert.equal((await send("a.csv", "a\n1\n", { origin: "http://localhost", "sec-fetch-site": "cross-site" })).status, 404);
  const sh = await send("run.sh", "echo hi");
  assert.equal(sh.status, 400);
  assert.ok((await sh.text()).includes("Only Parquet"));
  assert.equal((await send("a.csv", "")).status, 400);
  const big = await send("big.csv", new Uint8Array(1001));
  assert.equal(big.status, 413);
  assert.ok((await big.text()).includes("bigger than 1000 bytes"));
  const huge = await send("huge.csv", new Uint8Array(200_000));
  assert.equal(huge.status, 413, "cut off as it arrives");
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, "nothing saved");

  const r = await send(`${H}<img src=x onerror=alert(1)>.csv`, "a\n1\n");
  assert.equal(r.status, 303);
  const [name] = readdirSync(dir);
  assert.match(name!, /^[A-Za-z0-9._-]+\.csv$/);
});
