/**
 * Code review (`code-review`): reads core's diffs (a PR's Files tab, a checkout's Changes) as a
 * reviewer does, in the browser. Highlighting from tree-sitter (WebAssembly: web-tree-sitter and
 * one grammar per language, loaded when a diff first needs it), changes marked by token rather
 * than by line, and runs that changed only whitespace or layout folded to one row. Each hunk is
 * parsed on its own, so nothing more is read from the forge. The comments, threads and Viewed
 * boxes core draws stay as they are: only the code's text is redrawn (engine.js).
 *
 * Moved blocks (dovre#520): a block removed in one place and added in another is marked as moved, its
 * two ends linked ("moved to line 120", "moved from line 4"), matched by syntax subtree across the
 * file's hunks, so a block that moved and was re-wrapped, or moved and was edited a little, still is.
 *
 * Changed symbols (dovre#300): a file's header names the functions, classes and methods its changes
 * touch, found with each grammar's definition queries (tags.scm) in the same parse of each hunk,
 * and with the definition git names in a hunk's header. Nothing more is read from the forge.
 * A file's whole outline, its changed definitions marked, when its "Outline" button is pressed:
 * that reads its new side (on a PR, one forge read, shared with the formatting check).
 *
 * The grammars and the runtime are files beside the pack (vendor/, built by build.sh), kept out of
 * the Worker bundle: core serves them (the .wasm as Pack.wasm WasmFiles, web-tree-sitter.js as a
 * Pack.files script). Without script, the diff is core's.
 *
 * Only formatting (dovre#301): a file whose two sides come out the same from dprint (WebAssembly,
 * one plugin per language, in the browser too; Ruff for Python) is marked and closed. On a checkout's own diff every
 * file a formatter knows is checked; on a PR's, when its "Only formatting?" button is pressed, since
 * that reads the file at the PR's head from the forge (src.ts).
 */
import { readFileSync } from "node:fs";
import { html } from "hono/html";
import type { Pack, WasmFile } from "dovre/pack.ts";
import { DPRINT_JS_SHA, ENGINE_JS, QUERIES, RUFF_JS_SHA, RUNTIME_JS_SHA, SHA, TAGS } from "./gen.ts";
import { formattable, MAX_SRC, outlined, prSrc, readSrc, srcAsk } from "./src.ts";

/** A file from vendor/ (under Node only: hosted, core serves the built copy). */
const vendored = (sha256: string, name: string): WasmFile => ({ sha256, load: () => new Uint8Array(readFileSync(new URL(`./vendor/${name}`, import.meta.url))) });
const file = (name: string) => vendored(SHA[name]!, `${name}.wasm`);

/** FNV-1a: a served file's URL changes when it does. */
const hashOf = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

export const ENGINE_PATH = `/code-review/js/engine.${hashOf(ENGINE_JS)}.js`;
const queryPath = (lang: string) => `/code-review/q/${lang}.${hashOf(QUERIES[lang]!)}.scm`;
const tagsPath = (lang: string) => `/code-review/t/${lang}.${hashOf(TAGS[lang]!)}.scm`;
const MANIFEST = "/code-review/langs.json";
/** Formatters, served as `fmt-<name>`: dprint plugins, and Ruff (python). */
const FORMATTERS = Object.keys(SHA).filter((n) => n.startsWith("fmt-")).map((n) => n.slice(4));

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
.cr-view { display: inline-flex; border: 1px solid var(--line); border-radius: var(--r-s); overflow: hidden; }
.cr-view button { border-radius: 0; }
.cr-view button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-weight: 600; }
.cr-syms { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin-right: 8px; font-size: var(--fs-s); min-width: 0; }
.cr-syms-in { color: var(--text-3); }
.cr-sym { font: inherit; font-family: var(--mono, monospace); color: var(--text-2); background: none; border: 0; padding: 0; cursor: pointer; max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-sym:hover, .cr-sym:focus-visible { color: var(--accent); text-decoration: underline; }
tr.cr-here > td { box-shadow: inset 3px 0 0 var(--accent); }
td.cr-mv { background: color-mix(in srgb, var(--accent) 9%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 60%, transparent); }
.cr-mv-tag { float: right; margin-left: 12px; padding: 0 4px; font: inherit; font-size: var(--fs-s); color: var(--text-2); background: none; border: 0; cursor: pointer; white-space: nowrap; }
.cr-mv-tag:hover, .cr-mv-tag:focus-visible { color: var(--accent); text-decoration: underline; }
.cr-outline { margin: 0 0 8px; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--r-s); font-size: var(--fs-s); max-height: 40vh; overflow: auto; }
.cr-outline[hidden] { display: none; }
.cr-outline-head { margin: 0 0 4px; color: var(--text-3); }
.cr-outline ol { list-style: none; margin: 0; padding: 0; columns: 18rem; column-gap: 24px; }
.cr-outline li { display: flex; align-items: baseline; gap: 6px; break-inside: avoid; min-width: 0; }
.cr-o1 { padding-left: 1.5em; }
.cr-o2 { padding-left: 3em; }
.cr-o3 { padding-left: 4.5em; }
.cr-o-name { font-family: var(--mono, monospace); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-changed { color: var(--accent); font-weight: 600; max-width: none; }
.cr-ln { color: var(--text-3); font-variant-numeric: tabular-nums; }
.cr-outline-btn[aria-expanded="true"] { color: var(--accent); }
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
      api: "2.0",
      version: "1.6.0",
      id: "code-review",
      name: "Code review",
      description: "Diffs read as a reviewer does: highlighting, changes marked by token, moved blocks shown as moves, the functions and classes they touch named, whitespace and layout changes folded, files that only changed formatting marked. Runs in your browser (tree-sitter, dprint and Ruff, as WebAssembly).",
      domain: "general",
      execution: "any",
      // Reads a file at a ref in a checkout, for the formatting check (local).
      binaries: ["git"],
    },
    styles,
    script,
    wasm: Object.fromEntries(["runtime", ...Object.keys(QUERIES), ...FORMATTERS.map((f) => `fmt-${f}`)].map((n) => [n, file(n)])),
    files: { "web-tree-sitter.js": vendored(RUNTIME_JS_SHA, "web-tree-sitter.js"), "dprint.js": vendored(DPRINT_JS_SHA, "dprint.js"), "ruff.js": vendored(RUFF_JS_SHA, "ruff.js") },
    slots: (ctx) => ({
      // A PR's file, when asked (one forge read for both): its outline, and whether it changed only formatting.
      "pr.file": (f) => {
        if (f.status === "removed" || !/^[0-9a-f]{40}$/.test(f.sha) || !ctx.forge()?.file) return "";
        const src = prSrc(f.repo, f.sha, f.path);
        return html`${outlined(f.path) ? html`<button type="button" class="btn sm ghost cr-outline-btn" data-cr-src="${src}" aria-expanded="false" title="Reads this file at the PR's head and lists its functions, classes and methods, the changed ones marked">Outline</button>` : ""}${formattable(f.path) && f.status !== "added" ? html`<button type="button" class="btn sm ghost cr-fmt" data-cr-src="${src}" title="Reads this file at the PR's head and checks whether its changes are only formatting">Only formatting?</button>` : ""}`;
      },
    }),
    routes(app, ctx) {
      app.get("/code-review/langs.json", (c) => {
        const langs: Record<string, { wasm: string; query: string; tags?: string }> = {};
        for (const lang of Object.keys(QUERIES)) {
          const wasm = ctx.wasm(lang);
          if (wasm) langs[lang] = { wasm, query: queryPath(lang), ...(Object.hasOwn(TAGS, lang) ? { tags: tagsPath(lang) } : {}) };
        }
        const plugins: Record<string, string> = {};
        for (const f of FORMATTERS) {
          const wasm = ctx.wasm(`fmt-${f}`);
          if (wasm) plugins[f] = wasm;
        }
        const dprint = ctx.file("dprint.js");
        const ruff = ctx.file("ruff.js");
        c.header("Cache-Control", "private, max-age=300");
        return c.json({ runtimeJs: ctx.file("web-tree-sitter.js") ?? "", runtimeWasm: ctx.wasm("runtime") ?? "", langs, ...(dprint ? { fmt: { js: dprint, ...(ruff ? { ruff } : {}), plugins } } : {}) });
      });
      // A file's new side for the formatting check: at a PR's head (the forge) or in a checkout (local).
      app.get("/code-review/src", async (c) => {
        const ask = srcAsk(c.req.query());
        const text = ask ? await readSrc(ctx, ask) : undefined;
        if (text === undefined || text.length > MAX_SRC) return c.notFound();
        return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      });
      app.get("/code-review/js/:file", (c) => {
        const at = `/code-review/js/${c.req.param("file")}`;
        return at === ENGINE_PATH ? js(ENGINE_JS) : c.notFound();
      });
      app.get("/code-review/q/:file", (c) => {
        const lang = c.req.param("file").split(".")[0] ?? "";
        if (!Object.hasOwn(QUERIES, lang) || `/code-review/q/${c.req.param("file")}` !== queryPath(lang)) return c.notFound();
        return new Response(QUERIES[lang], { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, max-age=31536000, immutable" } });
      });
      app.get("/code-review/t/:file", (c) => {
        const lang = c.req.param("file").split(".")[0] ?? "";
        if (!Object.hasOwn(TAGS, lang) || `/code-review/t/${c.req.param("file")}` !== tagsPath(lang)) return c.notFound();
        return new Response(TAGS[lang], { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, max-age=31536000, immutable" } });
      });
    },
  };
}

export const codeReviewPack = createCodeReviewPack();
