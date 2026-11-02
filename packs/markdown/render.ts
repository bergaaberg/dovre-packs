/**
 * Markdown (`markdown`) rendering: GitHub-flavoured Markdown on the server (markdown-it), plus
 * task lists, alerts (`> [!NOTE]`), footnotes and front matter as a table. Math and `mermaid` blocks
 * are left as their source for the browser: the pack's script draws them (KaTeX as MathML, and
 * mermaid), each loaded only where a document needs it, so neither is in the Worker bundle.
 *
 * The source is hostile. Raw HTML in it is shown as text (`html: false`), so the only markup in the
 * output is what markdown-it writes, with every piece of text escaped. Links go only to
 * http(s), mailto and the document's own headings; anything else (a relative path, `javascript:`)
 * is plain text, unless the caller resolves it (a doc in a checkout links to its neighbours).
 * Images are links: pages may load images only from Dovre itself, never from where a document says.
 */
import MarkdownIt, { type MarkdownIt as Md, type StateBlock, type StateInline, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";
import { parse as parseYaml } from "yaml";

/** Characters at most per document. */
export const MAX_SOURCE = 500_000;

/** What a relative link in the document points at, when the caller knows (a doc in a checkout). */
export type Resolved = { href: string; broken?: false } | { broken: true };
export type RenderOptions = {
  /** A relative link's target, or undefined to leave it as text. Called with the link as written. */
  resolve?: (href: string, kind: "link" | "image") => Resolved | undefined;
};

export type Heading = { level: number; text: string; id: string };
export type Rendered = {
  /** Markup built only by markdown-it from escaped text: safe to put on a page as it is. */
  html: string;
  /** Front matter: key and value as text, or the block as written when it isn't a map. */
  front?: { pairs: [string, string][] } | { text: string };
  headings: Heading[];
  /** Relative links that lead nowhere, as written. */
  broken: string[];
  mermaid: number;
  math: number;
};

const ALERTS: Record<string, string> = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };
const ID_PREFIX = "md-";

/** A heading's id as GitHub makes it: lowercase, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** A formula as its TeX, for the browser to draw (script.ts): code, so it reads as such without script. */
function math(md: Md, src: string, display: boolean): string {
  const tex = md.utils.escapeHtml(src);
  return display ? `<div class="md-math"><pre class="md-tex" data-display>${tex}</pre></div>\n` : `<code class="md-tex">${tex}</code>`;
}

/** `$…$` and `$`…`$` (GitHub's two inline forms). */
function mathInline(state: StateInline, silent: boolean): boolean {
  const s = state.src;
  const at = state.pos;
  if (s[at] !== "$") return false;
  let start: number, end: number, after: number;
  if (s[at + 1] === "`") {
    start = at + 2;
    end = s.indexOf("`$", start);
    if (end < 0) return false;
    after = end + 2;
  } else {
    if (s[at + 1] === "$" || /\s/.test(s[at + 1] ?? " ")) return false;
    if (at > 0 && s[at - 1] === "\\") return false;
    start = at + 1;
    end = start;
    // The first unescaped $ closes it; one after a space opens the next instead ($5 and $6), so none.
    for (;;) {
      end = s.indexOf("$", end);
      if (end < 0) return false;
      if (s[end - 1] === "\\") {
        end++;
        continue;
      }
      if (/\s/.test(s[end - 1]!)) return false;
      break;
    }
    // `$5 and $6` is money: a closing $ followed by a digit isn't one.
    if (/\d/.test(s[end + 1] ?? "")) return false;
    after = end + 1;
  }
  if (end === start) return false;
  if (!silent) {
    const t = state.push("math_inline", "math", 0);
    t.content = s.slice(start, end);
  }
  state.pos = after;
  return true;
}

/** `$$` on a line of its own, then the formula, then `$$`. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (n: number) => state.src.slice(state.bMarks[n]! + state.tShift[n]!, state.eMarks[n]);
  const first = lineText(startLine);
  if (!first.startsWith("$$")) return false;
  const rest = first.slice(2);
  // One line: $$ x $$
  if (rest.trimEnd().endsWith("$$") && rest.trim().length > 2) {
    if (silent) return true;
    const t = state.push("math_block", "math", 0);
    t.content = rest.trimEnd().slice(0, -2);
    t.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }
  if (rest.trim()) return false;
  let line = startLine + 1;
  const body: string[] = [];
  for (; line < endLine; line++) {
    const text = lineText(line);
    if (text.trim() === "$$") break;
    body.push(text);
  }
  if (line >= endLine) return false;
  if (silent) return true;
  const t = state.push("math_block", "math", 0);
  t.content = body.join("\n");
  t.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}

function frontMatter(src: string): { body: string; front?: Rendered["front"] } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { body: src };
  const body = src.slice(m[0].length);
  try {
    const v = parseYaml(m[1]!, { maxAliasCount: 10 });
    if (v && typeof v === "object" && !Array.isArray(v))
      return { body, front: { pairs: Object.entries(v).slice(0, 50).map(([k, x]) => [k, typeof x === "string" ? x : JSON.stringify(x) ?? String(x)]) } };
  } catch {
    // Not YAML: shown as written.
  }
  return { body, front: { text: m[1]! } };
}

const isExternal = (href: string) => /^(https?:|mailto:)/i.test(href);

function build(opts: RenderOptions, out: { broken: string[]; headings: Heading[]; mermaid: number; math: number }) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  // Its types are for markdown-it 14's; the plugin works on 15 as it is.
  md.use(footnote as unknown as (md: Md) => void);
  const anchor = md.renderer.rules.footnote_anchor_name!;
  md.renderer.rules.footnote_anchor_name = (...a) => ID_PREFIX + anchor(...a);
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.after("blockquote", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules.math_inline = (tokens, i) => (out.math++, math(md, tokens[i]!.content, false));
  md.renderer.rules.math_block = (tokens, i) => (out.math++, math(md, tokens[i]!.content, true));

  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, i, o, env, self) => {
    const t = tokens[i]!;
    const lang = t.info.trim().split(/\s+/)[0]!.toLowerCase();
    if (lang === "math") return (out.math++, math(md, t.content, true));
    if (lang === "mermaid") return (out.mermaid++, `<pre class="md-mermaid">${md.utils.escapeHtml(t.content)}</pre>\n`);
    return fence(tokens, i, o, env, self);
  };

  // Headings get GitHub's ids, prefixed so they can't clash with the page's own.
  const seen = new Map<string, number>();
  md.core.ruler.push("md_headings", (state) => {
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.type !== "heading_open") continue;
      const text = toks[i + 1]?.children?.filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("") ?? "";
      const base = slug(text) || "section";
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      t.attrSet("id", ID_PREFIX + id);
      out.headings.push({ level: Number(t.tag.slice(1)), text, id: ID_PREFIX + id });
    }
  });

  // Task lists: a list item that starts with [ ] or [x].
  md.core.ruler.push("md_tasks", (state) => {
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.type !== "inline" || toks[i - 1]!.type !== "paragraph_open" || toks[i - 2]!.type !== "list_item_open") continue;
      const first = t.children?.[0];
      const m = first?.type === "text" ? /^\[([ xX])\][ \t]/.exec(first.content) : null;
      if (!m || !first) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="md-task" disabled${m[1] === " " ? "" : " checked"}> `;
      t.children!.unshift(box);
      toks[i - 2]!.attrJoin("class", "md-task-item");
    }
  });

  // Alerts: a quote whose first line is [!NOTE] (and the four others).
  md.core.ruler.push("md_alerts", (state) => {
    const toks = state.tokens;
    for (let i = 0; i + 2 < toks.length; i++) {
      if (toks[i]!.type !== "blockquote_open" || toks[i + 1]!.type !== "paragraph_open") continue;
      const inline = toks[i + 2]!;
      const kids = inline.children ?? [];
      const m = kids[0]?.type === "text" ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(kids[0].content) : null;
      if (!m) continue;
      const kind = m[1]!.toUpperCase();
      kids.splice(0, kids[1]?.type === "softbreak" ? 2 : 1);
      toks[i]!.attrJoin("class", `md-alert md-alert-${kind.toLowerCase()}`);
      toks[i]!.meta = { alert: ALERTS[kind] };
    }
  });
  md.renderer.rules.blockquote_open = (tokens, i, o, _env, self) => {
    const t = tokens[i]!;
    const title = (t.meta as { alert?: string } | null)?.alert;
    return self.renderToken(tokens, i, o) + (title ? `<p class="md-alert-title">${title}</p>\n` : "");
  };

  // Links: out to the web in a new tab, to a heading here, to a neighbour the caller resolves; else text.
  const skipped = new WeakSet<Token>();
  md.renderer.rules.link_open = (tokens, i, o, _env, self) => {
    const t = tokens[i]!;
    const href = String(t.attrGet("href") ?? "");
    if (isExternal(href)) {
      t.attrSet("target", "_blank");
      t.attrSet("rel", "noopener noreferrer");
      return self.renderToken(tokens, i, o);
    }
    if (href.startsWith("#")) {
      t.attrSet("href", "#" + ID_PREFIX + slug(decodeURIComponentSafe(href.slice(1))));
      return self.renderToken(tokens, i, o);
    }
    const r = opts.resolve?.(href, "link");
    if (r && !r.broken) {
      t.attrSet("href", r.href);
      return self.renderToken(tokens, i, o);
    }
    if (r?.broken) out.broken.push(href);
    // Not a link: its text stays, in a span saying why.
    const close = tokens.slice(i + 1).find((x) => x.type === "link_close" && x.level === t.level);
    if (close) skipped.add(close);
    return `<span class="${r?.broken ? "md-broken" : "md-nolink"}" title="${md.utils.escapeHtml(r?.broken ? `Not found: ${href}` : href)}">`;
  };
  md.renderer.rules.link_close = (tokens, i, o, _env, self) => (skipped.has(tokens[i]!) ? "</span>" : self.renderToken(tokens, i, o));

  // Images: a link to the picture (or its name), never loaded from where the document says.
  md.renderer.rules.image = (tokens, i) => {
    const t = tokens[i]!;
    const src = String(t.attrGet("src") ?? "");
    const alt = md.utils.escapeHtml(t.content || "image");
    const r = isExternal(src) || src.startsWith("data:") ? undefined : opts.resolve?.(src, "image");
    if (r && !r.broken) return `<img src="${md.utils.escapeHtml(r.href)}" alt="${alt}" loading="lazy">`;
    if (r?.broken) {
      out.broken.push(src);
      return `<span class="md-broken" title="Not found: ${md.utils.escapeHtml(src)}">[image: ${alt}]</span>`;
    }
    if (/^https?:/i.test(src)) return `<a class="md-img" href="${md.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">[image: ${alt}]</a>`;
    return `<span class="md-nolink" title="Images show only from a checkout's own files">[image: ${alt}]</span>`;
  };

  // Tables scroll on their own instead of widening the page.
  md.renderer.rules.table_open = () => `<div class="md-table"><table>\n`;
  md.renderer.rules.table_close = () => `</table></div>\n`;
  return md;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Renders a document. Over MAX_SOURCE characters, only the start is rendered. */
export function render(source: string, opts: RenderOptions = {}): Rendered {
  const src = source.length > MAX_SOURCE ? source.slice(0, MAX_SOURCE) : source;
  const { body, front } = frontMatter(src.replace(/\r\n?/g, "\n"));
  const out = { broken: [] as string[], headings: [] as Heading[], mermaid: 0, math: 0 };
  const html = build(opts, out).render(body);
  return { html, ...(front ? { front } : {}), ...out };
}
