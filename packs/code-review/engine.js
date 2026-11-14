// Code review's engine (ES module): reads a diff the way a reviewer does. Runs in the browser, on
// core's diff tables (a PR's Files tab, a checkout's Changes), and under Node in the tests.
// - Highlighting from tree-sitter (web-tree-sitter, WebAssembly), one grammar per language.
// - What changed, by token rather than by line: within each run of removed and added lines, the
//   old and new tokens are matched (longest common subsequence); unmatched ones are marked.
// - A run whose tokens all match changed only whitespace or layout: it folds to one row.
// - A block removed in one place and added in another is shown as moved, both ends linked.
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
 * class]) and `marks` ([from, to) of changed tokens); the runs of changes (`blocks`: first and
 * last line index, and `layout` when only whitespace or layout changed); and the blocks that moved
 * (`moves`, see findMoves).
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
  /** A changed line's tokens ({ t, line, from, to, abs }: `abs` is its offset in its side's text). */
  const toksAt = new Map();
  /** Spans of whole changed lines, from the trees: { side, first, last, s, e, size } (line indices; s, e: offsets in that side's text). */
  const spans = [];
  const runs = [];
  const runOf = new Map();
  for (const idx of hunks) {
    for (const side of ["old", "new"]) {
      const kind = side === "old" ? "del" : "add";
      const mine = idx.filter((i) => lines[i].kind === "ctx" || lines[i].kind === kind);
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
      if (tree) spans.push(...wholeLines(tree, mine, at, lines, kind, side, text));
      tree?.delete?.();
      // Each token to its line (a token across lines, which only a broken parse gives, to none).
      let row = 0;
      for (const t of toks) {
        while (row + 1 < mine.length && at.get(mine[row + 1]) <= t.s) row++;
        const i = mine[row];
        const s = at.get(i);
        if (lines[i].kind !== kind || t.e > s + lines[i].text.length) continue;
        if (!toksAt.has(i)) toksAt.set(i, []);
        toksAt.get(i).push({ t: t.t, line: i, from: t.s - s, to: t.e - s, abs: t.s });
      }
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
      for (const i of run) runOf.set(i, runs.length);
      runs.push(run);
    }
  }
  const side = (run, kind) => run.filter((i) => lines[i].kind === kind).flatMap((i) => toksAt.get(i) ?? []);
  // First each run on its own, so a block that only moved within its run, the rest matching
  // around it, isn't taken for a move.
  for (const run of runs) {
    const olds = side(run, "del");
    const news = side(run, "add");
    const [ka, kb] = lcs(olds.map((t) => t.t), news.map((t) => t.t));
    olds.forEach((t, j) => (t.kept = ka[j]));
    news.forEach((t, j) => (t.kept = kb[j]));
  }
  const moves = findMoves(lines, toksAt, spans, runOf);
  const moved = new Set();
  const mark = (toks, keep) => toks.forEach((t, j) => keep[j] || per[t.line].marks.push([t.from, t.to]));
  for (const m of moves) {
    const o = [];
    const n = [];
    for (let i = m.old[0]; i <= m.old[1]; i++) moved.add(i), o.push(...(toksAt.get(i) ?? []));
    for (let i = m.new[0]; i <= m.new[1]; i++) moved.add(i), n.push(...(toksAt.get(i) ?? []));
    if (!m.edited) continue;
    const [ka, kb] = lcs(o.map((t) => t.t), n.map((t) => t.t));
    mark(o, ka);
    mark(n, kb);
  }
  // Then what's left of each run, without what moved.
  for (const run of runs) {
    const rest = run.filter((i) => !moved.has(i));
    const olds = side(rest, "del");
    const news = side(rest, "add");
    const [ka, kb] = lcs(olds.map((t) => t.t), news.map((t) => t.t));
    mark(olds, ka);
    mark(news, kb);
    blocks.push({ first: run[0], last: run[run.length - 1], layout: rest.length === run.length && ka.every(Boolean) && kb.every(Boolean) });
  }
  for (const p of per) p.marks = merge(p.marks);
  return { per, blocks, moves };
}

// ── Moved blocks (dovre#520) ────────────────────────────────────────────────
// A block removed in one place and added in another is a move, not a delete and an add. Its
// syntax trees are matched, difftastic-style: whole subtrees of changed lines, compared by their
// tokens (so a block that moved and was re-wrapped still matches), the biggest first, each grown
// over the identical lines around it. Then, for what's left, a moved definition that was also
// edited: two blocks of three lines or more, in different runs, most of their tokens in common.
// Each hunk is parsed on its own, so a block is matched across the file's hunks without reading it.

/** A move this small (in letters and digits) isn't named: a stray `return null;` is no move. */
export const MOVE_MIN = 20;
/** A moved-and-edited block keeps at least this much of its tokens and of its words. */
const EDITED_MIN = 0.75;
const WORDY = /\w/;

/** The nodes of a tree that are whole changed lines (only `kind` ones): { side, first, last, s, e, size }. */
function wholeLines(tree, mine, at, lines, kind, side, text) {
  const out = [];
  const seen = new Set();
  const c = tree.walk();
  for (;;) {
    const s = c.startIndex;
    const e = c.endIndex;
    const r0 = c.startPosition.row;
    let r1 = c.endPosition.row;
    if (r1 > r0 && c.endPosition.column === 0) r1--;
    const first = mine[r0];
    const last = mine[r1];
    let whole = e > s && first !== undefined && last !== undefined;
    for (let r = r0; whole && r <= r1; r++) whole = lines[mine[r]].kind === kind;
    if (whole) {
      const end = at.get(last) + lines[last].text.length;
      whole = !text.slice(at.get(first), s).trim() && !text.slice(Math.min(e, end), end).replace(/[;,]/g, "").trim();
    }
    // The outermost node of a span stands for it (an expression statement, not its call).
    if (whole && !seen.has(`${first}:${last}`)) {
      seen.add(`${first}:${last}`);
      out.push({ side, first, last, s, e });
    }
    if (c.gotoFirstChild()) continue;
    while (!c.gotoNextSibling()) if (!c.gotoParent()) return out;
  }
}

/**
 * The blocks that moved: { old: [first, last], new: [first, last], edited } (line indices; `edited`
 * when it changed too, its marks then from the two sides). `toksAt`: each changed line's tokens,
 * `kept` set where its run's own matching kept them; `spans`: wholeLines'; `runOf`: line → run.
 */
export function findMoves(lines, toksAt, spans, runOf) {
  const toks = (first, last, s, e) => {
    const out = [];
    for (let i = first; i <= last; i++) for (const t of toksAt.get(i) ?? []) if (s === undefined || (t.abs >= s && t.abs < e)) out.push(t);
    return out;
  };
  const cands = [];
  const lineSpan = new Set(spans.map((x) => `${x.side}:${x.first}:${x.last}`));
  for (const x of spans) cands.push({ ...x, toks: toks(x.first, x.last, x.s, x.e) });
  // Every changed line is a span of its own too (and the only kind without a grammar).
  for (const [i, ts] of toksAt) {
    const side = lines[i].kind === "del" ? "old" : "new";
    if (!lineSpan.has(`${side}:${i}:${i}`)) cands.push({ side, first: i, last: i, toks: ts });
  }
  // One that its run already matches whole, or with no word in it, isn't a move to look for.
  const live = cands.filter((c) => c.toks.some((t) => !t.kept) && c.toks.some((t) => WORDY.test(t.t)));
  for (const c of live) c.key = c.toks.map((t) => t.t).join("\u0000");
  const used = new Set();
  const free = (c) => {
    for (let i = c.first; i <= c.last; i++) if (used.has(i)) return false;
    return true;
  };
  const key = (i) => (toksAt.get(i) ?? []).map((t) => t.t).join("\u0000");
  const alnum = (a, b) => toks(a, b).reduce((n, t) => n + (t.t.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
  /** A match grown over the identical removed and added lines on each side of it. */
  const grow = (o0, o1, n0, n1) => {
    const ok = (o, n) => lines[o]?.kind === "del" && lines[n]?.kind === "add" && !used.has(o) && !used.has(n) && key(o) === key(n);
    while (ok(o0 - 1, n0 - 1)) o0--, n0--;
    while (ok(o1 + 1, n1 + 1)) o1++, n1++;
    // Not ending on lines with no tokens (blank ones).
    while (o1 > o0 && n1 > n0 && !toksAt.get(o1) && !toksAt.get(n1)) o1--, n1--;
    while (o0 < o1 && n0 < n1 && !toksAt.get(o0) && !toksAt.get(n0)) o0++, n0++;
    return [o0, o1, n0, n1];
  };
  const take = (o0, o1, n0, n1) => {
    for (let i = o0; i <= o1; i++) used.add(i);
    for (let i = n0; i <= n1; i++) used.add(i);
  };
  const moves = [];
  const byKey = new Map();
  for (const c of live) if (c.side === "new") byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  // Moved and edited: big blocks only, never two from the same run (that's an edit in place).
  const big = (c) => c.s !== undefined && c.last - c.first >= 2 && c.toks.length >= 12;
  const bigNew = live.filter((c) => c.side === "new" && big(c)).sort((a, b) => b.toks.length - a.toks.length).slice(0, 60);
  let tries = 0;
  const edited = (o) => {
    let best;
    for (const n of bigNew) {
      if (!free(n) || runOf.get(n.first) === runOf.get(o.first)) continue;
      const [a, b] = [o.toks.length, n.toks.length];
      if (Math.min(a, b) / Math.max(a, b) < EDITED_MIN || ++tries > 400) continue;
      const [ka, kb] = lcs(o.toks.map((t) => t.t), n.toks.map((t) => t.t), 250_000);
      const kept = ka.filter(Boolean).length;
      const words = o.toks.filter((t) => WORDY.test(t.t)).length;
      const keptWords = o.toks.filter((t, j) => ka[j] && WORDY.test(t.t)).length;
      const score = (2 * kept) / (a + b);
      if (score >= EDITED_MIN && keptWords >= EDITED_MIN * words && kb.some(Boolean) && (!best || score > best.score)) best = { n, score };
    }
    return best?.n;
  };
  // The biggest first, so a whole definition is matched before its parts: as it is, else edited.
  const olds = live.filter((c) => c.side === "old").sort((a, b) => b.toks.length - a.toks.length || a.first - b.first);
  for (const o of olds) {
    if (!free(o)) continue;
    // Of the places it could have gone as it is, the one it matches the most lines around.
    let best;
    for (const n of (byKey.get(o.key) ?? []).filter(free).slice(0, 8)) {
      const g = grow(o.first, o.last, n.first, n.last);
      if (!best || g[1] - g[0] > best[1] - best[0]) best = g;
    }
    if (best && alnum(best[0], best[1]) >= MOVE_MIN) {
      take(...best);
      moves.push({ old: [best[0], best[1]], new: [best[2], best[3]], edited: false });
      continue;
    }
    const n = big(o) && alnum(o.first, o.last) >= MOVE_MIN ? edited(o) : undefined;
    if (n) {
      take(o.first, o.last, n.first, n.last);
      moves.push({ old: [o.first, o.last], new: [n.first, n.last], edited: true });
    }
  }
  return moves.sort((a, b) => a.new[0] - b.new[0]);
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
  const { per, blocks, moves } = analyse(lines, parser ? (t) => parser.parse(t) : undefined, query);
  lines.forEach((l, i) => {
    if (l.kind === "hunk") return;
    for (const el of l.els) draw(doc, el, l.text, per[i].hl, per[i].marks);
  });
  showMoves(doc, table.closest("details.dfile") ?? table, lines, moves);
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
      goTo(details, lines, s.line);
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

/** Opens a file and shows one of its diff's lines (in a folded run: the fold's row, the first one shown above it). */
function goTo(details, lines, i) {
  details.open = true;
  let at = lines[i]?.els[0]?.closest("tr");
  while (at?.hidden) at = at.previousElementSibling;
  if (!at) return;
  at.scrollIntoView({ block: "center" });
  at.classList.add("cr-here");
  setTimeout(() => at.classList.remove("cr-here"), 1600);
}

/** Each line's numbers on the old and new side ({ old, new }), from its hunk's header; none where a header doesn't read. */
export function numbers(lines) {
  let o;
  let n;
  return lines.map((l) => {
    if (l.kind === "hunk") {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l.text ?? "");
      [o, n] = m ? [Number(m[1]), Number(m[2])] : [undefined, undefined];
      return {};
    }
    const at = { old: l.kind !== "add" ? o : undefined, new: l.kind !== "del" ? n : undefined };
    if (o !== undefined && l.kind !== "add") o++;
    if (n !== undefined && l.kind !== "del") n++;
    return at;
  });
}

/**
 * Marks the lines that moved, and puts a tag on each end that says where the other is and goes
 * there: "moved to line 120" where it was removed, "moved from line 4" where it was added (and
 * "…, changed" when it was edited too).
 */
export function showMoves(doc, details, lines, moves) {
  const nums = numbers(lines);
  for (const m of moves) {
    const ends = [
      { at: m.old, to: m.new[0], word: "to", line: nums[m.new[0]]?.new },
      { at: m.new, to: m.old[0], word: "from", line: nums[m.old[0]]?.old },
    ];
    for (const { at, to, word, line } of ends) {
      for (let i = at[0]; i <= at[1]; i++) for (const el of lines[i].els) el.closest?.("td")?.classList.add("cr-mv");
      const td = lines[at[0]].els[0]?.closest?.("td");
      if (!td) continue;
      const where = line !== undefined ? `line ${line}` : to > at[0] ? "below" : "above";
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "cr-mv-tag";
      b.textContent = `moved ${word} ${where}${m.edited ? ", changed" : ""}`;
      b.title = word === "to" ? "Goes to where this block went" : "Goes to where this block came from";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        goTo(details, lines, to);
      });
      td.append(b);
    }
  }
}

// ── Outline (dovre#300) ─────────────────────────────────────────────────────
// A file's whole outline, from its new side (on a PR read when asked: one forge read, shared with
// the formatting check). Its definitions as a reviewer scans them: those at the top level and the
// members of classes, modules and the like, not helpers inside a function. Those the diff changes
// are marked, and go to their first change.

/** At most this many definitions are listed; the rest are counted. */
export const OUTLINE_MAX = 400;

/** A file's definitions: { name, kind, from, to (rows, from 0), depth }, in order. */
export function outline(text, parse, tags) {
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  let tree;
  try {
    tree = parse(rows.join("\n"));
  } catch {
    return [];
  }
  if (!tree) return [];
  const defs = defsOf(tags, tree, rows);
  tree.delete?.();
  // One per place: of two the same, not the constant (a `const f = () => …` is a function).
  const at = new Map();
  for (const d of defs) {
    const k = `${d.from}:${d.to}:${d.name}`;
    const was = at.get(k);
    if (!was || (was.kind === "constant" && d.kind !== "constant")) at.set(k, d);
  }
  const all = [...at.values()].sort((a, b) => a.from - b.from || b.span - a.span);
  const out = [];
  for (const d of all) {
    const outer = all.filter((o) => o !== d && o.span > d.span && o.from <= d.from && d.to <= o.to);
    if (outer.some((o) => !HOLDS.has(o.kind))) continue;
    out.push({ name: d.name, kind: d.kind, from: d.from, to: d.to, depth: outer.length });
  }
  return out;
}

/**
 * Where a diff's changes are on the new side, in order: { row (from 0), line (its index in
 * `lines`) }. A removed line is at the row that follows it. `skip`: lines not to count (layout only).
 */
export function changedRows(lines, skip = new Set()) {
  const out = [];
  let row;
  lines.forEach((l, i) => {
    if (l.kind === "hunk") {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l.text);
      // A hunk with no lines on the new side names the line before it.
      row = m ? (m[2] === "0" ? Number(m[1]) : Number(m[1]) - 1) : undefined;
      return;
    }
    if (row === undefined) return;
    if ((l.kind === "add" || l.kind === "del") && !skip.has(i)) out.push({ row, line: i });
    if (l.kind === "ctx" || l.kind === "add") row++;
  });
  return out;
}

/** Each definition with the first change inside it (`change`: its line in the diff), if any. */
export function markChanged(defs, changes) {
  return defs.map((d) => {
    const c = changes.find((x) => d.from <= x.row && x.row <= d.to);
    return c ? { ...d, change: c.line } : d;
  });
}

/** The outline, under the file's header: changed definitions go to their change; each says its line. */
export function outlineList(doc, details, lines, defs) {
  const nav = doc.createElement("nav");
  nav.className = "cr-outline";
  nav.setAttribute("aria-label", "Outline of this file");
  const head = doc.createElement("p");
  head.className = "cr-outline-head";
  const changed = defs.filter((d) => d.change !== undefined).length;
  head.textContent = defs.length ? `${defs.length} definition${defs.length === 1 ? "" : "s"}, ${changed} changed` : "No definitions found.";
  nav.append(head);
  if (!defs.length) return nav;
  const ol = doc.createElement("ol");
  for (const d of defs.slice(0, OUTLINE_MAX)) {
    const li = doc.createElement("li");
    li.className = `cr-o${Math.min(d.depth, 3)}`;
    let name;
    if (d.change !== undefined) {
      name = doc.createElement("button");
      name.type = "button";
      name.className = "cr-sym cr-changed";
      name.title = `Goes to the first change in ${symbolLabel(d)}`;
      name.addEventListener("click", (e) => {
        e.preventDefault();
        goTo(details, lines, d.change);
      });
    } else {
      name = doc.createElement("span");
      name.className = "cr-o-name";
    }
    name.textContent = symbolLabel(d);
    const ln = doc.createElement("span");
    ln.className = "cr-ln";
    ln.textContent = String(d.from + 1);
    li.append(name, ln);
    ol.append(li);
  }
  nav.append(ol);
  if (defs.length > OUTLINE_MAX) {
    const more = doc.createElement("p");
    more.className = "cr-outline-head";
    more.textContent = `and ${defs.length - OUTLINE_MAX} more`;
    nav.append(more);
  }
  return nav;
}

/** An "Outline" button in a file's header, reading its new side from `src` (the pack's /code-review/src). */
export function offerOutline(doc, details, src) {
  const meta = details.querySelector(".dfile-meta");
  if (!meta || meta.querySelector(".cr-outline-btn")) return;
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "btn sm ghost cr-outline-btn";
  b.dataset.crSrc = src;
  b.textContent = "Outline";
  b.title = "Lists this file's functions, classes and methods, the changed ones marked";
  meta.append(b);
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

/** Checks one file against its new side (`text`: a promise of it, from the pack's /code-review/src). */
async function check(doc, details, text, fmtFor) {
  const table = details.querySelector("table.diff:not(.cr-logic)");
  if (!table) return { verdict: "unknown", why: "This file's changes aren't shown." };
  const neu = await text.catch(() => undefined);
  if (neu === undefined) return { verdict: "unknown", why: "The file didn't load." };
  const res = await onlyFormatting(details.dataset.stopLabel ?? "", neu, linesOf(table), fmtFor);
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
  // A file's new side, read once for both the formatting check and the outline; again after a failure.
  const texts = new Map();
  const textAt = (src) => {
    if (!texts.has(src))
      texts.set(src, fetch(src, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).catch((err) => {
        texts.delete(src);
        throw err;
      }));
    return texts.get(src);
  };
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
            const local = details && !e.target.classList.contains("cr-logic") && statusOf(details) !== "removed" ? localSrc(doc.location, path) : undefined;
            if (local && (await manifest)?.langs?.[langOf(path)]?.tags) offerOutline(doc, details, local);
            const src = local && fmtOf(path) && statusOf(details) !== "added" && !details.querySelector(".cr-only") ? local : undefined;
            if (src) await check(doc, details, textAt(src), await fmtOfPage());
          })
          .catch(() => undefined);
      }
    },
    { rootMargin: "600px 0px" },
  );
  doc.addEventListener("click", (e) => {
    const o = e.target instanceof Element ? e.target.closest("button.cr-outline-btn") : null;
    if (o) {
      e.preventDefault();
      const details = o.closest("details.dfile");
      if (details && !o.disabled && o.dataset.crSrc?.startsWith("/code-review/src?")) toggleOutline(details, o);
      return;
    }
    const b = e.target instanceof Element ? e.target.closest("button.cr-fmt") : null;
    if (!b) return;
    // It sits in the file's <summary>: pressing it mustn't open or close the file.
    e.preventDefault();
    const details = b.closest("details.dfile");
    if (!details || b.disabled || !b.dataset.crSrc?.startsWith("/code-review/src?")) return;
    b.disabled = true;
    b.textContent = "Checking…";
    fmtOfPage()
      .then((f) => check(doc, details, textAt(b.dataset.crSrc), f))
      .catch(() => ({ verdict: "unknown", why: "Something went wrong." }))
      .then((res) => {
        b.textContent = BUTTON[res.verdict];
        b.title = res.why ?? "";
        if (res.verdict === "unknown") b.disabled = false;
      });
  });
  // Shows or hides a file's outline; the first time, reads and parses its new side.
  function toggleOutline(details, b) {
    const shown = details.querySelector("nav.cr-outline");
    if (shown) {
      shown.hidden = !shown.hidden;
      b.setAttribute("aria-expanded", String(!shown.hidden));
      if (!shown.hidden) details.open = true;
      return;
    }
    const table = details.querySelector("table.diff:not(.cr-logic)");
    const path = details.dataset.stopLabel ?? "";
    const lang = langOf(path);
    if (!table || !lang) return;
    b.disabled = true;
    b.textContent = "Reading…";
    Promise.all([tsOf(), textAt(b.dataset.crSrc)])
      .then(async ([t, text]) => {
        const parser = await t.parser(lang);
        const tags = await t.tags(lang);
        const lines = linesOf(table);
        // Runs folded as layout only aren't changes.
        const skip = new Set();
        lines.forEach((l, i) => l.els[0]?.closest("tr")?.hidden && skip.add(i));
        const defs = markChanged(outline(text, (x) => parser.parse(x), tags), changedRows(lines, skip));
        const nav = outlineList(doc, details, lines, defs);
        (table.closest(".diff-wrap") ?? table).before(nav);
        details.open = true;
        b.textContent = "Outline";
        b.setAttribute("aria-expanded", "true");
      })
      .catch(() => {
        b.textContent = "Outline (didn't load)";
        b.title = "The file or its grammar didn't load. Press to try again.";
      })
      .finally(() => {
        b.disabled = false;
      });
  }
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
