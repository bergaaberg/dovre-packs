/**
 * Code review (`code-review`): reads core's diffs (a PR's Files tab, a checkout's Changes) as a
 * reviewer does, in the browser. Highlighting from tree-sitter (WebAssembly: web-tree-sitter and
 * one grammar per language, loaded when a diff first needs it), changes marked by token rather
 * than by line, and runs that changed only whitespace or layout folded to one row. Each hunk is
 * parsed on its own, so nothing more is read from the forge. The comments, threads and Viewed
 * boxes core draws stay as they are: only the code's text is redrawn (engine.js).
 *
 * The grammars and the runtime are files beside the pack (vendor/, built by build.sh), kept out of
 * the Worker bundle: core serves them (Pack.wasm as WasmFile). Without script, the diff is core's.
 */
import { readFileSync } from "node:fs";
import { type Pack, PACK_API, type WasmFile } from "dovre/packs/types.ts";
import { ENGINE_JS, QUERIES, RUNTIME_JS, SHA } from "./gen.ts";

/** A grammar or the runtime, from vendor/ (under Node only: hosted, core serves the built copy). */
const file = (name: string): WasmFile => ({ sha256: SHA[name]!, load: () => new Uint8Array(readFileSync(new URL(`./vendor/${name}.wasm`, import.meta.url))) });

/** FNV-1a: a served file's URL changes when it does. */
const hashOf = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

export const ENGINE_PATH = `/code-review/js/engine.${hashOf(ENGINE_JS)}.js`;
export const RUNTIME_PATH = `/code-review/js/web-tree-sitter.${hashOf(RUNTIME_JS)}.js`;
const queryPath = (lang: string) => `/code-review/q/${lang}.${hashOf(QUERIES[lang]!)}.scm`;
const MANIFEST = "/code-review/langs.json";

const styles = `
.cr-k, .cr-v { color: var(--accent); }
.cr-v { font-style: italic; }
.cr-s { color: color-mix(in srgb, var(--s3) 72%, var(--text)); }
.cr-n { color: color-mix(in srgb, var(--s4) 72%, var(--text)); }
.cr-f { color: color-mix(in srgb, var(--s5) 68%, var(--text)); }
.cr-t { color: color-mix(in srgb, var(--s1) 68%, var(--text)); }
.cr-p { color: color-mix(in srgb, var(--s2) 68%, var(--text)); }
.cr-c { color: var(--text-3); font-style: italic; }
mark.cr-x { color: inherit; border-radius: 2px; background: transparent; }
.d-add mark.cr-x { background: color-mix(in srgb, var(--ok) 26%, transparent); }
.d-del mark.cr-x { background: color-mix(in srgb, var(--bad) 26%, transparent); }
tr.cr-fold td { padding: 2px 8px; background: var(--surface-2, transparent); }
tr.cr-fold button { font-size: var(--fs-s); }
.cr-only { font-size: var(--fs-s); color: var(--text-2); margin-right: 6px; }
`;

// On every page; does something only where a diff is (now, or once a live update brings one).
const script = `
(() => {
  let on = false;
  const go = () => {
    if (on || !document.querySelector("table.diff")) return;
    on = true;
    mo.disconnect();
    import(${JSON.stringify(ENGINE_PATH)}).then((m) => m.start(document, ${JSON.stringify(MANIFEST)})).catch(() => undefined);
  };
  const mo = new MutationObserver(go);
  go();
  if (!on && document.body) mo.observe(document.body, { childList: true, subtree: true });
})();`;

const js = (body: string) => new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "private, max-age=31536000, immutable" } });

export function createCodeReviewPack(): Pack {
  return {
    manifest: {
      api: PACK_API,
      id: "code-review",
      name: "Code review",
      description: "Diffs read as a reviewer does: highlighting, changes marked by token, whitespace and layout changes folded. Runs in your browser (tree-sitter, as WebAssembly).",
      domain: "general",
      execution: "any",
    },
    styles,
    script,
    wasm: Object.fromEntries(["runtime", ...Object.keys(QUERIES)].map((n) => [n, file(n)])),
    routes(app, ctx) {
      app.get("/code-review/langs.json", (c) => {
        const langs: Record<string, { wasm: string; query: string }> = {};
        for (const lang of Object.keys(QUERIES)) {
          const wasm = ctx.wasm(lang);
          if (wasm) langs[lang] = { wasm, query: queryPath(lang) };
        }
        c.header("Cache-Control", "private, max-age=300");
        return c.json({ runtimeJs: RUNTIME_PATH, runtimeWasm: ctx.wasm("runtime") ?? "", langs });
      });
      app.get("/code-review/js/:file", (c) => {
        const at = `/code-review/js/${c.req.param("file")}`;
        return at === ENGINE_PATH ? js(ENGINE_JS) : at === RUNTIME_PATH ? js(RUNTIME_JS) : c.notFound();
      });
      app.get("/code-review/q/:file", (c) => {
        const lang = c.req.param("file").split(".")[0] ?? "";
        if (!Object.hasOwn(QUERIES, lang) || `/code-review/q/${c.req.param("file")}` !== queryPath(lang)) return c.notFound();
        return new Response(QUERIES[lang], { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, max-age=31536000, immutable" } });
      });
    },
  };
}

export const codeReviewPack = createCodeReviewPack();
