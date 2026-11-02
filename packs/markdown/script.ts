/**
 * Markdown (`markdown`): the browser side. It only adds to pages that work without it.
 * - Draws `mermaid` blocks in a rendered document ([data-md-doc]), loading mermaid (Pack.files)
 *   the first time one needs it, with `securityLevel: "strict"` (its own DOMPurify pass, no clicks
 *   or scripts in a diagram). A block mermaid can't draw stays as its source, saying why.
 * - The editor: a preview rendered on the server as I type, a file opened from this computer
 *   (read here, never uploaded as a file), and Export with the diagrams drawn in.
 * - The print page: prints once its diagrams are drawn.
 */
import { DOC_CSS } from "./view.ts";

const DRAW = `
const loads = new Map();
const load = (src) => {
  if (!loads.has(src)) loads.set(src, new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.append(s); }));
  return loads.get(src);
};
let n = 0;
const dark = () => /dark/.test(getComputedStyle(document.documentElement).colorScheme || "");
const draw = async (doc) => {
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
    // Export with the diagrams as drawn; without this script the server's export has their source.
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
