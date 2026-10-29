/**
 * WASM canary (`wasm-canary`): a line diff written in Rust (rust/, built by build.sh), compiled to
 * WebAssembly (no `unsafe`; wasm-bindgen carries the strings) and run in the browser. It proves the path a heavier pack takes (a syntax-aware
 * diff, tree-sitter, a formatter): core serves the module (`Pack.wasm`), the page's script
 * compiles it, and the server never runs it. The module is a file (diff.wasm) kept out of the Worker
 * bundle: core serves it locally from `load`, hosted from the static assets its build step writes. Nothing typed here leaves the browser.
 */
import { readFileSync } from "node:fs";
import { html } from "hono/html";
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { DIFF_GLUE, DIFF_SHA256 } from "./diff.wasm.ts";

/** The module's bytes, from diff.wasm beside this file. Under Node only: the Worker never reads it. */
export const diffWasm = (): Uint8Array => new Uint8Array(readFileSync(new URL("./diff.wasm", import.meta.url)));

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
.wc-status { font-size: var(--fs-s); color: var(--text-2); }
.wc-out { margin: 8px 0 0; padding: 8px 0; border: 1px solid var(--border); border-radius: var(--r-s); font: var(--fs-s) / 1.45 var(--mono); overflow-x: auto; }
.wc-out span { display: block; padding: 0 10px; white-space: pre; }
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
})();`;

export function createWasmCanaryPack(): Pack {
  return {
    manifest: {
      api: PACK_API,
      id: "wasm-canary",
      name: "WASM canary",
      description: "A line diff written in Rust, run as WebAssembly in your browser: proves a pack can ship and run WebAssembly. Nothing typed here is sent anywhere.",
      domain: "general",
      execution: "any",
      private: true,
    },
    styles,
    script,
    wasm: { diff: { sha256: DIFF_SHA256, load: diffWasm } },
    pages: () => [{ title: "WASM canary", href: "/wasm-canary", icon: "±", about: "A line diff in Rust, run as WebAssembly in your browser", also: ["wasm", "webassembly", "rust", "diff"] }],
    about: (_ctx, path) => (path.startsWith("/wasm-canary") ? "The WASM canary (what's typed here stays in the browser)" : undefined),
    routes(app, ctx) {
      app.get("/wasm-canary", (c) =>
        ctx.page(c, {
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
          </section>`,
        }),
      );
    },
  };
}

export const wasmCanaryPack = createWasmCanaryPack();
