import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error: plain JS, no types
import { analyse, headerSymbol, langOf, lcs, symbolLabel, symbols, tokensOf } from "../engine.js";
// @ts-expect-error: plain JS, no types
import { GRAMMARS } from "../gen.mjs";

const vendor = (f: string) => new URL(`../vendor/${f}`, import.meta.url);
const ts: any = await import(vendor("web-tree-sitter.js").href);
await ts.Parser.init({ locateFile: () => vendor("runtime.wasm").pathname });

const langs = new Map<string, { parser: any; query: any; tags: any }>();
async function grammar(name: string) {
  if (!langs.has(name)) {
    const l = await ts.Language.load(new Uint8Array(readFileSync(vendor(`${name}.wasm`))));
    const parser = new ts.Parser();
    parser.setLanguage(l);
    const tags = existsSync(vendor(`${name}.tags.scm`)) ? new ts.Query(l, readFileSync(vendor(`${name}.tags.scm`), "utf8")) : undefined;
    langs.set(name, { parser, query: new ts.Query(l, readFileSync(vendor(`${name}.scm`), "utf8")), tags });
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

// ── Changed symbols (dovre#300) ──

async function touched(lang: string, lines: { kind: string; text: string }[], skip?: Set<number>) {
  const g = await grammar(lang);
  return symbols(lines, (t: string) => g.parser.parse(t), g.tags, skip).map((s: { name: string; kind: string; line: number }) => `${symbolLabel(s)}@${s.line}`);
}

test("every grammar with definition queries compiles them in this runtime; JSON, YAML, TOML and CSS have none", async () => {
  const withTags = [];
  for (const name of GRAMMARS) if ((await grammar(name)).tags) withTags.push(name);
  assert.deepEqual(withTags.sort(), ["csharp", "go", "javascript", "python", "rust", "tsx", "typescript"]);
});

test("symbols: a change belongs to the innermost definition around it, on either side, named once, in order", async () => {
  const lines = [
    L("hunk", "@@ -1,9 +1,9 @@"),
    L("ctx", "export class Shelf {"),
    L("ctx", "  load(n: number) {"),
    L("del", "    return n;"),
    L("add", "    return n + 1;"),
    L("ctx", "  }"),
    L("del", "  get size() { return 1; }"),
    L("ctx", "}"),
    L("ctx", "function top() {"),
    L("add", "  log();"),
    L("ctx", "}"),
  ];
  assert.deepEqual(await touched("typescript", lines), ["load()@3", "size()@6", "top()@9"]);
});

test("symbols: a change below the hunk's first lines belongs to the definition git names in its header", async () => {
  const lines = [L("hunk", "@@ -40,6 +40,7 @@ export function start(doc, manifestUrl) {"), L("ctx", "  const a = 1;"), L("add", "  const b = 2;"), L("ctx", "  return a;")];
  assert.deepEqual(await touched("typescript", lines), ["start()@2"]);
  const arrow = [L("hunk", "@@ -4,3 +4,3 @@ const go = () => {"), L("del", "  if (on) return;"), L("add", "  if (on || off) return;")];
  assert.deepEqual(await touched("javascript", arrow), ["go()@1"], "a header that doesn't close on its own line still reads");
});

test("symbols: once a hunk reaches code at the top level, the header's definition no longer owns its changes", async () => {
  const lines = [L("hunk", "@@ -10,6 +10,8 @@ function load() {"), L("ctx", "  return 1;"), L("ctx", "}"), L("ctx", ""), L("add", 'import { x } from "y";'), L("add", "x();")];
  assert.deepEqual(await touched("typescript", lines), []);
  // A header that opens a template string is closed so it reads.
  const css = [L("hunk", "@@ -40,6 +40,7 @@ const styles = `"), L("ctx", "  .a {"), L("add", "    color: blue;"), L("ctx", "  }")];
  assert.deepEqual(await touched("typescript", css), ["styles@2"]);
});

test("symbols: constants, types and enums in TypeScript; a function kept as const is a function", async () => {
  const lines = [L("hunk", "@@ -1,5 +1,5 @@"), L("del", "export const MAX = 1;"), L("add", "export const MAX = 2;"), L("add", "type Id = string;"), L("add", "enum Tone { Ok }"), L("add", "const f = () => 1;"), L("add", "interface Box { a: Id }")];
  assert.deepEqual(await touched("typescript", lines), ["MAX@1", "type Id@3", "enum Tone@4", "f()@5", "interface Box@6"]);
});

test("symbols: Go, Rust, Python and C# by their own queries, Python's header too", async () => {
  assert.deepEqual(await touched("go", [L("hunk"), L("ctx", "func (s *Shelf) Load() int {"), L("del", "\treturn 1"), L("add", "\treturn 2"), L("ctx", "}")]), ["Load()@2"]);
  assert.deepEqual(await touched("rust", [L("hunk"), L("ctx", "fn load() -> u8 {"), L("add", "    2"), L("ctx", "}")]), ["load()@2"]);
  assert.deepEqual(await touched("python", [L("hunk", "@@ -3,3 +3,3 @@ class Shelf:"), L("ctx", "    x = 1"), L("del", "    y = 2"), L("add", "    y = 3")]), ["class Shelf@2"]);
  assert.deepEqual(await touched("csharp", [L("hunk"), L("ctx", "class Shelf {"), L("ctx", "  int Load() {"), L("add", "    return 2;"), L("ctx", "  }"), L("ctx", "}")]), ["Load()@3"]);
});

test("symbols: changes that are only layout don't count", async () => {
  const lines = [L("hunk"), L("ctx", "function a() {"), L("del", "  f(1,2);"), L("add", "  f(1, 2);"), L("ctx", "}")];
  assert.deepEqual(await touched("typescript", lines, new Set([2, 3])), []);
});

test("symbols: a method in a class is named, a helper inside a function isn't; one name once", async () => {
  const lines = [L("hunk"), L("ctx", "export function start(doc) {"), L("ctx", "  const row = (x) => {"), L("add", "    return x + 1;"), L("ctx", "  };"), L("ctx", "}"), L("ctx", "class A {"), L("ctx", "  start() {"), L("add", "    go();"), L("ctx", "  }"), L("ctx", "}")];
  assert.deepEqual(await touched("typescript", lines), ["start()@3"]);
});

test("symbols: a change below a definition that starts on an unindented line belongs to it, not to the header's", async () => {
  const lines = [L("hunk", "@@ -120,4 +120,5 @@ export const API_1: Record<string, ApiUse[]> = {"), L("ctx", " */"), L("ctx", "export const API_ADDED: Record<string, string[]> = {"), L("ctx", '  "2.1": [],'), L("add", '  "2.2": [],'), L("ctx", "};")];
  assert.deepEqual(await touched("typescript", lines), ["API_ADDED@4"]);
});

test("headerSymbol: only a hunk header's context, and nothing when it isn't a definition", async () => {
  const g = await grammar("typescript");
  const name = (h: string) => headerSymbol(h, (t: string) => g.parser.parse(t), g.tags)?.name;
  assert.equal(name("@@ -1,2 +1,3 @@ export async function run(x: number) {"), "run");
  assert.equal(name("@@ -226,7 +226,7 @@ export function createApp(env: Env, deps: { gatherer: Gatherer; /** Local: where"), "createApp", "git cut it short: by its keyword");
  assert.equal(name("@@ -9,2 +9,3 @@ func (s *Shelf) Load() int {"), "Load");
  assert.equal(name("@@ -1,2 +1,3 @@"), undefined);
  assert.equal(name("@@ -1,2 +1,3 @@ if (x) {"), undefined);
  assert.equal(name("not a header"), undefined);
});

test("symbolLabel: calls get (), types say what they are", () => {
  assert.equal(symbolLabel({ name: "start", kind: "function" }), "start()");
  assert.equal(symbolLabel({ name: "Shelf", kind: "class" }), "class Shelf");
  assert.equal(symbolLabel({ name: "MAX", kind: "constant" }), "MAX");
  assert.equal(symbolLabel({ name: "vec", kind: "macro" }), "vec!");
});
