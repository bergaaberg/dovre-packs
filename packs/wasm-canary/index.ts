/**
 * WASM canary (`wasm-canary`): a line diff written in Rust (rust/, built by build.sh), compiled to
 * WebAssembly (no `unsafe`; wasm-bindgen carries the strings) and run in the browser. It proves the path a heavier pack takes (a syntax-aware
 * diff, tree-sitter, a formatter): core serves the module (`Pack.wasm`), the page's script
 * compiles it. The module is a file (diff.wasm) kept out of the Worker bundle: core serves it
 * locally from `load`, hosted from the static assets its build step writes. Nothing typed here leaves the browser.
 *
 * It also proves Rust on the server (core's Pack.server, API 2.1): `refresh` diffs the page's
 * sample through `ctx.call`, in a thread of its own locally and in a Worker of its own hosted
 * (server.js: the same glue, then server.handler.js), and the page says how that went.
 *
 * And a module over 25 MB (core's R2 path, dovre#304): DuckDB (36 MB of WebAssembly) runs a query
 * typed on the page, in the browser, loaded only when Run is pressed. The module and its worker
 * aren't committed: `load` fetches them from jsDelivr at the version duck.build.sh pinned, and core
 * serves them only if their SHA-256 matches. Hosted, the module is read from R2.
 *
 * And threads (core's `isolated`, API 2.2): the page is cross-origin isolated, so DuckDB runs its
 * threads build (SharedArrayBuffer, a worker per thread); where it isn't, the one-thread build.
 */
import { readFileSync } from "node:fs";
import { html } from "hono/html";
import type { Pack } from "dovre/pack.ts";
import { DIFF_GLUE, DIFF_SHA256 } from "./diff.wasm.ts";
import { SERVER_SHA256 } from "./server.sha.ts";
import { COI_PTHREAD_SHA256, COI_PTHREAD_URL, COI_WASM_SHA256, COI_WASM_URL, COI_WORKER_SHA256, COI_WORKER_URL, DUCK_JS_SHA256, DUCK_WASM_SHA256, DUCK_WASM_URL, DUCK_WORKER_SHA256, DUCK_WORKER_URL } from "./duck.ts";

/** The module's bytes, from diff.wasm beside this file. Under Node only: the Worker never reads it. */
export const diffWasm = (): Uint8Array => new Uint8Array(readFileSync(new URL("./diff.wasm", import.meta.url)));

/** server.js's bytes, for core's Pack.server. Under Node only, like diffWasm. */
export const serverJs = (): Uint8Array => new Uint8Array(readFileSync(new URL("./server.js", import.meta.url)));

/** duckdb.js's bytes (DuckDB's browser API, bundled by duck.build.sh). Under Node only. */
export const duckJs = (): Uint8Array => new Uint8Array(readFileSync(new URL("./duckdb.js", import.meta.url)));

/** A pinned release's bytes, fetched under Node when core first needs them (it checks the hash). */
export const pinned = (url: string) => async (): Promise<Uint8Array> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

const SQL = `SELECT 42 AS answer, version() AS duckdb, sum(i) AS total FROM range(1000000) t(i)`;

/** What the last server diff of the sample came to, kept for the page. */
type ServerRun = { ok: true; lines: number; hosted: boolean; at: number } | { ok: false; error: string; at: number };
const RUN_KEY = "server-run";

const OLD = `name: dovre
compatibility_date: 2026-10-06
observability: on
workers_dev: false
`;
const NEW = `name: dovre
compatibility_date: 2026-10-06
observability: on
minify: true
upload_source_maps: true
workers_dev: false
`;

const styles = `
.wc-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin: 12px 0; }
.wc-pair label { display: grid; gap: 4px; font-size: var(--fs-s); color: var(--text-2); }
.wc-pair textarea { min-height: 160px; font: var(--fs-s) / 1.45 var(--mono); }
.wc-server { font-size: var(--fs-s); color: var(--text-2); }
.wc-status { font-size: var(--fs-s); color: var(--text-2); }
.wc-out { margin: 8px 0 0; padding: 8px 0; border: 1px solid var(--border); border-radius: var(--r-s); font: var(--fs-s) / 1.45 var(--mono); overflow-x: auto; }
.wc-out span { display: block; padding: 0 10px; white-space: pre; }
.wc-duck { margin-top: 28px; }
.wc-sql { width: 100%; min-height: 72px; font: var(--fs-s) / 1.45 var(--mono); }
.wc-run { margin: 8px 0; }
.wc-table { margin-top: 8px; overflow-x: auto; font: var(--fs-s) / 1.45 var(--mono); }
.wc-table table { border-collapse: collapse; }
.wc-table th, .wc-table td { padding: 2px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: pre; }
`;

// wasm-bindgen's glue, then the page's part: runs on every page, does something only on the
// canary's. Draws the diff with textContent only.
const script = `${DIFF_GLUE}
(() => {
  const root = document.getElementById("wc-root");
  if (!root || root.dataset.on) return;
  root.dataset.on = "1";
  const status = root.querySelector(".wc-status");
  const [a, b] = root.querySelectorAll("textarea");
  const out = root.querySelector(".wc-out");
  wasm_bindgen({ module_or_path: root.dataset.wasm }).then(() => {
    const run = () => {
      const t0 = performance.now();
      const lines = wasm_bindgen.diff(a.value, b.value).split("\\n").slice(0, -1);
      const ms = performance.now() - t0;
      out.replaceChildren(...lines.map((l) => {
        const s = document.createElement("span");
        s.className = l[0] === "+" ? "d-add" : l[0] === "-" ? "d-del" : "d-ctx";
        s.textContent = l;
        return s;
      }));
      status.textContent = "Diffed in Rust, in your browser: " + lines.length + " lines in " + ms.toFixed(2) + " ms.";
    };
    let t;
    const later = () => { clearTimeout(t); t = setTimeout(run, 120); };
    a.addEventListener("input", later);
    b.addEventListener("input", later);
    run();
  }).catch((e) => { status.textContent = "The WebAssembly didn't load: " + e.message; });
})();
// DuckDB, loaded when Run is first pressed. Draws the result with textContent only.
(() => {
  const root = document.getElementById("wc-duck");
  if (!root || root.dataset.on || typeof dovreFiles === "undefined") return;
  root.dataset.on = "1";
  const run = root.querySelector(".wc-run");
  const sql = root.querySelector(".wc-sql");
  const status = root.querySelector(".wc-status");
  const out = root.querySelector(".wc-table");
  let db;
  // Threads when the page is cross-origin isolated (core's \`isolated\`): the coi build, a worker per thread.
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
    return d;
  };
  // Arrow's big numbers (HUGEINT, DECIMAL) are objects that print as numbers; lists and structs as JSON.
  const text = (v) => (v === null || v === undefined ? "NULL" : typeof v !== "object" || (!Array.isArray(v) && v.toString !== Object.prototype.toString) ? String(v) : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x)));
  const cell = (tag, v) => { const c = document.createElement(tag); c.textContent = v; return c; };
  // A DECIMAL comes unscaled (1.50 as 150): its column's scale puts the point back.
  const scaled = (s, k) => {
    const neg = s[0] === "-";
    const d = (neg ? s.slice(1) : s).padStart(k + 1, "0");
    return (neg ? "-" : "") + d.slice(0, -k) + "." + d.slice(-k);
  };
  const draw = (r) => {
    const names = r.schema.fields.map((f) => f.name);
    const scales = r.schema.fields.map((f) => (f.type && typeof f.type.scale === "number" && f.type.scale > 0 ? f.type.scale : 0));
    const cols = names.map((_n, i) => r.getChildAt(i));
    const n = Math.min(r.numRows, 100);
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
  run.disabled = false;
  run.addEventListener("click", async () => {
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
        status.textContent = "DuckDB, in your browser: " + rows + (rows === 1 ? " row" : " rows") + (rows > 100 ? " (the first 100 shown)" : "") + " in " + (t2 - t1).toFixed(0) + " ms" + (t1 - t0 > 50 ? ", after " + ((t1 - t0) / 1000).toFixed(1) + " s loading" : "") + ", " + (coi ? "up to " + threads + " threads" : "one thread (the page isn't cross-origin isolated)") + ".";
      } finally {
        await c.close();
      }
    } catch (e) {
      if (db) db = await db.then((x) => x, () => undefined);
      status.textContent = "DuckDB didn't run it: " + String((e && e.message) || e).slice(0, 300);
    }
    run.disabled = false;
  });
})();`;

export function createWasmCanaryPack(): Pack {
  return {
    manifest: {
      api: "2.2",
      version: "1.3.0",
      id: "wasm-canary",
      name: "WASM canary",
      description: "A line diff written in Rust, run as WebAssembly in your browser and, on a fixed sample, on the server, and DuckDB (36 MB) in your browser: proves a pack can ship and run WebAssembly, big modules too. Nothing typed here is sent anywhere.",
      domain: "general",
      execution: "any",
      private: true,
    },
    styles,
    script,
    // Cross-origin isolated pages (COEP): SharedArrayBuffer, so DuckDB's threads build runs.
    isolated: true,
    // duckdb, duckdb-coi: 36 MB each, over the static assets' limit: R2's hosted (core's assets.ts --r2).
    wasm: { diff: { sha256: DIFF_SHA256, load: diffWasm }, duckdb: { sha256: DUCK_WASM_SHA256, load: pinned(DUCK_WASM_URL) }, "duckdb-coi": { sha256: COI_WASM_SHA256, load: pinned(COI_WASM_URL) } },
    files: { "duckdb.js": { sha256: DUCK_JS_SHA256, load: duckJs }, "duckdb-worker.js": { sha256: DUCK_WORKER_SHA256, load: pinned(DUCK_WORKER_URL) },
      "duckdb-coi-worker.js": { sha256: COI_WORKER_SHA256, load: pinned(COI_WORKER_URL) },
      "duckdb-coi-pthread.js": { sha256: COI_PTHREAD_SHA256, load: pinned(COI_PTHREAD_URL) },
    },
    server: { script: { sha256: SERVER_SHA256, load: serverJs }, wasm: ["diff"], calls: ["diff"], ms: 5000 },
    // The sample only, never what's typed on the page.
    async refresh(ctx) {
      const r = await ctx.call("diff", { old: OLD, new: NEW });
      const lines = r.ok ? (r.value as { lines?: unknown })?.lines : undefined;
      const run: ServerRun = Array.isArray(lines) ? { ok: true, lines: lines.length, hosted: ctx.hosted, at: Date.now() } : { ok: false, error: r.ok ? "it answered without lines" : r.error, at: Date.now() };
      await ctx.store.kv.set(RUN_KEY, run);
    },
    pages: () => [{ title: "WASM canary", href: "/wasm-canary", icon: "±", about: "A line diff in Rust, run as WebAssembly in your browser", also: ["wasm", "webassembly", "rust", "diff"] }],
    about: (_ctx, path) => (path.startsWith("/wasm-canary") ? "The WASM canary (what's typed here stays in the browser)" : undefined),
    routes(app, ctx) {
      app.get("/wasm-canary", async (c) => {
        const run = await ctx.store.kv.get<ServerRun>(RUN_KEY).catch(() => undefined);
        const server = !run
          ? "On the server: not run yet (it runs with the pack's refresh)."
          : run.ok
            ? `On the server: the sample above, diffed by the same Rust in ${run.hosted ? "a Worker" : "a thread"} of its own: ${run.lines} lines.`
            : `On the server: didn't run: ${run.error}`;
        return ctx.page(c, {
          title: "WASM canary",
          current: "/wasm-canary",
          body: html`<section id="wc-root" data-wasm="${ctx.wasm("diff") ?? ""}">
            <h1>WASM canary</h1>
            <p>A line diff written in Rust and run as WebAssembly, here in your browser. Change either side.</p>
            <div class="wc-pair">
              <label>Old<textarea spellcheck="false" aria-label="Old text">${OLD}</textarea></label>
              <label>New<textarea spellcheck="false" aria-label="New text">${NEW}</textarea></label>
            </div>
            <p class="wc-status" role="status">This page needs script: the diff runs in your browser.</p>
            <pre class="wc-out" aria-label="Diff"></pre>
            <p class="wc-server">${server}</p>
          </section>
          <section id="wc-duck" class="wc-duck" data-wasm="${ctx.wasm("duckdb") ?? ""}" data-wasm-coi="${ctx.wasm("duckdb-coi") ?? ""}">
            <h2>DuckDB</h2>
            <p>36 MB of WebAssembly, more than a Worker's static assets take for a file, so the hosted app serves it from R2. It loads when you press Run, and the query runs in your browser, on several threads where the page allows it.</p>
            <textarea class="wc-sql" spellcheck="false" aria-label="SQL">${SQL}</textarea>
            <button type="button" class="btn sm wc-run" disabled>Run</button>
            <p class="wc-status" role="status">This needs script: DuckDB runs in your browser.</p>
            <div class="wc-table" aria-label="Result"></div>
          </section>`,
        });
      });
    },
  };
}

export const wasmCanaryPack = createWasmCanaryPack();
