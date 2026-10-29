// Code review's engine (ES module): reads a diff the way a reviewer does. Runs in the browser, on
// core's diff tables (a PR's Files tab, a checkout's Changes), and under Node in the tests.
// - Highlighting from tree-sitter (web-tree-sitter, WebAssembly), one grammar per language.
// - What changed, by token rather than by line: within each run of removed and added lines, the
//   old and new tokens are matched (longest common subsequence); unmatched ones are marked.
// - A run whose tokens all match changed only whitespace or layout: it folds to one row.
// Each hunk is parsed on its own (the old side and the new side), so no file is fetched; a hunk
// that starts inside a comment or string is highlighted a little wrong, never shown wrong.
// The DOM is only read as text and written with textContent: nothing from the diff becomes markup.

/** File extension → grammar name. */
export const EXT = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  go: "go", rs: "rust", py: "python", pyi: "python",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "toml", css: "css", cs: "csharp",
};

export function langOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path || "");
  return m ? EXT[m[1].toLowerCase()] : undefined;
}

/** A capture name (`keyword.return`, `string.special`) → one of a few classes; "" for none. */
const CLASSES = [
  [/^(comment)/, "c"],
  [/^(string|character|escape)/, "s"],
  [/^(number|float|boolean|constant)/, "n"],
  [/^(keyword|conditional|repeat|include|exception|storageclass)/, "k"],
  [/^(function|method|constructor)/, "f"],
  [/^(type|module|namespace)/, "t"],
  [/^(property|field|attribute|tag|label)/, "p"],
  [/^variable\.(builtin|parameter)/, "v"],
];
export function classOf(name) {
  for (const [re, c] of CLASSES) if (re.test(name)) return c;
  return "";
}
const CODES = ["", "c", "s", "n", "k", "f", "t", "p", "v"];

/** Highlight classes over `text` (length `len`), one per character, from a query's captures: inner wins, then the earlier pattern. */
export function paint(query, tree, len) {
  const out = new Uint8Array(len);
  if (!query || !tree) return out;
  const caps = query.captures(tree.rootNode).map((c) => ({ s: c.node.startIndex, e: c.node.endIndex, k: CODES.indexOf(classOf(c.name)), p: c.patternIndex ?? 0 }));
  caps.sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s) || b.p - a.p);
  for (const c of caps) if (c.k > 0) out.fill(c.k, Math.max(0, c.s), Math.min(len, c.e));
  return out;
}

const WORD = /\w+|[^\w\s]/g;
const PROSE = /comment|string|fragment|content|text|ERROR/;

/** The text's tokens ({ s, e, t }), in order: tree-sitter's leaves, words within comments and strings; by regex without a tree. */
export function tokensOf(tree, text) {
  const out = [];
  const words = (s, e) => {
    WORD.lastIndex = 0;
    const part = text.slice(s, e);
    for (let m; (m = WORD.exec(part)); ) out.push({ s: s + m.index, e: s + m.index + m[0].length, t: m[0] });
  };
  if (!tree) {
    words(0, text.length);
    return out;
  }
  const c = tree.walk();
  let at = 0;
  for (;;) {
    if (c.gotoFirstChild()) continue;
    const s = c.startIndex;
    const e = c.endIndex;
    if (e > s && s >= at) {
      if (s > at) words(at, s);
      const t = text.slice(s, e);
      if (PROSE.test(c.nodeType) || /\s/.test(t.trim())) words(s, e);
      else if (t.trim()) out.push({ s, e, t });
      at = e;
    }
    while (!c.gotoNextSibling()) {
      if (!c.gotoParent()) {
        if (at < text.length) words(at, text.length);
        return out;
      }
    }
  }
}

/** Which of `a` and `b` (strings) are kept by their longest common subsequence; too big to compare: none. */
export function lcs(a, b, cap = 2_000_000) {
  const keepA = new Array(a.length).fill(false);
  const keepB = new Array(b.length).fill(false);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) keepA[lo] = keepB[lo++] = true;
  let ha = a.length;
  let hb = b.length;
  // Shared endings only when the middle is too big otherwise: matching from the front keeps an
  // insertion's closing token where it was (`${repo}` + `?n=${n}`, not `${repo` + `}?n=${n}`).
  if ((ha - lo) * (hb - lo) > cap) while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) keepA[--ha] = keepB[--hb] = true;
  const n = ha - lo;
  const m = hb - lo;
  if (!n || !m || n * m > cap) return [keepA, keepB];
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[lo + i] === b[lo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[lo + i] === b[lo + j]) keepA[lo + i++] = keepB[lo + j++] = true;
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
  return [keepA, keepB];
}

/**
 * A diff's lines read as a reviewer would. `lines`: { kind: "hunk" | "ctx" | "add" | "del", text }
 * in order, removed lines before the added ones that replace them. `parse(text)`: a tree or
 * undefined; `query`: highlight queries or undefined. Returns, per line, `hl` (runs of [from, to,
 * class]) and `marks` ([from, to) of changed tokens), and the runs of changes (`blocks`: first and
 * last line index, and `layout` when only whitespace or layout changed).
 */
export function analyse(lines, parse, query) {
  const per = lines.map(() => ({ hl: [], marks: [] }));
  const blocks = [];
  const hunks = [];
  let cur = [];
  lines.forEach((l, i) => {
    if (l.kind === "hunk") {
      if (cur.length) hunks.push(cur);
      cur = [];
    } else if (l.kind === "ctx" || l.kind === "add" || l.kind === "del") cur.push(i);
  });
  if (cur.length) hunks.push(cur);
  for (const idx of hunks) {
    const sides = {};
    for (const side of ["old", "new"]) {
      const mine = idx.filter((i) => lines[i].kind === "ctx" || lines[i].kind === (side === "old" ? "del" : "add"));
      const at = new Map();
      let text = "";
      for (const i of mine) {
        if (text) text += "\n";
        at.set(i, text.length);
        text += lines[i].text;
      }
      let tree;
      try {
        tree = parse ? parse(text) : undefined;
      } catch {
        tree = undefined;
      }
      const colours = paint(query, tree, text.length);
      const toks = tokensOf(tree, text);
      tree?.delete?.();
      sides[side] = { at, text, colours, toks };
      // Highlighting: a ctx line from the new side, a removed line from the old.
      for (const i of mine) {
        if (side === "old" && lines[i].kind === "ctx") continue;
        const s = at.get(i);
        const len = lines[i].text.length;
        const runs = [];
        for (let k = 0; k < len; ) {
          const c = colours[s + k];
          let e = k + 1;
          while (e < len && colours[s + e] === c) e++;
          if (c) runs.push([k, e, CODES[c]]);
          k = e;
        }
        per[i].hl = runs;
      }
    }
    // Runs of changes: consecutive removed and added lines.
    for (let k = 0; k < idx.length; ) {
      if (lines[idx[k]].kind === "ctx") {
        k++;
        continue;
      }
      const run = [];
      while (k < idx.length && lines[idx[k]].kind !== "ctx") run.push(idx[k++]);
      const pick = (side, kind) => {
        const { at, toks } = sides[side];
        const out = [];
        for (const i of run) {
          if (lines[i].kind !== kind) continue;
          const s = at.get(i);
          const e = s + lines[i].text.length;
          for (const t of toks) if (t.s >= s && t.e <= e) out.push({ ...t, line: i, from: t.s - s, to: t.e - s });
        }
        return out;
      };
      const olds = pick("old", "del");
      const news = pick("new", "add");
      const [ka, kb] = lcs(olds.map((t) => t.t), news.map((t) => t.t));
      const mark = (toks, keep) => toks.forEach((t, j) => keep[j] || per[t.line].marks.push([t.from, t.to]));
      mark(olds, ka);
      mark(news, kb);
      blocks.push({ first: run[0], last: run[run.length - 1], layout: ka.every(Boolean) && kb.every(Boolean) });
    }
  }
  for (const p of per) p.marks = merge(p.marks);
  return { per, blocks };
}

/** Marks that touch or are only whitespace apart become one. */
function merge(marks) {
  const out = [];
  for (const m of marks.sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && m[0] <= last[1] + 1) last[1] = Math.max(last[1], m[1]);
    else out.push([...m]);
  }
  return out;
}

// ── In the browser ──────────────────────────────────────────────────────────

const kindOf = (el) => (el.classList.contains("d-add") ? "add" : el.classList.contains("d-del") ? "del" : el.classList.contains("d-ctx") ? "ctx" : undefined);

/** A code cell's text, without the sign core draws in front of it. */
function textOf(code) {
  let t = "";
  for (const n of code.childNodes) if (!(n.nodeType === 1 && n.classList.contains("d-sign"))) t += n.textContent;
  return t;
}

/** A table's lines (unified or side by side), each with the code cells that show it and the rows it sits in. */
export function linesOf(table) {
  const lines = [];
  const rows = [...table.tBodies[0]?.rows ?? []];
  const split = table.classList.contains("split");
  for (let r = 0; r < rows.length; ) {
    const tr = rows[r];
    if (tr.classList.contains("d-hunk")) {
      lines.push({ kind: "hunk", text: "", els: [], rows: [tr] });
      r++;
      continue;
    }
    if (!split) {
      const kind = kindOf(tr);
      const code = tr.querySelector(":scope > td.code > code");
      if (kind && code) lines.push({ kind, text: textOf(code), els: [code], rows: [tr] });
      else if (lines.length) lines[lines.length - 1].rows.push(tr);
      r++;
      continue;
    }
    const cells = [...tr.querySelectorAll(":scope > td.code")];
    if (cells.length === 2 && kindOf(cells[0]) === "ctx" && kindOf(cells[1]) === "ctx") {
      const [a, b] = cells.map((c) => c.querySelector("code"));
      lines.push({ kind: "ctx", text: textOf(b), els: [a, b], rows: [tr] });
      r++;
      continue;
    }
    if (cells.length !== 2) {
      r++;
      continue;
    }
    // A run of changed rows: removed lines on the left, added on the right.
    const dels = [];
    const adds = [];
    const runRows = [];
    while (r < rows.length) {
      const cs = [...rows[r].querySelectorAll(":scope > td.code")];
      if (cs.length !== 2 || (kindOf(cs[0]) === "ctx" && kindOf(cs[1]) === "ctx")) break;
      runRows.push(rows[r]);
      if (kindOf(cs[0]) === "del") dels.push(cs[0].querySelector("code"));
      if (kindOf(cs[1]) === "add") adds.push(cs[1].querySelector("code"));
      r++;
    }
    for (const el of dels) lines.push({ kind: "del", text: textOf(el), els: [el], rows: [] });
    for (const el of adds) lines.push({ kind: "add", text: textOf(el), els: [el], rows: [] });
    const firstOfRun = lines.length - dels.length - adds.length;
    if (lines[firstOfRun]) lines[firstOfRun].rows = runRows;
  }
  return lines;
}

/** Writes a line's text back as spans: highlight classes, changed tokens marked. */
export function draw(doc, el, text, hl, marks) {
  const sign = el.querySelector(":scope > .d-sign");
  const cuts = new Set([0, text.length]);
  for (const [s, e] of hl) cuts.add(s).add(e);
  for (const [s, e] of marks) cuts.add(s).add(e);
  const at = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  const frag = doc.createDocumentFragment();
  if (sign) frag.append(sign);
  for (let k = 0; k + 1 < at.length; k++) {
    const [s, e] = [at[k], at[k + 1]];
    const c = hl.find(([a, b]) => a <= s && e <= b)?.[2];
    const changed = marks.some(([a, b]) => a <= s && e <= b);
    const span = doc.createElement(changed ? "mark" : "span");
    if (c) span.className = `cr-${c}`;
    if (changed) span.classList.add("cr-x");
    span.textContent = text.slice(s, e);
    frag.append(span);
  }
  el.replaceChildren(frag);
}

/** Folds a run that changed only layout to one row that opens it. Not one with comments or threads in it. */
function fold(doc, table, rows, count) {
  if (!rows.length || rows.some((tr) => !tr.matches(".d-add, .d-del, tr:has(> td.code.d-add), tr:has(> td.code.d-del)"))) return false;
  const cols = [...rows[0].children].reduce((n, td) => n + (td.colSpan || 1), 0);
  const tr = doc.createElement("tr");
  tr.className = "cr-fold";
  const td = doc.createElement("td");
  td.colSpan = Math.max(cols, 3);
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "sm ghost";
  b.textContent = `Only whitespace or layout changed (${count} ${count === 1 ? "line" : "lines"}). Show`;
  b.addEventListener("click", () => {
    const open = rows[0].hidden;
    for (const r of rows) r.hidden = !open;
    b.textContent = open ? "Hide the whitespace and layout changes" : `Only whitespace or layout changed (${count} ${count === 1 ? "line" : "lines"}). Show`;
  });
  td.append(b);
  tr.append(td);
  rows[0].before(tr);
  for (const r of rows) r.hidden = true;
  return true;
}

/** Upgrades one diff table in place. `ts`: { parser(lang), query(lang) } or undefined (no grammar: tokens by regex). */
export async function upgrade(doc, table, path, ts) {
  const lines = linesOf(table);
  if (!lines.length || lines.length > 6000) return;
  const lang = langOf(path);
  const parser = lang && ts ? await ts.parser(lang).catch(() => undefined) : undefined;
  const query = lang && ts ? await ts.query(lang).catch(() => undefined) : undefined;
  const { per, blocks } = analyse(lines, parser ? (t) => parser.parse(t) : undefined, query);
  lines.forEach((l, i) => {
    if (l.kind === "hunk") return;
    for (const el of l.els) draw(doc, el, l.text, per[i].hl, per[i].marks);
  });
  let folded = 0;
  for (const b of blocks) {
    if (!b.layout) continue;
    const rows = table.classList.contains("split") ? lines[b.first].rows : lines.slice(b.first, b.last + 1).flatMap((l) => l.rows);
    if (fold(doc, table, rows, b.last - b.first + 1)) folded++;
  }
  if (blocks.length && folded === blocks.length) {
    const meta = table.closest("details.dfile")?.querySelector(".dfile-meta");
    if (meta && !meta.querySelector(".cr-only")) {
      const s = doc.createElement("span");
      s.className = "cr-only";
      s.textContent = "whitespace and layout only";
      meta.prepend(s);
    }
  }
  table.dataset.cr = lang ?? "plain";
}

/** web-tree-sitter, loaded once, and each grammar when a diff first needs it. */
function loader(manifest) {
  let rt;
  const parsers = new Map();
  const queries = new Map();
  const runtime = () =>
    (rt ??= import(manifest.runtimeJs).then(async (m) => {
      await m.Parser.init({ locateFile: () => manifest.runtimeWasm });
      return m;
    }));
  const language = (lang) => {
    const g = manifest.langs[lang];
    if (!g) return Promise.reject(new Error(`no grammar for ${lang}`));
    return runtime().then((m) => m.Language.load(g.wasm).then((l) => ({ m, l })));
  };
  return {
    parser: (lang) =>
      parsers.get(lang) ??
      parsers.set(lang, language(lang).then(({ m, l }) => {
        const p = new m.Parser();
        p.setLanguage(l);
        return p;
      })).get(lang),
    query: (lang) =>
      queries.get(lang) ??
      queries.set(lang, language(lang).then(async ({ m, l }) => new m.Query(l, await (await fetch(manifest.langs[lang].query)).text()))).get(lang),
  };
}

/** Upgrades every diff table on the page as it comes into view, and those a live update brings. */
export function start(doc, manifestUrl) {
  let ts;
  const tsOf = () => (ts ??= fetch(manifestUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(loader, () => undefined));
  const seen = new WeakSet();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const path = e.target.closest("details.dfile")?.dataset.stopLabel ?? "";
        tsOf().then((t) => upgrade(doc, e.target, path, t)).catch(() => undefined);
      }
    },
    { rootMargin: "600px 0px" },
  );
  const scan = () => {
    for (const t of doc.querySelectorAll("table.diff:not([data-cr])")) {
      if (seen.has(t)) continue;
      seen.add(t);
      io.observe(t);
    }
  };
  scan();
  new MutationObserver(scan).observe(doc.body, { childList: true, subtree: true });
}

