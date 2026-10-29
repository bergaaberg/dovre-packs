import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error: plain JS, no types
import { analyse, langOf, lcs, tokensOf } from "../engine.js";
// @ts-expect-error: plain JS, no types
import { GRAMMARS } from "../gen.mjs";

const vendor = (f: string) => new URL(`../vendor/${f}`, import.meta.url);
const ts: any = await import(vendor("web-tree-sitter.js").href);
await ts.Parser.init({ locateFile: () => vendor("runtime.wasm").pathname });

const langs = new Map<string, { parser: any; query: any }>();
async function grammar(name: string) {
  if (!langs.has(name)) {
    const l = await ts.Language.load(new Uint8Array(readFileSync(vendor(`${name}.wasm`))));
    const parser = new ts.Parser();
    parser.setLanguage(l);
    langs.set(name, { parser, query: new ts.Query(l, readFileSync(vendor(`${name}.scm`), "utf8")) });
  }
  return langs.get(name)!;
}
const L = (kind: string, text = "") => ({ kind, text });
async function read(lang: string, lines: { kind: string; text: string }[]) {
  const g = await grammar(lang);
  return analyse(lines, (t: string) => g.parser.parse(t), g.query);
}

test("every grammar loads in this runtime and its highlight queries compile", async () => {
  for (const name of GRAMMARS) {
    const g = await grammar(name);
    assert.ok(g.query.captureNames.length > 3, `${name}: its queries name captures`);
  }
});

test("files map to grammars by extension; others get none", () => {
  assert.equal(langOf("src/app.ts"), "typescript");
  assert.equal(langOf("a/B.TSX"), "tsx");
  assert.equal(langOf("launcher/main.go"), "go");
  assert.equal(langOf("Svc/Program.cs"), "csharp");
  assert.equal(langOf("wrangler.jsonc"), "json");
  assert.equal(langOf("Makefile"), undefined);
  assert.equal(langOf("x.ts.orig"), undefined);
});

test("highlighting: keywords, strings, comments and numbers on both sides; a removed line from the old side", async () => {
  const { per } = await read("typescript", [L("hunk"), L("ctx", "// fjell"), L("del", 'const a = "x";'), L("add", "const a = 42;")]);
  assert.deepEqual(per[1].hl, [[0, 8, "c"]]);
  assert.ok(per[2].hl.some(([s, e, c]: [number, number, string]) => c === "k" && s === 0 && e === 5), "const is a keyword");
  assert.ok(per[2].hl.some(([s, e, c]: [number, number, string]) => c === "s" && s === 10 && e === 13), "the string");
  assert.ok(per[3].hl.some(([s, e, c]: [number, number, string]) => c === "n" && s === 10 && e === 12), "the number");
});

test("changes by token: only what differs is marked, across lines; a rename marks the name alone", async () => {
  const { per, blocks } = await read("typescript", [L("hunk"), L("del", "function load(repo: string) {"), L("add", "function load(repo: string, n: number) {"), L("ctx", "}")]);
  assert.deepEqual(per[1].marks, []);
  assert.deepEqual(per[2].marks, [[26, 37]], "', n: number' and nothing else");
  assert.deepEqual(blocks, [{ first: 1, last: 2, layout: false }]);
  const tpl = "const r = await fetch(`https://api.example/${repo}?n=${n}`);";
  const t = await read("typescript", [L("hunk"), L("del", "const r = await fetch(`https://api.example/${repo}`);"), L("add", tpl)]);
  assert.deepEqual(t.per[2].marks.map(([s, e]: [number, number]) => tpl.slice(s, e)), ["?n=${n}"], "an insertion keeps its own closing brace");
  const go = await read("go", [L("hunk"), L("del", "\treturn fetchAll(ctx)"), L("add", "\treturn fetchEvery(ctx)")]);
  assert.deepEqual(go.per[1].marks, [[8, 16]]);
  assert.deepEqual(go.per[2].marks, [[8, 18]]);
});

test("a run that changed only whitespace or layout is found: re-wrapped arguments, re-indented code, blank lines", async () => {
  const wrap = await read("typescript", [L("hunk"), L("del", "call(a, b, c);"), L("add", "call("), L("add", "  a,"), L("add", "  b,"), L("add", "  c,"), L("add", ");")]);
  assert.equal(wrap.blocks[0].layout, false, "a trailing comma is a token: not layout only");
  const indent = await read("python", [L("hunk"), L("ctx", "if x:"), L("del", "  y = 1"), L("add", "    y = 1"), L("ctx", "z = 2")]);
  assert.deepEqual(indent.blocks, [{ first: 2, last: 3, layout: true }]);
  assert.deepEqual(indent.per[3].marks, []);
  const blank = await read("rust", [L("hunk"), L("ctx", "fn a() {}"), L("add", ""), L("ctx", "fn b() {}")]);
  assert.equal(blank.blocks[0].layout, true);
  const json = await read("json", [L("hunk"), L("del", '{"a": 1, "b": [1, 2]}'), L("add", "{"), L("add", '  "a": 1,'), L("add", '  "b": [1, 2]'), L("add", "}")]);
  assert.equal(json.blocks[0].layout, true, "pretty-printed JSON is the same JSON");
});

test("comments and strings are compared by word; without a grammar, by regex", async () => {
  const { per } = await read("rust", [L("hunk"), L("del", "// read the repos once"), L("add", "// read the repos twice")]);
  assert.deepEqual(per[1].marks, [[18, 22]]);
  assert.deepEqual(per[2].marks, [[18, 23]]);
  const plain = analyse([L("hunk"), L("del", "FOO = 1"), L("add", "FOO = 2")], undefined, undefined);
  assert.deepEqual(plain.per[2].marks, [[6, 7]]);
  assert.deepEqual(plain.per[2].hl, []);
});

test("offsets are in UTF-16 units, as the page's strings are: text after æøå and an emoji lines up", async () => {
  const { per } = await read("python", [L("hunk"), L("del", 's = "Dovre ⛰ 🏔 æøå"; n = 1'), L("add", 's = "Dovre ⛰ 🏔 æøå"; n = 2')]);
  const text = 's = "Dovre ⛰ 🏔 æøå"; n = 2';
  assert.deepEqual(per[2].marks.map(([s, e]: [number, number]) => text.slice(s, e)), ["2"]);
  const str = per[2].hl.find(([, , c]: [number, number, string]) => c === "s");
  assert.equal(text.slice(str[0], str[1]), '"Dovre ⛰ 🏔 æøå"');
});

test("a hunk that starts inside a comment or a broken construct still gives tokens and marks", async () => {
  const { per } = await read("typescript", [L("hunk"), L("ctx", " * the middle of a doc comment"), L("del", " */ }, 10);"), L("add", " */ }, 20);")]);
  assert.deepEqual(per[3].marks.map(([s, e]: [number, number]) => " */ }, 20);".slice(s, e)), ["20"]);
});

test("lcs: keeps the longest common run, trims shared ends, gives up past the cap", () => {
  assert.deepEqual(lcs(["a", "b", "c"], ["a", "x", "c"]), [[true, false, true], [true, false, true]]);
  assert.deepEqual(lcs([], ["a"]), [[], [false]]);
  const [ka, kb] = lcs(["x", "a", "b"], ["a", "b", "y"], 1);
  assert.deepEqual([ka, kb], [[false, false, false], [false, false, false]], "over the cap: nothing kept");
});

test("tokens without a tree: words and single punctuation, never whitespace", () => {
  assert.deepEqual(tokensOf(undefined, "a.b  = c1;").map((t: { t: string }) => t.t), ["a", ".", "b", "=", "c1", ";"]);
});
