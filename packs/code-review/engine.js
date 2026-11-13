// Code review's engine (ES module): reads a diff the way a reviewer does. Runs in the browser, on
// core's diff tables (a PR's Files tab, a checkout's Changes), and under Node in the tests.
// - Highlighting from tree-sitter (web-tree-sitter, WebAssembly), one grammar per language.
// - What changed, by token rather than by line: within each run of removed and added lines, the
//   old and new tokens are matched (longest common subsequence); unmatched ones are marked.
// - A run whose tokens all match changed only whitespace or layout: it folds to one row.
// - The functions, classes and methods the changes touch, named in the file's header.
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

// ── Changed symbols (dovre#300) ─────────────────────────────────────────────
// Which functions, classes and methods a file's changes touch, from the hunks alone (no file is
// read): each side of a hunk is parsed and its definitions found with the grammar's tags.scm; a
// changed line belongs to the innermost one around it. A change whose definition starts above the
// hunk belongs to the one git names in the hunk's header (`@@ -1,4 +1,5 @@ function start(…) {`),
// until the hunk reaches code at the top level.

/** A line that can start code at the top level: not indented, not blank, not a closing bracket. */
const TOP = /^[^\s})\]]/;

/** The definitions in a tree of `rows` (its text's lines): { name, kind, from, to (rows), span }. */
function defsOf(tags, tree, rows) {
  const out = [];
  for (const m of tags.matches(tree.rootNode)) {
    const d = m.captures.find((c) => c.name.startsWith("definition."));
    const n = m.captures.find((c) => c.name === "name");
    if (!d || !n || !n.node.text) continue;
    const from = d.node.startPosition.row;
    // A constant only on an unindented line: a hunk's text is parsed on its own, so a function's body can read as one.
    if (d.name === "definition.constant" && !TOP.test(rows[from] ?? "")) continue;
    out.push({ name: n.node.text, kind: d.name.slice(11), from, to: d.node.endPosition.row, span: d.node.endIndex - d.node.startIndex });
  }
  return out;
}

/** A definition named by its keyword, for a header git cut short: `export function createApp(env: Env, deps: {`. */
const NAMED = /\b(function\*?|class|interface|type|enum|struct|trait|impl|def|fn|func(?:\s*\([^)]*\))?|module|namespace)\s+([A-Za-z_$][\w$]*)/;
const KIND = { def: "function", fn: "function", func: "function", namespace: "module" };

/** Definitions that hold others: inside them, the inner one is named (a method, not its class). */
const HOLDS = new Set(["class", "interface", "module", "impl", "trait"]);

/**
 * The definition a row belongs to: going inward from the outermost around it, the first that isn't
 * a class or module, so a method is named but not a helper inside a function. Of two the same size,
 * not the constant (a `const f = () => …` is a function).
 */
function around(defs, row) {
  const outIn = defs.filter((d) => d.from <= row && row <= d.to).sort((a, b) => b.span - a.span || (a.kind === "constant") - (b.kind === "constant"));
  let pick;
  for (const d of outIn) {
    if (pick && !HOLDS.has(pick.kind)) break;
    if (!pick || d.span < pick.span) pick = d;
  }
  return pick;
}

/** The definition git names in a hunk's header, if it reads as one. It's one line: closed so it parses. */
export function headerSymbol(header, parse, tags) {
  const ctx = /^@@ [^@]*@@ ?(.*)$/.exec(header ?? "")?.[1]?.trim();
  if (!ctx) return undefined;
  for (const text of [ctx, `${ctx}\n}`, `${ctx}\n  pass`, `${ctx}\``]) {
    let tree;
    try {
      tree = parse(text);
    } catch {
      continue;
    }
    const d = tree ? around(defsOf(tags, tree, text.split("\n")).filter((x) => x.from === 0), 0) : undefined;
    tree?.delete?.();
    if (d) return d;
  }
  const m = NAMED.exec(ctx);
  if (!m) return undefined;
  const word = m[1].replace(/\*$/, "").replace(/^func\s*\(.*$/, "method");
  return { name: m[2], kind: KIND[word] ?? word, from: 0, to: 0, span: 0 };
}

/**
 * The symbols a diff's changes touch, in the order they first change: { name, kind, line } (the
 * index of their first changed line). `lines`: as analyse's; `skip`: indices of lines not to count
 * (a run that changed only layout).
 */
export function symbols(lines, parse, tags, skip = new Set()) {
  const found = new Map();
  let header;
  let hunk = [];
  const flush = () => {
    if (!hunk.length) return;
    const head = header ? headerSymbol(header, parse, tags) : undefined;
    for (const side of ["old", "new"]) {
      const mine = hunk.filter((i) => lines[i].kind === "ctx" || lines[i].kind === (side === "old" ? "del" : "add"));
      const rows = mine.map((i) => lines[i].text);
      let tree;
      try {
        tree = parse(rows.join("\n"));
      } catch {
        tree = undefined;
      }
      const defs = tree ? defsOf(tags, tree, rows) : [];
      // Rows where code at the top level starts: a definition on an unindented line, or unindented
      // code that parsed whole. A string's unindented line that reads as code (CSS's `.a { color:
      // red; }` is a JavaScript block) counts too: it then belongs to nothing.
      const tops = new Set(defs.filter((d) => TOP.test(rows[d.from] ?? "")).map((d) => d.from));
      for (const c of tree?.rootNode.children ?? []) if (c.startPosition.column === 0 && !c.hasError) tops.add(c.startPosition.row);
      tree?.delete?.();
      let top = false;
      mine.forEach((i, row) => {
        if (tops.has(row) && TOP.test(lines[i].text)) top = true;
        if (lines[i].kind === "ctx" || skip.has(i)) return;
        const d = around(defs, row) ?? (top ? undefined : head);
        if (!d) return;
        const key = symbolLabel(d);
        const was = found.get(key);
        if (!was || i < was.line) found.set(key, { name: d.name, kind: d.kind, line: i });
      });
    }
    hunk = [];
  };
  lines.forEach((l, i) => {
    if (l.kind === "hunk") {
      flush();
      header = l.text;
    } else if (l.kind === "ctx" || l.kind === "add" || l.kind === "del") hunk.push(i);
  });
  flush();
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** How a symbol is named in a file's header: `start()`, `class Foo`, `MAX`. */
export function symbolLabel({ name, kind }) {
  if (kind === "function" || kind === "method") return `${name}()`;
  if (kind === "macro") return `${name}!`;
  return ["class", "interface", "type", "enum", "module", "struct", "trait", "impl"].includes(kind) ? `${kind} ${name}` : name;
}

// ── Only formatting (dovre#301) ─────────────────────────────────────────────
// A file whose two sides come out the same from one formatter changed only formatting. The
// formatter (dprint) is a normaliser here, never the repo's style: its settings below only make
// more layouts agree. The old side isn't read: it's rebuilt from the new one and the diff's hunks.

/** File extension → formatter: a dprint plugin, or Ruff (python). */
export const FMT = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "typescript", mjs: "typescript", cjs: "typescript", jsx: "typescript",
  json: "json", jsonc: "json", toml: "toml", md: "markdown", markdown: "markdown",
  css: "css", scss: "css", less: "css",
  py: "python", pyi: "python",
};

export function fmtOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path || "");
  return m ? FMT[m[1].toLowerCase()] : undefined;
}

/** dprint's settings: one quote style, always semicolons, and a line kept to one when it fits, so two layouts of the same code agree. */
export const FMT_GLOBAL = { indentWidth: 2, lineWidth: 100, useTabs: false, newLineKind: "lf" };
export const FMT_CONFIG = {
  typescript: { quoteStyle: "alwaysDouble", semiColons: "always", trailingCommas: "onlyMultiLine", preferSingleLine: true, "arrowFunction.useParentheses": "force", "module.sortImportDeclarations": "maintain", "importDeclaration.sortNamedImports": "maintain", "exportDeclaration.sortNamedExports": "maintain" },
  json: { preferSingleLine: true, trailingCommas: "never" },
  toml: {},
  markdown: {},
  css: {},
  // Ruff's settings (ruff.toml's, as JSON): a trailing comma doesn't keep a list open.
  python: { "line-length": 100, format: { "skip-magic-trailing-comma": true, "quote-style": "double", "indent-style": "space" } },
};

/**
 * A file's old side from its new side and its diff's lines (linesOf: hunk headers, then ctx, del
 * and add lines in order). Undefined when they don't agree: a line the diff shows isn't where its
 * hunk says, the hunks go backwards, or a header doesn't read.
 */
export function rebuildOld(newText, lines) {
  const neu = newText.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let at = 0;
  let seen = false;
  for (let i = 0; i < lines.length; ) {
    const l = lines[i++];
    if (l.kind !== "hunk") {
      if (l.kind === "ctx" || l.kind === "add" || l.kind === "del") return undefined;
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l.text);
    if (!m) return undefined;
    seen = true;
    // A hunk with no lines on the new side names the line before it.
    const from = m[2] === "0" ? Number(m[1]) : Number(m[1]) - 1;
    if (from < at || from > neu.length) return undefined;
    for (; at < from; at++) out.push(neu[at]);
    for (; i < lines.length && lines[i].kind !== "hunk"; i++) {
      const x = lines[i];
      if (x.kind === "ctx" || x.kind === "add") {
        if (neu[at] !== x.text) return undefined;
        at++;
      }
      if (x.kind === "ctx" || x.kind === "del") out.push(x.text);
    }
  }
  if (!seen) return undefined;
  for (; at < neu.length; at++) out.push(neu[at]);
  return out.join("\n");
}

/** A text as the formatter prints it, line ends as LF. `format(text)` throws on what it can't parse; so does this. */
const formatted = (format, t) => format(t.replace(/\r\n/g, "\n")).replace(/\r\n/g, "\n");
/** What two formatted texts are compared on: blank lines count only in Markdown. */
const normal = (kind, s) => (kind === "markdown" ? s.trimEnd() : s.split("\n").filter((l) => l.trim()).join("\n"));

/** Whether two texts are the same once formatted. Throws on what the formatter can't parse. */
export function sameFormatted(format, kind, oldText, newText) {
  return normal(kind, formatted(format, oldText)) === normal(kind, formatted(format, newText));
}

/**
 * The diff of two formatted texts, as diff lines (hunk headers, then ctx, del and add lines, three
 * lines of context): what changed besides formatting. Outside Markdown a blank line is never a
 * change: one removed is dropped, one added is shown as context. Undefined when the two are too far
 * apart to compare.
 */
export function logicDiff(kind, oldText, newText, context = 3, cap = 2_000_000) {
  const linesIn = (t) => (t ? t.replace(/\n$/, "").split("\n") : []);
  const a = linesIn(oldText);
  const b = linesIn(newText);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ha = a.length;
  let hb = b.length;
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) ha--, hb--;
  if ((ha - lo) * (hb - lo) > cap) return undefined;
  const [keepA, keepB] = lcs(a, b, cap);
  const blank = (t) => kind !== "markdown" && !t.trim();
  // Removed lines before the added ones that replace them, each run where it sits in both sides.
  const all = [];
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (i < a.length && j < b.length && keepA[i] && keepB[j]) {
      all.push({ kind: "ctx", text: b[j], o: i++, n: j++ });
      continue;
    }
    for (; i < a.length && !keepA[i]; i++) if (!blank(a[i])) all.push({ kind: "del", text: a[i], o: i, n: j });
    for (; j < b.length && !keepB[j]; j++) all.push(blank(b[j]) ? { kind: "ctx", text: b[j], o: i, n: j, onlyNew: true } : { kind: "add", text: b[j], o: i, n: j });
  }
  const changed = all.map((l, k) => (l.kind !== "ctx" ? k : -1)).filter((k) => k >= 0);
  const out = [];
  for (let c = 0; c < changed.length; ) {
    const from = Math.max(0, changed[c] - context);
    let to = changed[c];
    for (; c < changed.length && changed[c] <= to + 2 * context; c++) to = changed[c];
    to = Math.min(all.length - 1, to + context);
    const run = all.slice(from, to + 1);
    const inOld = (l) => l.kind !== "add" && !l.onlyNew;
    const olds = run.filter(inOld).length;
    const news = run.filter((l) => l.kind !== "del").length;
    // A side with no lines in the hunk names the line before it.
    const o = olds ? run.find(inOld).o + 1 : run[0].o;
    const n = news ? run.find((l) => l.kind !== "del").n + 1 : run[0].n;
    out.push({ kind: "hunk", text: `@@ -${o},${olds} +${n},${news} @@` });
    for (const l of run) out.push({ kind: l.kind, text: l.text });
  }
  return out;
}

/**
 * Whether one file of a diff changed only formatting: "same", "more" (it changed more), or
 * "unknown" with why. With "more", `logic`: the diff of the two sides formatted (logicDiff), when
 * it has fewer changed lines than the diff itself. `newText`: the file's new side; `format(kind)`: a promise of (text, path)
 * => formatted, for a dprint plugin.
 */
export async function onlyFormatting(path, newText, lines, format) {
  const kind = fmtOf(path);
  if (!kind) return { verdict: "unknown", why: "No formatter for this kind of file." };
  const old = rebuildOld(newText, lines);
  if (old === undefined) return { verdict: "unknown", why: "The diff doesn't match the file as it is now." };
  let fmt;
  try {
    fmt = await format(kind);
  } catch {
    return { verdict: "unknown", why: "The formatter didn't load." };
  }
  let a;
  let b;
  try {
    a = formatted((t) => fmt(t, path), old);
    b = formatted((t) => fmt(t, path), newText);
  } catch {
    return { verdict: "unknown", why: "The formatter couldn't read one of its sides." };
  }
  if (normal(kind, a) === normal(kind, b)) return { verdict: "same" };
  // What changed besides formatting, when that's less than the diff shows.
  const logic = logicDiff(kind, a, b);
  const count = (ls) => ls.filter((l) => l.kind === "add" || l.kind === "del").length;
  return logic && count(logic) < count(lines) ? { verdict: "more", logic } : { verdict: "more" };
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
      // Its header ("@@ -1,4 +1,5 @@"): where the hunk sits, for rebuilding a file's old side.
      lines.push({ kind: "hunk", text: tr.querySelector("td.code > code")?.textContent ?? "", els: [], rows: [tr] });
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

/** Upgrades one diff table in place. `ts`: { parser(lang), query(lang), tags(lang) } or undefined (no grammar: tokens by regex). */
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
  const details = table.closest("details.dfile");
  const tags = parser && details && !table.classList.contains("cr-logic") ? await Promise.resolve(ts.tags?.(lang)).catch(() => undefined) : undefined;
  if (tags) {
    const skip = new Set(blocks.filter((b) => b.layout).flatMap((b) => lines.slice(b.first, b.last + 1).map((_, k) => b.first + k)));
    showSymbols(doc, details, lines, symbols(lines, (t) => parser.parse(t), tags, skip));
  }
  table.dataset.cr = lang ?? "plain";
}

/** At most this many symbols are named in a file's header; the rest are counted. */
const SHOWN = 4;

/** Names in a file's header what its changes touch; pressing one goes to its first change. */
export function showSymbols(doc, details, lines, syms) {
  const meta = details.querySelector(".dfile-meta");
  if (!meta || !syms.length || meta.querySelector(".cr-syms")) return;
  const wrap = doc.createElement("span");
  wrap.className = "cr-syms";
  wrap.title = `Changes in ${syms.map(symbolLabel).join(", ")}`;
  const lead = doc.createElement("span");
  lead.className = "cr-syms-in";
  lead.textContent = "in";
  wrap.append(lead);
  for (const s of syms.slice(0, SHOWN)) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "cr-sym";
    b.textContent = symbolLabel(s);
    b.title = `Goes to the first change in ${symbolLabel(s)}`;
    b.addEventListener("click", (e) => {
      // It sits in the file's <summary>: pressing it mustn't open or close the file.
      e.preventDefault();
      details.open = true;
      // A row in a folded run: the fold's row, the first one shown above it.
      let at = lines[s.line]?.els[0]?.closest("tr");
      while (at?.hidden) at = at.previousElementSibling;
      if (!at) return;
      at.scrollIntoView({ block: "center" });
      at.classList.add("cr-here");
      setTimeout(() => at.classList.remove("cr-here"), 1600);
    });
    wrap.append(b);
  }
  if (syms.length > SHOWN) {
    const more = doc.createElement("span");
    more.className = "cr-syms-in";
    more.textContent = `+${syms.length - SHOWN}`;
    wrap.append(more);
  }
  meta.prepend(wrap);
}

/** web-tree-sitter, loaded once, and each grammar when a diff first needs it. */
function loader(manifest) {
  let rt;
  const parsers = new Map();
  const queries = new Map();
  const tagQueries = new Map();
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
    // Definition queries (tags.scm): only for a grammar that has them.
    tags: (lang) =>
      tagQueries.get(lang) ??
      tagQueries.set(lang, manifest.langs[lang]?.tags ? language(lang).then(async ({ m, l }) => new m.Query(l, await (await fetch(manifest.langs[lang].tags)).text())) : Promise.reject(new Error(`no tags for ${lang}`))).get(lang),
  };
}

/** dprint's host, loaded once, and each plugin (or Ruff) when a file first needs it: kind → a promise of (text, path) => formatted. */
function formatters(fmt) {
  let host;
  const made = new Map();
  return (kind) => {
    if (!fmt?.plugins?.[kind]) return Promise.reject(new Error(`no formatter for ${kind}`));
    if (kind === "python" && !made.has(kind)) {
      if (!fmt.ruff) return Promise.reject(new Error("no formatter for python"));
      made.set(kind, import(fmt.ruff).then(async (m) => {
        await m.default({ module_or_path: fmt.plugins.python });
        const w = new m.Workspace(FMT_CONFIG.python);
        return (text) => w.format(text);
      }));
    }
    if (!made.has(kind))
      made.set(kind, (host ??= import(fmt.js)).then(async (m) => {
        const f = await m.createStreaming(fetch(fmt.plugins[kind]));
        f.setConfig(FMT_GLOBAL, FMT_CONFIG[kind] ?? {});
        return (text, path) => f.formatText({ filePath: path, fileText: text });
      }));
    return made.get(kind);
  };
}

/** A file's status as core's pill says it ("added", "removed", "modified", "renamed"). */
const statusOf = (details) => details.querySelector(".dfile-name .pill")?.textContent?.trim() ?? "";

/** Says on a file that it changed only formatting, and closes it unless someone has said something on it. */
function markSame(doc, details) {
  const meta = details.querySelector(".dfile-meta");
  if (meta && !meta.querySelector(".cr-only")) {
    const s = doc.createElement("span");
    s.className = "cr-only";
    s.textContent = "formatting only";
    meta.prepend(s);
  }
  if (!details.querySelector(".pr-thread, summary .spark")) details.open = false;
}

/**
 * A unified diff table, as core draws one, of diff lines (logicDiff's). No line numbers: they'd be
 * of the formatted text, not the file.
 */
export function logicTable(doc, lines) {
  const table = doc.createElement("table");
  table.className = "diff cr-logic";
  const body = doc.createElement("tbody");
  const row = (cls, ...cells) => {
    const tr = doc.createElement("tr");
    tr.className = cls;
    tr.append(doc.createElement("td"), doc.createElement("td"), ...cells);
    for (const td of tr.children) if (td.tagName === "TD" && !td.className) td.className = "ln";
    body.append(tr);
    return tr;
  };
  const cell = (text, sign) => {
    const td = doc.createElement("td");
    td.className = "code";
    const code = doc.createElement("code");
    if (sign !== undefined) {
      const s = doc.createElement("span");
      s.className = "d-sign";
      s.setAttribute("aria-hidden", "true");
      s.textContent = sign;
      code.append(s);
    }
    code.append(text);
    td.append(code);
    return td;
  };
  const note = cell("Both sides run through the formatter: only what changed besides formatting.");
  note.classList.add("t3");
  row("d-note", note);
  const SIGN = { ctx: " ", add: "+", del: "-" };
  for (const l of lines) row(l.kind === "hunk" ? "d-hunk" : `d-${l.kind}`, cell(l.text, l.kind === "hunk" ? undefined : SIGN[l.kind]));
  table.append(body);
  return table;
}

/**
 * Puts an "All changes | Logic only" switch on a file that changed more than formatting: it swaps
 * its diff for the formatted one. It sits in the file's sticky header, so the view shown stays in sight.
 */
export function offerLogic(doc, details, table, logic) {
  const meta = details.querySelector(".dfile-meta");
  const wrap = table.closest(".diff-wrap") ?? table;
  if (!meta || meta.querySelector(".cr-view")) return;
  const group = doc.createElement("span");
  group.className = "cr-view";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Which changes this file shows");
  const make = (label, title, logicOn) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "btn sm ghost";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-pressed", String(!logicOn));
    b.addEventListener("click", (e) => {
      // It sits in the file's <summary>: pressing it mustn't open or close the file.
      e.preventDefault();
      show(logicOn);
    });
    return b;
  };
  const all = make("All changes", "Shows the diff as it is", false);
  const only = make("Logic only", "Shows the diff of the two sides once both are formatted, without the formatting changes", true);
  all.setAttribute("aria-pressed", "true");
  only.setAttribute("aria-pressed", "false");
  let alt;
  const show = (on) => {
    if (on && !alt) {
      alt = doc.createElement("div");
      alt.className = "diff-wrap";
      alt.append(logicTable(doc, logic));
      alt.hidden = true;
      wrap.after(alt);
    }
    if (alt) alt.hidden = !on;
    wrap.hidden = on;
    all.setAttribute("aria-pressed", String(!on));
    only.setAttribute("aria-pressed", String(on));
    details.classList.toggle("cr-logic-on", on);
    if (on) details.open = true;
  };
  group.append(all, only);
  meta.append(group);
}

/** Checks one file against its new side at `src` (the pack's /code-review/src). */
async function check(doc, details, src, fmtFor) {
  const table = details.querySelector("table.diff:not(.cr-logic)");
  if (!table) return { verdict: "unknown", why: "This file's changes aren't shown." };
  const r = await fetch(src, { credentials: "same-origin" }).catch(() => undefined);
  if (!r?.ok) return { verdict: "unknown", why: "The file didn't load." };
  const res = await onlyFormatting(details.dataset.stopLabel ?? "", await r.text(), linesOf(table), fmtFor);
  if (res.verdict === "same") markSame(doc, details);
  if (res.logic) offerLogic(doc, details, table, res.logic);
  return res;
}

/** On a checkout's own diff (core's /code/<dir>/diff), where a file's new side is read locally: its source, else undefined. */
export function localSrc(loc, path) {
  const m = /^\/code\/([^/]+)\/diff$/.exec(loc.pathname);
  if (!m) return undefined;
  const q = new URLSearchParams(loc.search);
  // The working tree when no head or commit is named.
  const ref = q.get("commit") || q.get("head") || "";
  return `/code-review/src?${new URLSearchParams({ dir: decodeURIComponent(m[1]), ref, path })}`;
}

const BUTTON = { same: "Only formatting", more: "More than formatting", unknown: "Couldn't tell" };

/**
 * Upgrades every diff table on the page as it comes into view, and those a live update brings. On
 * a checkout's own diff, each file a formatter knows is checked for formatting only; on a PR's,
 * when its button ("Only formatting?", the pr.file slot) is pressed, since that reads the forge.
 */
export function start(doc, manifestUrl) {
  const manifest = fetch(manifestUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).catch(() => undefined);
  let ts;
  const tsOf = () => (ts ??= manifest.then((m) => (m ? loader(m) : undefined)));
  let fmts;
  const fmtOfPage = () => (fmts ??= manifest.then((m) => formatters(m?.fmt)));
  const seen = new WeakSet();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const details = e.target.closest("details.dfile");
        const path = details?.dataset.stopLabel ?? "";
        tsOf()
          .then((t) => upgrade(doc, e.target, path, t))
          .then(async () => {
            const src = details && !e.target.classList.contains("cr-logic") && fmtOf(path) && !/^(added|removed)$/.test(statusOf(details)) && !details.querySelector(".cr-only") ? localSrc(doc.location, path) : undefined;
            if (src) await check(doc, details, src, await fmtOfPage());
          })
          .catch(() => undefined);
      }
    },
    { rootMargin: "600px 0px" },
  );
  doc.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button.cr-fmt") : null;
    if (!b) return;
    // It sits in the file's <summary>: pressing it mustn't open or close the file.
    e.preventDefault();
    const details = b.closest("details.dfile");
    if (!details || b.disabled || !b.dataset.crSrc?.startsWith("/code-review/src?")) return;
    b.disabled = true;
    b.textContent = "Checking…";
    fmtOfPage()
      .then((f) => check(doc, details, b.dataset.crSrc, f))
      .catch(() => ({ verdict: "unknown", why: "Something went wrong." }))
      .then((res) => {
        b.textContent = BUTTON[res.verdict];
        b.title = res.why ?? "";
        if (res.verdict === "unknown") b.disabled = false;
      });
  });
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
