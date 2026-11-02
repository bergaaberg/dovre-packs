/**
 * Markdown (`markdown`): the browser side. It only adds to pages that work without it.
 * - Draws math in a rendered document ([data-md-doc]) as MathML, loading KaTeX (Pack.files) the
 *   first time a formula needs it: `katex.render` builds the elements itself (no markup is parsed),
 *   with `trust` off and its size and macro limits low. Without script, a formula is its TeX.
 * - Draws `mermaid` blocks there, loading mermaid (Pack.files) the first time one needs it, with
 *   `securityLevel: "strict"` (its own DOMPurify pass, no clicks or scripts in a diagram). A block
 *   mermaid can't draw stays as its source, saying why.
 * - Draws `dot` blocks with Graphviz (Pack.files, an ES module with its WebAssembly inside), and
 *   keeps only shapes and text of the SVG it makes (cleanSvg): no links, pictures or scripts.
 * - Draws the same blocks in core's Markdown on any page (Bino's answers, PR and issue bodies):
 *   a closed fence core marks `mermaid`, `dot` or `graphviz` (`.md pre.code[data-lang]`), with the
 *   libraries' paths from `dovreFiles`. A diagram is kept by its source, so a live region swapped
 *   in again (an answer being written) shows it at once instead of drawing it anew.
 * - The editor: a preview rendered on the server as I type, a file opened from this computer
 *   (read here, never uploaded as a file), and Export with the math and diagrams drawn in.
 * - The print page: prints once its math and diagrams are drawn.
 */
import { DOC_CSS } from "./view.ts";

const DRAW = `
const loads = new Map();
const load = (src) => {
  if (!loads.has(src)) loads.set(src, new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.append(s); }));
  return loads.get(src);
};
const KATEX = { output: "mathml", throwOnError: false, trust: false, strict: "ignore", maxSize: 50, maxExpand: 500 };
const tex = async (doc) => {
  const els = [...doc.querySelectorAll(".md-tex")];
  const src = doc.dataset.katex;
  if (!els.length || !src) return;
  try { await load(src); } catch { return; }
  const k = globalThis.katex;
  if (!k) return;
  for (const el of els) {
    const display = el.hasAttribute("data-display");
    const out = document.createElement(display ? "div" : "span");
    try {
      k.render(el.textContent || "", out, { ...KATEX, displayMode: display });
      el.replaceWith(out);
    } catch {}
  }
};
let n = 0;
// Drawn diagrams by their source, to put back at once when the same block comes again.
const drawn = new Map();
const keyOf = (kind, pre) => kind + (kind === "mermaid" && dark() ? ":dark" : "") + "\\n" + (pre.textContent || "");
const keep = (key, div) => { if (drawn.size >= 50) drawn.delete(drawn.keys().next().value); drawn.set(key, div.cloneNode(true)); };
const reuse = (kind, pre) => {
  const div = drawn.get(keyOf(kind, pre));
  if (!div) return false;
  pre.replaceWith(div.cloneNode(true));
  return true;
};
const dark = () => /dark/.test(getComputedStyle(document.documentElement).colorScheme || "");
const draw = (doc) => Promise.all([tex(doc), diagrams(doc, doc.dataset.mermaid), dots(doc, doc.dataset.graphviz)]);
// Graphviz's SVG holds only shapes and text: no links (URL/href), pictures (image), scripts,
// foreign objects, styles or event handlers, and fills only from its own gradients.
const SVG_KEEP = new Set(["svg", "g", "path", "polygon", "polyline", "ellipse", "circle", "rect", "line", "text", "tspan", "title", "defs", "lineargradient", "radialgradient", "stop"]);
const SVG_ATTRS = new Set(["id", "class", "width", "height", "viewbox", "transform", "d", "points", "cx", "cy", "rx", "ry", "r", "x", "y", "x1", "y1", "x2", "y2", "dx", "dy", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "preserveaspectratio"]);
const cleanSvg = (text) => {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.querySelector("parsererror")) return null;
  const walk = (el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase(), v = a.value;
      if (!SVG_ATTRS.has(n) || /url\\(\\s*['"]?(?!#)/i.test(v) || /javascript:|expression\\(/i.test(v)) el.removeAttribute(a.name);
    }
    for (const c of [...el.children]) {
      const n = c.localName.toLowerCase();
      if (n === "a") { const g = doc.createElementNS("http://www.w3.org/2000/svg", "g"); g.append(...c.childNodes); c.replaceWith(g); walk(g); }
      else if (SVG_KEEP.has(n)) walk(c);
      else c.remove();
    }
  };
  walk(root);
  return document.importNode(root, true);
};
let viz;
const dots = async (doc, src) => {
  const blocks = [...doc.querySelectorAll("pre.md-dot:not([data-drawn])")].filter((pre) => !reuse("dot", pre));
  if (!blocks.length || !src) return;
  for (const pre of blocks) pre.dataset.drawn = "1";
  try { viz ??= import(src).then((m) => m.Graphviz.load()); await viz; } catch { viz = undefined; return; }
  const gv = await viz;
  for (const pre of blocks) {
    const text = pre.textContent || "";
    try {
      if (text.length > 20000) throw new Error("too big to draw here (20,000 characters at most)");
      const svg = cleanSvg(gv.dot(text, "svg"));
      if (!svg) throw new Error("no picture came out");
      const div = document.createElement("div");
      div.className = "md-diagram md-dot-drawn";
      div.append(svg);
      keep(keyOf("dot", pre), div);
      pre.replaceWith(div);
    } catch (e) {
      pre.classList.add("md-mermaid-bad");
      pre.title = "Graphviz couldn't draw this: " + String((e && e.message) || e).slice(0, 300);
    }
  }
};
const diagrams = async (doc, src) => {
  const blocks = [...doc.querySelectorAll("pre.md-mermaid:not([data-drawn])")].filter((pre) => !reuse("mermaid", pre));
  if (!blocks.length || !src) return;
  for (const pre of blocks) pre.dataset.drawn = "1";
  try { await load(src); } catch { return; }
  const m = globalThis.mermaid;
  if (!m) return;
  m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "default", maxTextSize: 50000 });
  for (const pre of blocks) {
    try {
      const { svg } = await m.render("md-mermaid-" + ++n, pre.textContent || "");
      const div = document.createElement("div");
      div.className = "md-diagram";
      div.innerHTML = svg;
      keep(keyOf("mermaid", pre), div);
      pre.replaceWith(div);
    } catch (e) {
      document.getElementById("md-mermaid-" + n)?.remove();
      document.getElementById("dmd-mermaid-" + n)?.remove();
      pre.classList.add("md-mermaid-bad");
      pre.title = "Mermaid couldn't draw this: " + String((e && e.message) || e).slice(0, 300);
    }
  }
};
const drawAll = () => Promise.all([...document.querySelectorAll("[data-md-doc]")].map(draw));
`;

/** Core's Markdown (src/ui/markdown.ts in dovre): its closed fences carry their language. */
const CORE = `
const FILES = typeof dovreFiles === "object" && dovreFiles ? dovreFiles : {};
const KINDS = { mermaid: "md-mermaid", dot: "md-dot", graphviz: "md-dot" };
const mark = (root) => {
  for (const pre of root.querySelectorAll(".md pre.code[data-lang]:not(.md-mermaid):not(.md-dot)")) {
    const kind = KINDS[pre.dataset.lang];
    if (kind && !pre.closest("[data-md-doc]")) pre.classList.add(kind);
  }
};
const drawCore = () => {
  mark(document);
  if (!document.querySelector(".md pre.md-mermaid:not([data-drawn]), .md pre.md-dot:not([data-drawn])")) return;
  for (const md of document.querySelectorAll(".md")) if (!md.closest("[data-md-doc]")) { diagrams(md, FILES["mermaid.js"]); dots(md, FILES["graphviz.js"]); }
};
// A live region about to be swapped in: put back what was drawn before it shows.
document.addEventListener("dovre:swap", (e) => {
  const to = e.detail && e.detail.to;
  if (!to || !to.querySelectorAll) return;
  mark(to);
  for (const pre of to.querySelectorAll(".md pre.md-mermaid, .md pre.md-dot")) reuse(pre.classList.contains("md-mermaid") ? "mermaid" : "dot", pre);
});
let frame = 0;
new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(drawCore); }).observe(document.body, { childList: true, subtree: true });
drawCore();
`;

/** On every page while the pack is on; does something only where a rendered document, the editor or a diagram in core's Markdown is. */
export const SCRIPT = `
(() => {
${DRAW}
${CORE}
  if (!document.querySelector("[data-md-doc], form[data-md-live]")) return;
  const CSS = ${JSON.stringify(DOC_CSS)};
  const form = document.querySelector("form[data-md-live]");
  const out = document.querySelector("[data-md-preview]");
  if (form && out) {
    const ta = form.querySelector("textarea[name=src]");
    let timer, seq = 0, shown = ta.value;
    const update = async () => {
      const my = ++seq, text = ta.value;
      try {
        const r = await fetch("/markdown/preview", { method: "POST", body: new URLSearchParams({ src: text }) });
        if (!r.ok || my !== seq) return;
        out.innerHTML = await r.text();
        shown = text;
        await drawAll();
      } catch {}
    };
    ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(update, 300); });
    form.querySelector("[data-md-open]")?.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f || f.size > 1048576) return;
      f.text().then((x) => { ta.value = x; update(); });
    });
    // Export with the math and diagrams as drawn; without this script the server's export has their source.
    form.querySelector("[data-md-export]")?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (shown !== ta.value) await update();
      await drawAll();
      const doc = out.querySelector("[data-md-doc]");
      if (!doc) return;
      const title = (doc.querySelector("h1, h2")?.textContent || "Document").trim().slice(0, 120);
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      const page = "<!doctype html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\"><meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\"><title>" + esc(title) + "</title><style>" + CSS + "</style></head><body><article><div class=\\"md-body\\">" + doc.innerHTML + "</div></article></body></html>";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      a.download = (title.replace(/[^\\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "document") + ".html";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
  }
  drawAll();
})();`;

/** The print page's own script (it isn't a Dovre page, so the pack script isn't on it). */
export const PRINT_JS = `
(() => {
${DRAW}
  drawAll().finally(() => setTimeout(() => window.print(), 50));
})();`;
