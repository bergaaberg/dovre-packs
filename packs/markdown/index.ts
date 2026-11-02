/**
 * Markdown (`markdown`): read and write Markdown the way GitHub renders it, plus the diagrams it
 * doesn't. GFM (tables, task lists, footnotes, alerts), front matter as a table, math (KaTeX, as MathML)
 * and `mermaid` blocks drawn in the browser (both kept out of the Worker bundle as Pack.files
 * scripts; mermaid with `securityLevel: "strict"`). A split editor with a live preview, export to a self-contained HTML file, and a print page (PDF through the browser).
 *
 * Locally it also reads the docs in my checkouts (git repos directly under CODE_DIR): a repo's
 * README, docs/ and the rest of its Markdown, with links between files working and broken ones
 * flagged. Hosted, it's paste only.
 *
 * What's pasted is someone's work: it's posted (never put in a URL), rendered in the request, and
 * never logged, stored or sent anywhere; `private` to Bino. Libraries are bundled with the pack and
 * served from Dovre: nothing is fetched from the network.
 */
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { html } from "hono/html";
import type { AppEnv } from "dovre/env.ts";
import { type Pack, PACK_API, type WasmFile } from "dovre/packs/types.ts";
import { strictOrigin } from "dovre/strict.ts";
import { MAX_SOURCE, render } from "./render.ts";
import { codeDirOf, listDocs, listRepos, readDoc, readImage, repoRoot, resolver } from "./docs.ts";
import { dockView, docPage, docsPage, hostedDocsPage, notFound, previewFragment, reposPage, standalone, titleOf, writePage } from "./view.ts";
import { PRINT_JS, SCRIPT } from "./script.ts";
import { styles } from "./styles.ts";
import { KATEX_SHA, MERMAID_SHA } from "./gen.ts";
import { prDocHref, prDocOf, prResolver } from "./pr.ts";
import { isDoc } from "./docs.ts";

/** A browser library from vendor/ (under Node only: hosted, core serves the built copy). */
const vendored = (sha256: string, name: string): WasmFile => ({ sha256, load: () => new Uint8Array(readFileSync(new URL(`./vendor/${name}`, import.meta.url))) });

/** A form bigger than this is refused before it's read (a document at MAX_SOURCE, form-encoded). */
const MAX_BODY = 12 * MAX_SOURCE;

/** FNV-1a: a served file's URL changes when it does. */
const hashOf = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
export const PRINT_PATH = `/markdown/print.${hashOf(PRINT_JS)}.js`;

async function form(c: Context<AppEnv>): Promise<Record<string, string> | undefined> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return undefined;
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v.slice(0, MAX_SOURCE);
  return out;
}

const tooBig = (c: Context<AppEnv>) => c.text(`Too much at once (${MAX_SOURCE} characters at most).`, 413);

/** The part of the path after `/markdown/<what>/<repo>/`, decoded segment by segment; null when odd. */
function restOf(path: string, prefix: string): string | null {
  try {
    return path.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

export function createMarkdownPack(): Pack {
  return {
    manifest: {
      api: PACK_API,
      id: "markdown",
      name: "Markdown",
      description: "GitHub-flavoured Markdown with math and mermaid diagrams: write with a live preview, export or print, and read the docs in your checkouts with their links checked.",
      domain: "general",
      execution: "any",
      private: true,
    },
    styles,
    script: SCRIPT,
    files: { "mermaid.js": vendored(MERMAID_SHA, "mermaid.js"), "katex.js": vendored(KATEX_SHA, "katex.js") },
    nav: () => [{ href: "/markdown", title: "Markdown", icon: "pen", group: "Code" }],
    pages: (ctx) => [
      { title: "Markdown: write & preview", href: "/markdown", icon: "pen", about: "Write Markdown with a live preview, math and mermaid; export or print", also: ["markdown", "md", "mermaid", "diagram", "math", "katex", "preview", "readme"] },
      ...(ctx.hosted ? [] : [{ title: "Markdown: docs in checkouts", href: "/markdown/docs", icon: "pen", about: "Read a checkout's README and docs rendered, with broken links flagged", also: ["docs", "readme", "documentation"] }]),
    ],
    dock: () => ({ label: "Markdown", key: "M", title: "A scratch pad with a live preview: math and mermaid too" }),
    slots: (ctx) => ({
      "pr.file": (f) => (isDoc(f.path) && f.status !== "removed" && ctx.forge()?.file ? html`<a class="btn sm ghost" href="${prDocHref({ repo: f.repo, n: f.number, sha: f.sha, path: f.path })}">Rendered</a>` : ""),
    }),
    about: (_ctx, path) => (path.startsWith("/markdown/docs/") ? "A Markdown doc in a local checkout" : path.startsWith("/markdown/pr/") ? "A PR's Markdown file, rendered" : path.startsWith("/markdown") ? "Markdown editor (what's pasted here isn't shared)" : undefined),
    routes(app, ctx) {
      const files = () => ({ mermaid: ctx.file("mermaid.js"), katex: ctx.file("katex.js") });
      const codeDir = () => ctx.codeDir ?? codeDirOf(ctx.env);
      const page = (c: Context<AppEnv>, title: string, body: Parameters<typeof ctx.page>[1]["body"]) => ctx.page(c, { title, body, current: "/markdown" });

      const missing = async (c: Context<AppEnv>, why: string) => {
        const res = await page(c, "Not found", notFound(why));
        return new Response(res.body, { status: 404, headers: res.headers });
      };

      app.get("/markdown", (c) => page(c, "Markdown", writePage({ src: "", hosted: ctx.hosted, files: files() })));
      app.post("/markdown", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const src = f.src ?? "";
        return page(c, "Markdown", writePage({ src, rendered: render(src), hosted: ctx.hosted, files: files(), from: f.from?.slice(0, 300) || undefined }));
      });
      app.get("/markdown/dock", (c) => ctx.dockPage(c, { title: "Markdown", body: dockView({ src: "", files: files() }) }));
      app.post("/markdown/dock", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        return ctx.dockPage(c, { title: "Markdown", body: dockView({ src: f.src ?? "", rendered: render(f.src ?? ""), files: files() }) });
      });
      app.post("/markdown/preview", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        c.header("Cache-Control", "no-store");
        return c.html(String(previewFragment(render(f.src ?? ""), files())));
      });
      app.post("/markdown/export", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const r = render(f.src ?? "");
        c.header("Content-Disposition", `attachment; filename="document.html"`);
        c.header("Cache-Control", "no-store");
        return c.html(standalone({ title: titleOf(r), rendered: r }));
      });
      app.post("/markdown/print", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const r = render(f.src ?? "");
        c.header("Cache-Control", "no-store");
        return c.html(standalone({ title: titleOf(r), rendered: r, files: files(), scripts: [PRINT_PATH] }));
      });
      app.get(PRINT_PATH, (c) => {
        c.header("Content-Type", "text/javascript; charset=utf-8");
        c.header("Cache-Control", "private, max-age=31536000, immutable");
        return c.body(PRINT_JS);
      });

      // Docs in checkouts: local only.
      app.get("/markdown/docs", (c) => (ctx.hosted ? page(c, "Docs", hostedDocsPage()) : page(c, "Docs", reposPage(listRepos(codeDir()), codeDir()))));
      app.get("/markdown/docs/:repo", async (c) => {
        if (ctx.hosted) return page(c, "Docs", hostedDocsPage());
        const repo = c.req.param("repo");
        const root = repoRoot(codeDir(), repo);
        if (!root) return missing(c, "No such checkout.");
        const { files, more } = listDocs(root);
        return page(c, repo, docsPage(repo, files, more));
      });
      app.get("/markdown/docs/:repo/*", async (c) => {
        if (ctx.hosted) return page(c, "Docs", hostedDocsPage());
        const repo = c.req.param("repo");
        const root = repoRoot(codeDir(), repo);
        const path = restOf(c.req.path, `/markdown/docs/${encodeURIComponent(repo)}/`);
        const got = root && path ? readDoc(root, path) : { ok: false as const, why: "No such checkout." };
        if (!got.ok) return missing(c, got.why);
        const rendered = render(got.text, { resolve: resolver(root!, repo, path!) });
        return page(c, `${path} · ${repo}`, docPage({ repo, path: path!, rendered, src: got.text, files: files() }));
      });
      // A PR's Markdown file at its head commit (the "pr.file" slot), read through the forge.
      app.get("/markdown/pr/:owner/:name/:n/:sha/*", async (c) => {
        const p = c.req.param();
        const prefix = `/markdown/pr/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}/${p.n}/${p.sha}/`;
        const d = prDocOf(p.owner, p.name, p.n, p.sha, restOf(c.req.path, prefix));
        const forge = ctx.forge();
        if (!d || !forge?.file) return missing(c, "No such file in a PR.");
        const text = await forge.file(d.repo, d.path, d.sha).catch(() => undefined);
        if (text === undefined) return missing(c, "That file isn't in your repos at that commit.");
        const rendered = render(text, { resolve: prResolver(d, forge.host) });
        return page(c, `${d.path} · ${d.repo}#${d.n}`, docPage({ repo: d.repo, path: d.path, rendered, src: text, files: files(), pr: { n: d.n, sha: d.sha, hosted: ctx.hosted } }));
      });
      // A picture a doc shows, from the same checkout.
      app.get("/markdown/raw/:repo/*", (c) => {
        if (ctx.hosted) return c.notFound();
        const repo = c.req.param("repo");
        const root = repoRoot(codeDir(), repo);
        const path = restOf(c.req.path, `/markdown/raw/${encodeURIComponent(repo)}/`);
        const img = root && path ? readImage(root, path) : null;
        if (!img) return c.notFound();
        c.header("Content-Type", img.type);
        c.header("X-Content-Type-Options", "nosniff");
        c.header("Cache-Control", "private, no-cache");
        return c.body(img.bytes as Uint8Array<ArrayBuffer>);
      });
    },
  };
}

export const markdownPack = createMarkdownPack();
