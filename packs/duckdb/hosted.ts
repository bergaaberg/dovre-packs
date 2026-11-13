/**
 * The hosted DuckDB page (dovre#303). There's no native DuckDB in a Worker, so the browser runs
 * duckdb-wasm, the same pinned build wasm-canary proved. The data is the files in an R2 bucket
 * bound to the pack (`DUCKDB_FILES`): the page lists them, and each becomes a view named after its
 * file. DuckDB reads a file over `/duckdb/r2/<name>`, which serves the object with range requests,
 * so a Parquet file is read only as far as the query needs. Rows go from R2 to the browser and are
 * never kept, logged or shown to a model on the way. The page's CSP keeps fetches same-origin, so
 * remote https sources stay a local feature for now.
 */
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { Empty, Notice, type Pack, PageHeader, Panel, type PackContext, strictOrigin } from "dovre/pack.ts";

type App = Parameters<NonNullable<Pack["routes"]>>[0];
import { fileViewName, kindOf, type FileKind } from "./data.ts";
import { cleanName, UPLOAD_KINDS } from "./uploads.ts";

/** A Worker's request body tops out at 100 MB: bigger files go in with `wrangler r2 object put`. */
export const HOSTED_MAX_UPLOAD = 95 * 1024 * 1024;
/** The most files the page lists (and makes views of). */
export const MAX_FILES = 500;

/** The part of R2's binding the pack uses (workers-types' R2Bucket, kept structural). */
export type R2Range = { offset: number; length?: number } | { suffix: number };
type R2Meta = { key: string; size: number; uploaded: Date; httpEtag: string };
export type R2Like = {
  list(o?: { limit?: number; cursor?: string }): Promise<{ objects: R2Meta[]; truncated: boolean; cursor?: string }>;
  head(key: string): Promise<R2Meta | null>;
  get(key: string, o?: { range?: R2Range }): Promise<(R2Meta & { body: ReadableStream; range?: R2Range }) | null>;
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, o?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
};

export const bucketOf = (ctx: PackContext): R2Like | undefined => {
  const b = ctx.bindings.DUCKDB_FILES as R2Like | undefined;
  return b && typeof b.get === "function" ? b : undefined;
};

export type HostedFile = { name: string; kind: FileKind; size: number; at: number; view: string };

/** The bucket's data files, newest first, each with a view name no other file has. Other keys are left out. */
export async function listFiles(bucket: R2Like): Promise<{ files: HostedFile[]; more: boolean }> {
  const found: Omit<HostedFile, "view">[] = [];
  let cursor: string | undefined;
  let more = false;
  for (let i = 0; i < 10; i++) {
    const r = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of r.objects) {
      const kind = kindOf(o.key);
      if (kind && cleanName(o.key) === o.key) found.push({ name: o.key, kind, size: o.size, at: o.uploaded.getTime() });
    }
    if (!r.truncated) break;
    cursor = r.cursor;
    more = i === 9;
  }
  found.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  if (found.length > MAX_FILES) more = true;
  const taken = new Set<string>();
  const files = found.slice(0, MAX_FILES).map((f) => {
    const base = fileViewName(f.name);
    let view = base;
    for (let n = 2; taken.has(view); n++) view = `${base}_${n}`;
    taken.add(view);
    return { ...f, view };
  });
  return { files, more };
}

/**
 * One `Range: bytes=…` (DuckDB asks for one at a time) against an object of `size` bytes: the R2
 * range and the bytes it covers, "whole" without a header or for one it can't read as a single
 * range, or "unsatisfiable".
 */
export function rangeOf(header: string | undefined, size: number): { r2: R2Range; start: number; end: number } | "whole" | "unsatisfiable" {
  if (!header) return "whole";
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return "whole";
  if (!m[1]) {
    const n = Math.min(Number(m[2]), size);
    if (n <= 0) return "unsatisfiable";
    return { r2: { suffix: n }, start: size - n, end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "unsatisfiable";
  return { r2: { offset: start, length: end - start + 1 }, start, end };
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const KIND_LABEL: Record<FileKind, string> = { parquet: "Parquet", csv: "CSV", json: "JSON lines" };
const READ: Record<FileKind, string> = { parquet: "read_parquet", csv: "read_csv", json: "read_json" };

/** The SQL that makes a file's view: names and kinds are [A-Za-z0-9._-] and [a-z0-9_], so nothing to quote but the path. */
export const viewSql = (f: Pick<HostedFile, "name" | "kind" | "view">) =>
  `CREATE OR REPLACE VIEW "${f.view}" AS SELECT * FROM ${READ[f.kind]}('/duckdb/r2/${encodeURIComponent(f.name).replace(/'/g, "''")}')`;

export const HOSTED_STYLES = `
.dd-web .dd-sql { width: 100%; min-height: 96px; font: var(--fs-s) / 1.45 var(--mono); }
.dd-web .dd-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
.dd-web .dd-status { font-size: var(--fs-s); color: var(--text-2); }
.dd-web .dd-out { margin-top: 8px; overflow-x: auto; font: var(--fs-s) / 1.45 var(--mono); }
.dd-web .dd-out table { border-collapse: collapse; }
.dd-web .dd-out th, .dd-web .dd-out td { padding: 2px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: pre; }
.dd-files .dd-file { font-family: var(--mono); }
.dd-files .dd-acts { display: flex; gap: 6px; justify-content: flex-end; }
.dd-files .dd-acts form { margin: 0; }
`;

/** The hosted page's body: the query box first, then the files (each with its view's name). */
export function hostedPage(o: { files: HostedFile[]; more: boolean; pick?: string; wasm?: string; wasmCoi?: string; error?: string; sourcesSet: boolean }): ReturnType<typeof html> {
  const picked = o.files.find((f) => f.name === o.pick) ?? o.files[0];
  const sql = picked ? `SELECT * FROM "${picked.view}" LIMIT 100` : "SELECT 42 AS answer, version() AS duckdb";
  return html`${PageHeader({ title: "DuckDB", sub: "Your files in R2, queried by DuckDB in your browser. Rows go from R2 to this page and nowhere else." })}
    ${o.error ? Notice({ tone: "bad", children: o.error }) : ""}
    ${Panel({
      title: "Query",
      children: html`<section class="dd-web" data-wasm="${o.wasm ?? ""}" data-wasm-coi="${o.wasmCoi ?? ""}">
        <textarea class="dd-sql" spellcheck="false" aria-label="SQL">${sql}</textarea>
        <div class="dd-bar"><button type="button" class="primary" data-dd-run disabled>Run</button><span class="dd-status" role="status">This needs script: DuckDB runs in your browser.</span></div>
        <div class="dd-out" aria-label="Result"></div>
      </section>`,
    })}
    ${Panel({
      title: "Files",
      meta: o.files.length ? `${o.files.length}${o.more ? "+" : ""} in R2` : "",
      children: html`<div class="dd-files">${
        o.files.length
          ? html`<div class="sheet"><table class="data"><thead><tr><th scope="col">View</th><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Size</th><th scope="col">Added</th><th scope="col"></th></tr></thead><tbody>${o.files.map(
              (f) =>
                html`<tr data-dd-file data-view="${f.view}" data-sql="${viewSql(f)}"><td class="dd-file">${f.view}</td><td>${f.name}</td><td>${KIND_LABEL[f.kind]}</td><td>${sizeText(f.size)}</td><td>${new Date(f.at).toISOString().slice(0, 16).replace("T", " ")}</td><td><div class="dd-acts"><button type="button" class="btn sm" data-dd-pick="1" data-view="${f.view}">Query</button><form method="post" action="/duckdb/delete"><input type="hidden" name="name" value="${f.name}"><button type="submit" class="btn sm">Remove</button></form></div></td></tr>`,
            )}</tbody></table></div>`
          : Empty({ title: "No files yet", children: html`<p>Add a Parquet, CSV or JSON lines file below. Each one becomes a view named after the file.</p>` })
      }
        <form method="post" action="/duckdb/upload" enctype="multipart/form-data" class="query"><label class="field"><span class="label">Add a Parquet, CSV/TSV or JSON lines file</span><input type="file" name="file" accept="${UPLOAD_KINDS}" required><span class="hint">Kept in R2 until you remove it. A file of the same name is replaced. ${mb(HOSTED_MAX_UPLOAD)} at most from here; put bigger ones in the bucket with <code>wrangler r2 object put</code>.</span></label><div class="buttons"><button type="submit" class="primary" data-busy="Adding">Add</button></div></form>
        ${o.sourcesSet ? html`<p class="hint">The sources in <code>DUCKDB_SOURCES</code> are read only where Dovre runs on your machine. Hosted, the page reads the files here.</p>` : ""}
      </div>`,
    })}`;
}

/** Hosted routes: the page, a file's bytes for DuckDB, adding and removing a file. */
export function hostedRoutes(app: App, ctx: PackContext): void {
  const page = async (c: Context<any>, o: { pick?: string; error?: string; status?: 400 | 413 | 500 | 503 } = {}) => {
    const bucket = bucketOf(ctx);
    let listed: { files: HostedFile[]; more: boolean } = { files: [], more: false };
    let error = o.error;
    if (!bucket) error ??= "There's no R2 bucket bound as DUCKDB_FILES.";
    else {
      try {
        listed = await listFiles(bucket);
      } catch (e) {
        ctx.log(`R2 list failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        error ??= "The files in R2 couldn't be listed.";
      }
    }
    if (o.status) c.status(o.status);
    return ctx.page(c, {
      title: "DuckDB",
      current: "/duckdb",
      body: hostedPage({ ...listed, pick: o.pick, wasm: ctx.wasm("duckdb"), wasmCoi: ctx.wasm("duckdb-coi"), error, sourcesSet: !!ctx.env.DUCKDB_SOURCES?.trim() }),
    });
  };

  app.get("/duckdb", (c) => page(c, { pick: c.req.query("f") }));

  // A file's bytes, for DuckDB in this app's own pages (the same origin, behind the same sign-in).
  app.on(["GET", "HEAD"], "/duckdb/r2/:name", strictOrigin, async (c) => {
    const bucket = bucketOf(ctx);
    const name = c.req.param("name");
    if (!bucket || cleanName(name) !== name) return c.notFound();
    const head = await bucket.head(name);
    if (!head) return c.notFound();
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache",
      ETag: head.httpEtag,
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    const range = rangeOf(c.req.header("range"), head.size);
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    const len = range === "whole" ? head.size : range.end - range.start + 1;
    headers.set("Content-Length", String(len));
    if (range !== "whole") headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
    const status = range === "whole" ? 200 : 206;
    if (c.req.method === "HEAD") return new Response(null, { status, headers });
    const obj = await bucket.get(name, range === "whole" ? undefined : { range: range.r2 });
    if (!obj) return c.notFound();
    return new Response(obj.body, { status, headers });
  });

  app.post(
    "/duckdb/upload",
    strictOrigin,
    bodyLimit({ maxSize: HOSTED_MAX_UPLOAD + 64 * 1024, onError: (c) => page(c, { error: `That file is bigger than ${mb(HOSTED_MAX_UPLOAD)}.`, status: 413 }) }),
    async (c) => {
      const bucket = bucketOf(ctx);
      if (!bucket) return page(c, { status: 503 });
      let file: unknown;
      try {
        file = (await c.req.parseBody()).file;
      } catch {
        return page(c, { error: "That upload didn't arrive whole.", status: 400 });
      }
      if (!(file instanceof File) || !file.size) return page(c, { error: "Pick a file to add.", status: 400 });
      const name = cleanName(file.name);
      if (!name) return page(c, { error: "Only Parquet, CSV/TSV and JSON lines files open here.", status: 400 });
      if (file.size > HOSTED_MAX_UPLOAD) return page(c, { error: `That file is bigger than ${mb(HOSTED_MAX_UPLOAD)}.`, status: 413 });
      try {
        await bucket.put(name, new Uint8Array(await file.arrayBuffer()), { httpMetadata: { contentType: "application/octet-stream" } });
      } catch (e) {
        ctx.log(`R2 put failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        return page(c, { error: "The file couldn't be saved.", status: 500 });
      }
      return c.redirect(`/duckdb?f=${encodeURIComponent(name)}`, 303);
    },
  );

  app.post("/duckdb/delete", strictOrigin, async (c) => {
    const bucket = bucketOf(ctx);
    if (!bucket) return page(c, { status: 503 });
    const raw = (await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)).name;
    const name = typeof raw === "string" ? raw : "";
    if (cleanName(name) !== name) return page(c, { error: "That isn't a file here.", status: 400 });
    try {
      await bucket.delete(name);
    } catch (e) {
      ctx.log(`R2 delete failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return page(c, { error: "The file couldn't be removed.", status: 500 });
    }
    return c.redirect("/duckdb", 303);
  });
}

// The page's part, run on every page, doing something only on the hosted page: DuckDB loads on the
// first Run, makes a view per listed file, and draws the result with textContent only.
export const HOSTED_SCRIPT = `(() => {
  const root = document.querySelector(".dd-web");
  if (!root || root.dataset.on || typeof dovreFiles === "undefined") return;
  root.dataset.on = "1";
  const run = root.querySelector("[data-dd-run]");
  const sql = root.querySelector(".dd-sql");
  const status = root.querySelector(".dd-status");
  const out = root.querySelector(".dd-out");
  const views = [...document.querySelectorAll("tr[data-dd-file]")].map((r) => r.dataset.sql);
  let db;
  // Threads when the page is cross-origin isolated (the pack's \`isolated\`): the coi build, a worker per thread.
  const coi = self.crossOriginIsolated === true && typeof SharedArrayBuffer === "function" && !!root.dataset.wasmCoi;
  const threads = coi ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1)) : 1;
  const open = async () => {
    const m = await import(dovreFiles["duckdb.js"]);
    const url = (p) => new URL(p, location.href).href;
    const d = new m.AsyncDuckDB(new m.VoidLogger(), new Worker(dovreFiles[coi ? "duckdb-coi-worker.js" : "duckdb-worker.js"]));
    if (coi) {
      await d.instantiate(url(root.dataset.wasmCoi), url(dovreFiles["duckdb-coi-pthread.js"]));
      await d.open({ maximumThreads: threads });
    } else await d.instantiate(url(root.dataset.wasm));
    const c = await d.connect();
    try {
      for (const v of views) await c.query(v.replace("('/duckdb/r2/", "('" + location.origin + "/duckdb/r2/"));
    } finally {
      await c.close();
    }
    return d;
  };
  const text = (v) => (v === null || v === undefined ? "NULL" : typeof v !== "object" || (!Array.isArray(v) && v.toString !== Object.prototype.toString) ? String(v) : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x)));
  const cell = (tag, v) => { const c = document.createElement(tag); c.textContent = v; return c; };
  const scaled = (s, k) => {
    const neg = s[0] === "-";
    const d = (neg ? s.slice(1) : s).padStart(k + 1, "0");
    return (neg ? "-" : "") + d.slice(0, -k) + "." + d.slice(-k);
  };
  const SHOWN = 500;
  const draw = (r) => {
    const names = r.schema.fields.map((f) => f.name);
    const scales = r.schema.fields.map((f) => (f.type && typeof f.type.scale === "number" && f.type.scale > 0 ? f.type.scale : 0));
    const cols = names.map((_n, i) => r.getChildAt(i));
    const n = Math.min(r.numRows, SHOWN);
    const t = document.createElement("table");
    const head = document.createElement("tr");
    head.append(...names.map((x) => cell("th", x)));
    t.append(head);
    for (let i = 0; i < n; i++) {
      const tr = document.createElement("tr");
      tr.append(...cols.map((c, k) => { const v = c.get(i); return cell("td", scales[k] && v !== null && v !== undefined ? scaled(String(v), scales[k]) : text(v)); }));
      t.append(tr);
    }
    out.replaceChildren(t);
    return r.numRows;
  };
  const go = async () => {
    run.disabled = true;
    const t0 = performance.now();
    status.textContent = db ? "Running…" : "Loading DuckDB (36 MB the first time)…";
    try {
      const d = await (db ??= open());
      const t1 = performance.now();
      const c = await d.connect();
      try {
        const rows = draw(await c.query(sql.value));
        const t2 = performance.now();
        status.textContent = rows + (rows === 1 ? " row" : " rows") + (rows > SHOWN ? " (the first " + SHOWN + " shown)" : "") + " in " + (t2 - t1).toFixed(0) + " ms" + (t1 - t0 > 50 ? ", after " + ((t1 - t0) / 1000).toFixed(1) + " s loading" : "") + ", " + (coi ? "up to " + threads + " threads" : "one thread") + ".";
      } finally {
        await c.close();
      }
    } catch (e) {
      if (db) db = await db.then((x) => x, () => undefined);
      status.textContent = "DuckDB didn't run it: " + String((e && e.message) || e).slice(0, 300);
    }
    run.disabled = false;
  };
  run.disabled = false;
  run.addEventListener("click", go);
  sql.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !run.disabled) { e.preventDefault(); go(); } });
  for (const b of document.querySelectorAll("[data-dd-pick]")) {
    b.addEventListener("click", () => {
      sql.value = 'SELECT * FROM "' + b.dataset.view + '" LIMIT 100';
      sql.scrollIntoView({ block: "nearest" });
      if (!run.disabled) go();
    });
  }
})();`;
