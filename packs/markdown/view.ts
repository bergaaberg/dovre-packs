/**
 * Markdown (`markdown`) views. A document's rendered markup is put on the page with raw(): it's
 * built only by markdown-it (raw HTML off) from escaped text (render.ts, and the hostile-input
 * tests). Everything else goes through `html` escaping.
 */
import { html, raw } from "hono/html";
import { Empty, type Html, KeyValues, Notice, PageHeader, Panel, Tabs } from "dovre/pack.ts";
import { type Rendered, MAX_SOURCE } from "./render.ts";
import { docHref } from "./docs.ts";

export type Tab = "write" | "docs" | "pr";

function header(current: Tab, sub: string, hosted: boolean, title = "Markdown") {
  const items = [{ href: "/markdown", label: "Write", current: current === "write" }];
  if (!hosted) items.push({ href: "/markdown/docs", label: "Docs in checkouts", current: current === "docs" });
  return PageHeader({ title, sub, tabs: Tabs({ label: "Markdown", items }) });
}

/** Where the browser libraries are (Pack.files), so the pack's script can draw diagrams and math. */
export type DocFiles = { mermaid?: string; katex?: string; graphviz?: string };

const docAttrs = (f: DocFiles | undefined) => html`${f?.mermaid ? html` data-mermaid="${f.mermaid}"` : ""}${f?.katex ? html` data-katex="${f.katex}"` : ""}${f?.graphviz ? html` data-graphviz="${f.graphviz}"` : ""}`;

/** The rendered document, with the libraries' files named so the pack's script can draw it. */
export function body(r: Rendered, files: DocFiles | undefined): Html {
  return html`<div class="md-body" data-md-doc${docAttrs(files)}>${front(r)}${raw(r.html)}</div>`;
}

function front(r: Rendered): Html | "" {
  if (!r.front) return "";
  if ("text" in r.front) return html`<pre class="md-front">${r.front.text}</pre>`;
  return html`<div class="md-front">${KeyValues(r.front.pairs)}</div>`;
}

const PLACEHOLDER = "# A title\n\nSome **bold** text, a [link](https://example.com), and math: $e^{i\\pi} + 1 = 0$.\n\n```mermaid\ngraph LR; Write --> Preview --> Export\n```";

export type WriteState = { src: string; rendered?: Rendered; files?: DocFiles; hosted: boolean; from?: string };

export function writePage(s: WriteState): Html {
  const r = s.rendered;
  const rows = Math.min(40, Math.max(16, s.src.split("\n").length + 2));
  const form = html`<form method="post" action="/markdown" class="md-editor" data-md-live data-ctrl-enter>
<div class="md-tools"><label class="md-open">Open a file <input type="file" accept=".md,.markdown,text/markdown,text/plain" data-md-open></label>${s.from ? html`<span class="t3 sm">From ${s.from}</span>` : ""}</div>
<label class="field"><span class="label">Markdown</span><textarea name="src" rows="${rows}" spellcheck="false" autocomplete="off" maxlength="${MAX_SOURCE}" placeholder="${PLACEHOLDER}">${s.src}</textarea></label>
<div class="buttons"><button type="submit" class="primary">Preview</button><button type="submit" formaction="/markdown/export" data-md-export>Export HTML</button><button type="submit" formaction="/markdown/print" formtarget="_blank">Print or PDF</button></div>
<p class="t3 sm">Rendered on this Dovre's server as you type: nothing is sent elsewhere, logged or kept. Raw HTML shows as text; images show only from a checkout's own files.</p>
</form>`;
  const preview = html`<div class="md-preview" data-md-preview>${r ? body(r, s.files) : html`<div class="md-body" data-md-doc${docAttrs(s.files)}><p class="t3">The preview shows here.</p></div>`}</div>`;
  return html`${header("write", "GitHub-flavoured Markdown with math, mermaid and Graphviz diagrams: write, preview, export.", s.hosted)}<div class="md-split">${Panel({ children: form })}${Panel({ title: "Preview", children: preview })}</div>`;
}

/** The dock beside Bino's: a scratch pad with its preview under it, to take to the full editor. */
export function dockView(s: { src: string; rendered?: Rendered; files?: DocFiles }): Html {
  const form = html`<form method="post" action="/markdown/dock" class="md-editor" data-md-live data-ctrl-enter>
<textarea name="src" rows="8" spellcheck="false" autocomplete="off" maxlength="${MAX_SOURCE}" aria-label="Markdown" placeholder="Markdown, math or a mermaid block">${s.src}</textarea>
<div class="buttons"><button type="submit" class="primary">Preview</button><button type="submit" formaction="/markdown" formtarget="_top">Open in the editor</button><button type="submit" formaction="/markdown/print" formtarget="_blank">Print</button></div></form>`;
  const preview = html`<div class="md-preview md-dock-preview" data-md-preview>${s.rendered ? body(s.rendered, s.files) : html`<div class="md-body" data-md-doc${docAttrs(s.files)}><p class="t3">The preview shows here.</p></div>`}</div>`;
  return html`${form}${preview}<p class="t3 sm">Kept while the dock is open, and nowhere else.</p>`;
}

/** The live preview's answer: the rendered document alone. */
export function previewFragment(r: Rendered, files: DocFiles | undefined): Html {
  return body(r, files);
}

export function hostedDocsPage(): Html {
  return html`${header("docs", "Docs in checkouts", true)}${Notice({ tone: "neutral", children: "Docs in checkouts are read from this computer's checkouts, so they're only on a local Dovre. Paste a document on Write instead." })}`;
}

export function reposPage(repos: string[], codeDir: string): Html {
  const list = repos.length
    ? html`<ul class="md-files">${repos.map((r) => html`<li><a href="/markdown/docs/${encodeURIComponent(r)}">${r}</a></li>`)}</ul>`
    : Empty({ title: "No checkouts", children: html` No git repos directly under ${codeDir}.` });
  return html`${header("docs", "Read a checkout's README and docs, rendered, with its links checked.", false)}${Panel({ title: "Checkouts", meta: codeDir, children: list })}`;
}

export function docsPage(repo: string, files: string[], more: boolean): Html {
  const list = files.length
    ? html`<ul class="md-files">${files.map((f) => html`<li><a href="${docHref(repo, f)}">${f}</a></li>`)}</ul>${more ? html`<p class="t3 sm">Only the first ${files.length} are listed.</p>` : ""}`
    : Empty({ title: "No Markdown files here" });
  return html`${header("docs", `Markdown in ${repo}`, false, repo)}${Panel({ title: "Docs", meta: `${files.length}${more ? "+" : ""}`, children: list })}`;
}

export function docPage(o: { repo: string; path: string; rendered: Rendered; files?: DocFiles; src: string; /** A PR's file (pr.ts): its crumbs instead of the checkout's. */ pr?: { n: number; sha: string; hosted: boolean } }): Html {
  const r = o.rendered;
  const crumbs = o.pr
    ? html`<p class="t3 sm"><a href="/prs/${o.repo.split("/").map(encodeURIComponent).join("/")}/${o.pr.n}/files">${o.repo}#${o.pr.n}</a> / ${o.path} at <code>${o.pr.sha.slice(0, 7)}</code></p>`
    : html`<p class="t3 sm"><a href="/markdown/docs">Checkouts</a> / <a href="/markdown/docs/${encodeURIComponent(o.repo)}">${o.repo}</a> / ${o.path}</p>`;
  const outline = r.headings.filter((h) => h.level <= 3);
  const side = html`${
    r.broken.length
      ? Panel({ title: "Broken links", meta: String(r.broken.length), children: html`<ul class="md-broken-list">${[...new Set(r.broken)].slice(0, 50).map((b) => html`<li><code>${b}</code></li>`)}</ul>` })
      : ""
  }${
    outline.length > 1
      ? Panel({ title: "On this page", children: html`<ul class="md-outline">${outline.map((h) => html`<li class="md-l${h.level}"><a href="#${h.id}">${h.text}</a></li>`)}</ul>` })
      : ""
  }${Panel({
    children: html`<form method="post" action="/markdown" class="md-copy"><input type="hidden" name="from" value="${o.repo}/${o.path}"><textarea name="src" hidden>${o.src}</textarea><button type="submit">Edit a copy</button></form><p class="t3 sm">The copy is yours to change and export; the file stays as it is.</p>`,
  })}`;
  return html`${o.pr ? header("pr", o.path, o.pr.hosted, `${o.repo}#${o.pr.n}`) : header("docs", o.path, false, o.repo)}${crumbs}<div class="md-doc">${Panel({ children: body(r, o.files) })}<div class="md-side">${side}</div></div>`;
}

export function notFound(why: string): Html {
  return html`${header("docs", "Not found", false)}${Notice({ tone: "warn", children: why })}`;
}

/** Styles for a standalone document (Export, Print): the same look, without Dovre around it. */
export const DOC_CSS = `
:root { color-scheme: light dark; --ink: #1f2328; --ink-3: #59636e; --line: #d1d9e0; --soft: #f6f8fa; --accent: #0969da; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6edf3; --ink-3: #9198a1; --line: #3d444d; --soft: #151b23; --accent: #4493f8; } }
body { margin: 0; background: Canvas; color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
article { max-width: 860px; margin: 0 auto; padding: 32px 24px; }
a { color: var(--accent); }
h1, h2 { border-bottom: 1px solid var(--line); padding-bottom: .3em; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 85%; }
pre { background: var(--soft); padding: 12px 16px; border-radius: 6px; overflow: auto; }
:not(pre) > code { background: var(--soft); padding: .1em .35em; border-radius: 4px; }
blockquote { margin: 0; padding: 0 1em; border-left: .25em solid var(--line); color: var(--ink-3); }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 6px 13px; }
.md-table { overflow-x: auto; } img { max-width: 100%; }
li.md-task-item { list-style: none; } li.md-task-item .md-task { margin: 0 .3em 0 -1.4em; }
.md-alert { border-left-color: var(--accent); } .md-alert-title { font-weight: 600; color: var(--accent); }
.md-alert-warning { border-left-color: #9a6700; } .md-alert-warning .md-alert-title { color: #9a6700; }
.md-alert-caution { border-left-color: #cf222e; } .md-alert-caution .md-alert-title { color: #cf222e; }
.md-math { overflow-x: auto; margin: 1em 0; } .md-math pre.md-tex { margin: 0; } .md-broken { text-decoration: line-through wavy; }
.md-diagram { margin: 1em 0; text-align: center; } .md-diagram svg { max-width: 100%; height: auto; }
.md-front { margin-bottom: 1.5em; font-size: 90%; color: var(--ink-3); }
@media print { article { max-width: none; padding: 0; } pre { white-space: pre-wrap; } a { color: inherit; } }
`;

/** A standalone document: Export downloads it; Print opens it and prints once diagrams are drawn. */
export function standalone(o: { title: string; rendered: Rendered; scripts?: string[]; files?: DocFiles }): string {
  const scripts = (o.scripts ?? []).map((s) => html`<script src="${s}" defer></script>`);
  return `<!doctype html>${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${o.title}</title><style>${raw(DOC_CSS)}</style>${scripts}</head><body><article>${body(o.rendered, o.files)}</article></body></html>`}`;
}

/** The title of a document: its first heading, else what's given. */
export const titleOf = (r: Rendered, fallback = "Document") => r.headings[0]?.text.slice(0, 120) || fallback;
