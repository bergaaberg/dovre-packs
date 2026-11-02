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
const dark = () => /dark/.test(getComputedStyle(document.documentElement).colorScheme || "");
const draw = (doc) => Promise.all([tex(doc), diagrams(doc), dots(doc)]);
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
const dots = async (doc) => {
  const blocks = [...doc.querySelectorAll("pre.md-dot:not([data-drawn])")];
  const src = doc.dataset.graphviz;
  if (!blocks.length || !src) return;
  try { viz ??= import(src).then((m) => m.Graphviz.load()); await viz; } catch { viz = undefined; return; }
  const gv = await viz;
  for (const pre of blocks) {
    pre.dataset.drawn = "1";
    const text = pre.textContent || "";
    try {
      if (text.length > 20000) throw new Error("too big to draw here (20,000 characters at most)");
      const svg = cleanSvg(gv.dot(text, "svg"));
      if (!svg) throw new Error("no picture came out");
      const div = document.createElement("div");
      div.className = "md-diagram md-dot-drawn";
      div.append(svg);
      pre.replaceWith(div);
    } catch (e) {
      pre.classList.add("md-mermaid-bad");
      pre.title = "Graphviz couldn't draw this: " + String((e && e.message) || e).slice(0, 300);
    }
  }
};
const diagrams = async (doc) => {
  const blocks = [...doc.querySelectorAll("pre.md-mermaid:not([data-drawn])")];
  const src = doc.dataset.mermaid;
  if (!blocks.length || !src) return;
  try { await load(src); } catch { return; }
  const m = globalThis.mermaid;
  if (!m) return;
  m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "default", maxTextSize: 50000 });
  for (const pre of blocks) {
    pre.dataset.drawn = "1";
    try {
      const { svg } = await m.render("md-mermaid-" + ++n, pre.textContent || "");
      const div = document.createElement("div");
      div.className = "md-diagram";
      div.innerHTML = svg;
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

/** On every page while the pack is on; does something only where a rendered document or the editor is. */
export const SCRIPT = `
(() => {
  if (!document.querySelector("[data-md-doc], form[data-md-live]")) return;
${DRAW}
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
