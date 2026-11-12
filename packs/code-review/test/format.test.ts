// Only formatting (dovre#301): the old side rebuilt from the hunks, dprint as the normaliser, and
// where a file's new side is read from.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packApp, testContext } from "dovre/pack-testing.ts";
// @ts-expect-error: plain JS, no types
import { FMT, FMT_CONFIG, FMT_GLOBAL, localSrc, onlyFormatting, rebuildOld } from "../engine.js";
import { codeReviewPack } from "../index.ts";
import { DPRINT_JS_SHA, RUFF_JS_SHA, SHA } from "../gen.ts";
import { FMT_EXTS, MAX_SRC, prSrc, readSrc, srcAsk } from "../src.ts";

const vendor = (f: string) => new URL(`../vendor/${f}`, import.meta.url);
const dprint: any = await import(vendor("dprint.js").href);
const made = new Map<string, (text: string, path: string) => string>();
/** As the browser's loader: the plugin, set up as the engine sets it. */
async function format(kind: string) {
  if (kind === "python" && !made.has(kind)) {
    const ruff: any = await import(vendor("ruff.js").href);
    ruff.initSync({ module: readFileSync(vendor("fmt-python.wasm")) });
    const w = new ruff.Workspace(FMT_CONFIG.python);
    made.set(kind, (text) => w.format(text));
  }
  if (!made.has(kind)) {
    const f = dprint.createFromBuffer(readFileSync(vendor(`fmt-${kind}.wasm`)));
    f.setConfig(FMT_GLOBAL, FMT_CONFIG[kind]);
    made.set(kind, (text, path) => f.formatText({ filePath: path, fileText: text }));
  }
  return made.get(kind)!;
}
const L = (kind: string, text = "") => ({ kind, text });

test("the extensions the button offers are the ones the engine formats", () => {
  assert.deepEqual([...FMT_EXTS].sort(), Object.keys(FMT).sort());
  for (const kind of new Set(Object.values(FMT) as string[])) assert.ok(SHA[`fmt-${kind}`], kind);
});

test("rebuildOld: the old side from the new one and the hunks; undefined when they don't agree", () => {
  const neu = "a\nB\nc\nd\ne\nf\nX\ng\n";
  const lines = [L("hunk", "@@ -1,3 +1,3 @@"), L("ctx", "a"), L("del", "b"), L("add", "B"), L("ctx", "c"), L("hunk", "@@ -6,2 +6,3 @@ fn"), L("ctx", "f"), L("add", "X"), L("ctx", "g")];
  assert.equal(rebuildOld(neu, lines), "a\nb\nc\nd\ne\nf\ng\n");
  // A hunk that only removes: its new side is empty and names the line before.
  assert.equal(rebuildOld("a\nc\n", [L("hunk", "@@ -2,1 +1,0 @@"), L("del", "b")]), "a\nb\nc\n");
  assert.equal(rebuildOld("a\r\nB\r\n", [L("hunk", "@@ -1,2 +1,2 @@"), L("ctx", "a"), L("del", "b"), L("add", "B")]), "a\nb\n");
  assert.equal(rebuildOld(neu, [L("hunk", "@@ -1,1 +1,1 @@"), L("ctx", "nope")]), undefined, "a line not where its hunk says");
  assert.equal(rebuildOld(neu, [L("hunk", "@@ -5 +5 @@"), L("ctx", "e"), L("hunk", "@@ -1 +1 @@"), L("ctx", "a")]), undefined, "hunks going backwards");
  assert.equal(rebuildOld(neu, [L("hunk", "not a header")]), undefined);
  assert.equal(rebuildOld(neu, [L("hunk", "@@ -1 +99 @@"), L("ctx", "a")]), undefined, "past the end");
  assert.equal(rebuildOld(neu, []), undefined, "no hunks");
});

test("onlyFormatting: reflowed TypeScript is the same, a changed value is more, a file that doesn't parse can't tell", async () => {
  const old = "const x = {a: 'b', c: 1}\nfoo(a,\n  b)\nconst f = x => x * 2\n";
  const neu = 'const x = { a: "b", c: 1 };\n\nfoo(a, b);\nconst f = (x) => x * 2;\n';
  const lines = [L("hunk", "@@ -1,4 +1,4 @@"), ...old.trimEnd().split("\n").map((t) => L("del", t)), ...neu.trimEnd().split("\n").map((t) => L("add", t))];
  // The line counts differ (old 4 lines with a wrapped call, new 4 with a blank): the header only places the hunk.
  assert.deepEqual(await onlyFormatting("src/a.ts", neu, lines, format), { verdict: "same" });
  const changed = neu.replace("c: 1", "c: 2");
  const changedLines = [L("hunk", "@@ -1,4 +1,4 @@"), ...old.trimEnd().split("\n").map((t) => L("del", t)), ...changed.trimEnd().split("\n").map((t) => L("add", t))];
  assert.deepEqual(await onlyFormatting("src/a.ts", changed, changedLines, format), { verdict: "more" });
  const broken = "const = = ;\n";
  assert.equal((await onlyFormatting("src/a.ts", broken, [L("hunk", "@@ -1 +1 @@"), L("del", "const x = 1;"), L("add", "const = = ;")], format)).verdict, "unknown");
  assert.equal((await onlyFormatting("src/a.rs", neu, lines, format)).verdict, "unknown", "no formatter for Rust");
  assert.equal((await onlyFormatting("src/a.ts", "something else\n", lines, format)).verdict, "unknown", "the diff isn't of this file");
});

test("onlyFormatting: JSON, TOML and CSS normalise; in Markdown a blank line still counts", async () => {
  const one = (path: string, a: string, b: string) => onlyFormatting(path, b, [L("hunk", "@@ -1 +1 @@"), ...a.split("\n").map((t) => L("del", t)), ...b.split("\n").map((t) => L("add", t))], format);
  assert.equal((await one("a.json", '{"a":1,"b":[1,2]}', '{ "a": 1, "b": [1, 2] }')).verdict, "same");
  assert.equal((await one("a.json", '{"a":1}', '{ "a": 2 }')).verdict, "more");
  assert.equal((await one("a.toml", 'a="x"', 'a = "x"')).verdict, "same");
  assert.equal((await one("a.css", "a{color:red}", "a {\n  color: red;\n}")).verdict, "same");
  assert.equal((await one("a.md", "one\ntwo", "one\n\ntwo")).verdict, "more", "a blank line splits a paragraph");
});

test("onlyFormatting: Python through Ruff, a trailing comma not keeping a list open", async () => {
  const one = (path: string, a: string, b: string) => onlyFormatting(path, b, [L("hunk", "@@ -1 +1 @@"), ...a.split("\n").map((t) => L("del", t)), ...b.split("\n").map((t) => L("add", t))], format);
  assert.equal((await one("a.py", "x = {'a':1}\ndef f( a,b ):\n  return a+b", 'x = {"a": 1}\n\n\ndef f(a, b):\n    return a + b')).verdict, "same");
  assert.equal((await one("a.pyi", "xs = [\n    1,\n    2,\n]", "xs = [1, 2]")).verdict, "same");
  assert.equal((await one("a.py", "x = 1", "x = 2")).verdict, "more");
  assert.equal((await one("a.py", "x = 1", "def (:")).verdict, "unknown", "doesn't parse");
});

test("localSrc: only on a checkout's own diff, with the head or commit it compares", () => {
  const at = (href: string, path = "a.ts") => {
    const u = new URL(href, "http://localhost");
    const s = localSrc(u, path);
    return s && Object.fromEntries(new URLSearchParams(s.split("?")[1]));
  };
  assert.deepEqual(at("/code/my-repo/diff"), { dir: "my-repo", ref: "", path: "a.ts" });
  assert.deepEqual(at("/code/my-repo/diff?base=main&head=feat%2Fx"), { dir: "my-repo", ref: "feat/x", path: "a.ts" });
  assert.deepEqual(at("/code/my-repo/diff?commit=abc123&view=split"), { dir: "my-repo", ref: "abc123", path: "a.ts" });
  assert.equal(at("/prs/acme/web/1/files"), undefined);
  assert.equal(at("/code/my-repo"), undefined);
});

test("srcAsk: only plain repos, full SHAs, refs and relative paths", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(srcAsk({ repo: "acme/web", sha, path: "src/a.ts" }), { kind: "pr", repo: "acme/web", sha, path: "src/a.ts" });
  assert.deepEqual(srcAsk({ dir: "web", ref: "main", path: "a.ts" }), { kind: "local", dir: "web", ref: "main", path: "a.ts" });
  for (const q of [
    { repo: "acme/web", sha: "abc", path: "a.ts" },
    { repo: "../web", sha, path: "a.ts" },
    { repo: "acme/web", sha, path: "../a.ts" },
    { repo: "acme/web", sha, path: "/etc/passwd" },
    { repo: "acme/web", sha, path: "a/./b.ts" },
    { repo: "acme/web", sha, path: "a\\b.ts" },
    { repo: "acme/web", sha, path: "a\0.ts" },
    { dir: "web", ref: "--output=/tmp/x", path: "a.ts" },
    { dir: "web", ref: "-p", path: "a.ts" },
    { dir: "web", ref: "main..HEAD", path: "a.ts" },
    { dir: "web", ref: "main:a.ts", path: "a.ts" },
    { dir: "web", ref: "a b", path: "a.ts" },
    { path: "a.ts" },
    {},
  ])
    assert.equal(srcAsk(q as Record<string, string>), null, JSON.stringify(q));
});

test("readSrc: a PR's file through the forge, only the owners' repos", async () => {
  const reads: string[] = [];
  const forge = { id: "github", name: "GitHub", host: "github.com", login: "me", owners: "acme", owns: (r: string) => r.startsWith("acme/"), file: async (repo: string, path: string, at?: string) => (reads.push(`${repo}:${path}@${at}`), "x = 1\n") };
  const ctx = testContext({ forge: () => forge });
  const sha = "b".repeat(40);
  assert.equal(await readSrc(ctx, { kind: "pr", repo: "acme/web", sha, path: "a.ts" }), "x = 1\n");
  assert.equal(await readSrc(ctx, { kind: "pr", repo: "evil/web", sha, path: "a.ts" }), undefined);
  assert.deepEqual(reads, [`acme/web:a.ts@${sha}`]);
  assert.equal(await readSrc(testContext({ forge: () => undefined }), { kind: "pr", repo: "acme/web", sha, path: "a.ts" }), undefined);
  const big = testContext({ forge: () => ({ ...forge, file: async () => "x".repeat(MAX_SRC + 1) }) });
  assert.equal(await readSrc(big, { kind: "pr", repo: "acme/web", sha, path: "a.ts" }), undefined, "too big");
});

test("readSrc: a checkout's working tree and refs; nothing through a link, outside it, or hosted", async () => {
  const code = mkdtempSync(join(tmpdir(), "cr-src-"));
  const repo = join(code, "web");
  mkdirSync(join(repo, "src"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "one");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  writeFileSync(join(code, "secret.ts"), "nope\n");
  symlinkSync(join(code, "secret.ts"), join(repo, "src/link.ts"));
  symlinkSync(code, join(repo, "up"));
  const run = async (bin: string, args: string[], o?: { cwd?: string }) => {
    try {
      return { code: 0, stdout: execFileSync(bin, args, { cwd: o?.cwd, encoding: "utf8", stdio: "pipe" }), stderr: "" };
    } catch (e) {
      return { code: 1, stdout: "", stderr: String(e) };
    }
  };
  const ctx = testContext({ codeDir: code, run });
  assert.equal(await readSrc(ctx, { kind: "local", dir: "web", ref: "", path: "src/a.ts" }), "export const a = 2;\n", "the working tree");
  assert.equal(await readSrc(ctx, { kind: "local", dir: "web", ref: "main", path: "src/a.ts" }), "export const a = 1;\n", "at a ref");
  assert.equal(await readSrc(ctx, { kind: "local", dir: "web", ref: "main", path: "src/none.ts" }), undefined);
  assert.equal(await readSrc(ctx, { kind: "local", dir: "web", ref: "", path: "src/link.ts" }), undefined, "a link");
  assert.equal(await readSrc(ctx, { kind: "local", dir: "web", ref: "", path: "up/secret.ts" }), undefined, "through a linked folder");
  assert.equal(await readSrc(ctx, { kind: "local", dir: "..", ref: "", path: "secret.ts" }), undefined, "not a checkout");
  assert.equal(await readSrc(testContext({ codeDir: code, run, hosted: true }), { kind: "local", dir: "web", ref: "", path: "src/a.ts" }), undefined, "hosted");
});

test("/code-review/src: hostile queries are 404; the manifest names dprint, its plugins and Ruff", async () => {
  const { get } = packApp([codeReviewPack]);
  for (const q of ["", "?path=a.ts", "?repo=acme/web&sha=x&path=a.ts", "?dir=..&path=etc/passwd", "?dir=web&ref=--output%3D%2Ftmp%2Fx&path=a.ts", "?repo=acme/web&sha=" + "a".repeat(40) + "&path=..%2F..%2Fa.ts"]) {
    assert.equal((await get(`/code-review/src${q}`)).status, 404, q);
  }
  const m = (await (await get("/code-review/langs.json")).json()) as { fmt?: { js: string; ruff?: string; plugins: Record<string, string> } };
  assert.match(m.fmt?.js ?? "", new RegExp(`code-review\\.dprint\\.${DPRINT_JS_SHA}\\.js$`));
  assert.deepEqual(Object.keys(m.fmt!.plugins).sort(), ["css", "json", "markdown", "python", "toml", "typescript"]);
  assert.match(m.fmt?.ruff ?? "", new RegExp(`code-review\\.ruff\\.${RUFF_JS_SHA}\\.js$`));
  assert.equal((await get(m.fmt!.ruff!)).status, 200);
  const wasm = await get(m.fmt!.plugins.typescript!);
  assert.equal(wasm.headers.get("Content-Type"), "application/wasm");
  assert.ok(WebAssembly.validate(new Uint8Array(await wasm.arrayBuffer())));
  assert.equal((await get(m.fmt!.js)).status, 200);
});

test("the PR button: on a changed file a formatter knows, with a forge to read it from; its source escaped", () => {
  const forge = { id: "github", name: "GitHub", host: "github.com", login: "me", owners: "acme", owns: () => true, file: async () => "" };
  const slot = codeReviewPack.slots!(testContext({ forge: () => forge }))["pr.file"]!;
  const pr = { repo: "acme/web", number: 1, branch: "b", title: "t", url: "https://github.com/acme/web/pull/1", sha: "c".repeat(40) };
  const out = String(slot({ ...pr, path: 'src/"><img src=x onerror=alert(1)>.ts', status: "modified" }));
  assert.match(out, /class="btn sm ghost cr-fmt"/);
  assert.doesNotMatch(out, /<img/, "the path is escaped");
  assert.ok(out.includes(prSrc(pr.repo, pr.sha, 'src/"><img src=x onerror=alert(1)>.ts').replace(/&/g, "&amp;")));
  assert.equal(slot({ ...pr, path: "a.ts", status: "added" }), "", "nothing to compare with");
  assert.equal(slot({ ...pr, path: "a.ts", status: "removed" }), "");
  assert.equal(slot({ ...pr, path: "a.rs", status: "modified" }), "", "no formatter");
  assert.equal(slot({ ...pr, path: "a.ts", status: "modified", sha: "abc" }), "", "not a full SHA");
  assert.equal(codeReviewPack.slots!(testContext({ forge: () => undefined }))["pr.file"]!({ ...pr, path: "a.ts", status: "modified" }), "", "no forge, no button");
});
