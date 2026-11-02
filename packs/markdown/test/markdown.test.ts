/** Markdown (`markdown`): rendering, hostile documents staying inert, the routes and their guard, and docs in checkouts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HOSTILE, assertFragment, assertInert, assertScoped, packApp, testContext } from "dovre/packs/testing.ts";
import { markdownPack } from "../index.ts";
import { render, slug } from "../render.ts";
import { cleanPath, listDocs } from "../docs.ts";
import { GRAPHVIZ_SHA, KATEX_SHA, MERMAID_SHA } from "../gen.ts";
import { SCRIPT } from "../script.ts";
import { body } from "../view.ts";

/** No live markup from the document: no script, no handler, no javascript: link, no outside picture. */
const inert = (name: string, out: string) => {
  assertInert(name, out);
  assert.ok(!/<script/i.test(out), `${name}: a script tag got through`);
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(out.replace(/"[^"]*"/g, '""')), `${name}: an event handler got through`);
  assert.ok(!/href="\s*javascript:/i.test(out), `${name}: a javascript: link got through`);
  assert.ok(!/<img[^>]+src="(https?:|\/\/|javascript:)/i.test(out), `${name}: a picture from elsewhere got through`);
  assert.ok(!/<(iframe|object|embed|form|style|base|meta|link)\b/i.test(out), `${name}: page markup got through`);
};

test("markdown: manifest, styles scoped, mermaid's, KaTeX's and Graphviz's files match their hashes", () => {
  assert.equal(markdownPack.manifest.id, "markdown");
  assert.equal(markdownPack.manifest.execution, "any");
  assert.equal(markdownPack.manifest.private, true);
  assertScoped(markdownPack);
  for (const [name, sha] of [["mermaid.js", MERMAID_SHA], ["katex.js", KATEX_SHA], ["graphviz.js", GRAPHVIZ_SHA]] as const) {
    const bytes = readFileSync(new URL(`../vendor/${name}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex").slice(0, 16), sha, "run build.sh: gen.ts is stale");
    assert.equal(markdownPack.files?.[name]?.sha256, sha);
    assert.doesNotMatch(bytes.toString("utf8").slice(-300), /sourceMappingURL/, `${name}: no map is shipped`);
  }
  assert.deepEqual(Object.entries(markdownPack.files ?? {}).filter(([, f]) => (f as { wasm?: boolean }).wasm).map(([n]) => n), ["graphviz.js"], "only Graphviz compiles WebAssembly");
});

test("markdown: GitHub-flavoured features", () => {
  const r = render(`# Title
## Title
- [ ] open
- [x] done

> [!NOTE]
> Read this.

| a | b |
|---|---|
| 1 | 2 |

~~gone~~ https://example.com/x and a footnote[^1].

[^1]: The note.`);
  assert.deepEqual(r.headings.map((h) => h.id), ["md-title", "md-title-1"], "ids as GitHub makes them, deduplicated and prefixed");
  assert.match(r.html, /<input type="checkbox" class="md-task" disabled> open/);
  assert.match(r.html, /<input type="checkbox" class="md-task" disabled checked> done/);
  assert.match(r.html, /<blockquote class="md-alert md-alert-note">\n<p class="md-alert-title">Note<\/p>\n<p>Read this.<\/p>/);
  assert.match(r.html, /<div class="md-table"><table>/);
  assert.match(r.html, /<s>gone<\/s>/);
  assert.match(r.html, /<a href="https:\/\/example.com\/x" target="_blank" rel="noopener noreferrer">/);
  assert.match(r.html, /class="footnote-ref"><a href="#fnmd-1"/);
  assert.equal(slug("Hello, World! (v2)"), "hello-world-v2");
});

test("markdown: math and mermaid left as their source for the browser, money left alone", () => {
  const r = render("Costs $5 and $6. Then $x^2$ and $`\\sqrt{2}`$.\n\n$$\n\\frac{a}{b}\n$$\n\n```math\nE = mc^2\n```\n\n```mermaid\ngraph LR; A-->B\n```");
  assert.match(r.html, /Costs \$5 and \$6\./);
  assert.equal(r.math, 4);
  assert.match(r.html, /<code class="md-tex">x\^2<\/code> and <code class="md-tex">\\sqrt\{2\}<\/code>/);
  assert.match(r.html, /<div class="md-math"><pre class="md-tex" data-display>\\frac\{a\}\{b\}<\/pre><\/div>/);
  assert.match(r.html, /<pre class="md-tex" data-display>E = mc\^2\n<\/pre>/);
  assert.doesNotMatch(r.html, /<math/, "KaTeX isn't on the server");
  const hostile = render("$<img src=x onerror=alert(1)>$ and\n\n$$\n</pre><script>alert(1)</script>\n$$");
  assert.equal(hostile.math, 2);
  assert.doesNotMatch(hostile.html, /<script|<img/i, "a formula's TeX is text");
  assert.equal(r.mermaid, 1);
  assert.match(r.html, /<pre class="md-mermaid">graph LR; A--&gt;B\n<\/pre>/);
  const g = render('```dot\ndigraph { a -> b [URL="javascript:alert(1)"] }\n```\n\n```graphviz\ngraph { "</pre><script>" }\n```');
  assert.equal(g.dot, 2);
  assert.match(g.html, /<pre class="md-dot">digraph \{ a -&gt; b \[URL=&quot;javascript:alert\(1\)&quot;\] \}\n<\/pre>/);
  assert.doesNotMatch(g.html, /<script/);
});

test("markdown: front matter as a table, or as written when it isn't a map", () => {
  assert.deepEqual(render("---\ntitle: Hi\ntags: [a, b]\n---\n# Body").front, { pairs: [["title", "Hi"], ["tags", '["a","b"]']] });
  assert.deepEqual(render("---\n- a\n---\nx").front, { text: "- a" });
  assert.equal(render("no front matter\n---\n").front, undefined);
});

test("markdown: a hostile document stays text", () => {
  const doc = `# ${HOSTILE}
<script>alert(1)</script>
<img src=x onerror=alert(1)>
<iframe src="https://evil.example"></iframe>
[click](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>) [vb](vbscript:x)
[rel](../../../etc/passwd) ![pic](https://evil.example/track.png) ![js](javascript:alert(1))
[t](https://ok.example "title\\" onmouseover=\\"alert(1)")
$\\href{javascript:alert(1)}{x}$ $\\url{javascript:alert(1)}$
\`\`\`mermaid
</pre><script>alert(1)</script>
\`\`\`
\`\`\`"><script>alert(1)</script>
x
\`\`\`
---
<style>body{display:none}</style>

> [!NOTE] ${HOSTILE}

- [x] ${HOSTILE}

| ${HOSTILE} |
|---|
| <b onclick=1>x</b> |
`;
  const r = render(doc);
  inert("render", r.html);
  assertFragment("render", r.html);
  assert.doesNotMatch(r.html, /<a [^>]*href="(?!https:\/\/|#)/, "only http(s) links and the document's own headings");
  const fm = render(`---\ntitle: "${HOSTILE}"\n${HOSTILE}: 1\n---\n`);
  assert.ok(fm.front, "front matter that isn't YAML is shown as written");
  const fm2 = render(`---\ntitle: "${HOSTILE.replace(/"/g, "'")}"\n---\n`);
  assert.ok(fm2.front && "pairs" in fm2.front);
  for (const f of [fm, fm2]) {
    const shown = String(body(f, undefined));
    inert("front matter", shown);
    assertFragment("front matter", shown);
  }
});

test("markdown: write, preview, export and print over the app; posts only from Dovre itself", async () => {
  const { get, post } = packApp([markdownPack]);
  const page = await (await get("/markdown")).text();
  assert.match(page, /data-md-live/);
  assert.match(page, new RegExp(`data-mermaid="/assets/files/markdown\\.mermaid\\.${MERMAID_SHA}\\.js" data-katex="/assets/files/markdown\\.katex\\.${KATEX_SHA}\\.js"`));
  const doc = `# ${HOSTILE}\n\n<script>alert(1)</script> [x](javascript:alert(1))\n\n\`\`\`mermaid\ngraph LR; A-->B\n\`\`\``;

  const shown = await post("/markdown", { src: doc });
  assert.equal(shown.status, 200);
  const html = await shown.text();
  assertFragment("write", html);
  assert.match(html, /<pre class="md-mermaid">/);
  assert.equal((html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) ?? []).length, 2, "in the textarea and in the preview, as text");

  const frag = await post("/markdown/preview", { src: doc });
  assert.equal(frag.headers.get("Cache-Control"), "no-store");
  const f = await frag.text();
  inert("preview", f);
  assertFragment("preview", f);

  const exp = await post("/markdown/export", { src: doc });
  assert.match(exp.headers.get("Content-Disposition") ?? "", /attachment; filename="document.html"/);
  const e = await exp.text();
  assert.match(e, /^<!doctype html><html lang="en">/);
  assert.match(e, /<title>&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(e, /<script/i, "an exported file runs nothing");

  const pr = await (await post("/markdown/print", { src: doc })).text();
  const js = /<script src="(\/markdown\/print\.[a-z0-9]+\.js)" defer><\/script>/.exec(pr);
  assert.ok(js, "the print page brings its own script");
  assert.match(pr, /data-mermaid="\/assets\/files\/markdown\.mermaid\.[^"]+" data-katex="\/assets\/files\/markdown\.katex\./);
  const printJs = await get(js[1]!);
  assert.equal(printJs.headers.get("Content-Type"), "text/javascript; charset=utf-8");
  assert.match(await printJs.text(), /securityLevel: "strict"/);

  const mermaid = await get(`/assets/files/markdown.mermaid.${MERMAID_SHA}.js`);
  assert.equal(mermaid.status, 200, "core serves mermaid from the pack's folder");
  assert.match((await mermaid.text()).slice(-200), /globalThis\["mermaid"\]/);
  const katex = await get(`/assets/files/markdown.katex.${KATEX_SHA}.js`);
  assert.equal(katex.status, 200, "core serves KaTeX from the pack's folder");
  assert.match(katex.headers.get("Content-Type") ?? "", /javascript/);

  for (const path of ["/markdown", "/markdown/preview", "/markdown/export", "/markdown/print"]) {
    const cross = await post(path, { src: doc }, { origin: "https://evil.example" });
    assert.notEqual(cross.status, 200, `${path} takes a post from elsewhere`);
    const site = await post(path, { src: doc }, { "sec-fetch-site": "cross-site" });
    assert.equal(site.status, 404, `${path} answers a cross-site request`);
  }
  const big = await post("/markdown/preview", "x", { "content-length": String(10_000_000) });
  assert.equal(big.status, 413);
});

test("markdown: the script draws diagrams strictly and only where there's a document", () => {
  assert.match(SCRIPT, /securityLevel: "strict"/);
  assert.match(SCRIPT, /cleanSvg\(gv\.dot\(text, "svg"\)\)/, "Graphviz's SVG is cleaned before it's shown");
  assert.match(SCRIPT, /if \(!document\.querySelector\("\[data-md-doc\], form\[data-md-live\]"\)\) return;/);
  assert.doesNotMatch(SCRIPT, /dovre:change/);
  assert.match(SCRIPT, /\.md pre\.code\[data-lang\]/, "core's Markdown fences, by the language core marks");
  assert.match(SCRIPT, /typeof dovreFiles === "object"/, "an older core without dovreFiles draws nothing there");
  new Function(SCRIPT); // it parses
});

function checkouts() {
  const dir = mkdtempSync(join(tmpdir(), "md-code-"));
  const repo = join(dir, "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "docs", "guide"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "lib"), { recursive: true });
  writeFileSync(
    join(repo, "README.md"),
    `# App\n\nSee [the guide](docs/guide.md#Getting-Started), [setup](docs/guide/), [gone](docs/missing.md), [out](../../secret.md), [code](src/x.ts), [up](/docs/guide.md).\n\n![logo](docs/logo.png) ![nope](docs/nope.png) ![svg-ish](docs/guide.md)\n\n# ${HOSTILE}`,
  );
  writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n\n## Getting started\n\nBack to [README](../README.md).");
  writeFileSync(join(repo, "docs", "guide", "README.md"), "# Setup");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "x.ts"), "export {};");
  writeFileSync(join(repo, "docs", "logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(repo, "node_modules", "lib", "README.md"), "# Not mine");
  writeFileSync(join(dir, "secret.md"), "# Secret");
  symlinkSync(join(dir, "secret.md"), join(repo, "docs", "leak.md"));
  mkdirSync(join(dir, "not-a-repo"));
  return { dir, repo };
}

test("markdown: docs in checkouts, links resolved and broken ones flagged, nothing outside the checkout", async () => {
  const { dir } = checkouts();
  const { get } = packApp([markdownPack], { codeDir: dir });

  const repos = await (await get("/markdown/docs")).text();
  assert.match(repos, /href="\/markdown\/docs\/app"/);
  assert.doesNotMatch(repos, /not-a-repo/);

  const list = await (await get("/markdown/docs/app")).text();
  assert.match(list, /README\.md[\s\S]*docs\/guide\.md/, "README first");
  assert.doesNotMatch(list, /node_modules/);

  const readme = await (await get("/markdown/docs/app/README.md")).text();
  assertFragment("doc", readme);
  assertInert("doc", readme);
  assert.match(readme, /href="\/markdown\/docs\/app\/docs\/guide\.md#md-getting-started"/);
  assert.match(readme, /href="\/markdown\/docs\/app\/docs\/guide\/README\.md"/, "a folder opens its README");
  assert.match(readme, /href="\/markdown\/docs\/app\/docs\/guide\.md">up/, "a path from the repo's root");
  assert.match(readme, /class="md-broken" title="Not found: docs\/missing\.md"/);
  assert.match(readme, /class="md-broken" title="Not found: \.\.\/\.\.\/secret\.md"/, "out of the checkout is broken, never read");
  assert.match(readme, /class="md-nolink" title="src\/x\.ts"/, "a source file stays text");
  assert.match(readme, /<img src="\/markdown\/raw\/app\/docs\/logo\.png" alt="logo"/);
  assert.match(readme, /Broken links/);
  assert.match(readme, /name="from" value="app\/README\.md"/);

  const png = await get("/markdown/raw/app/docs/logo.png");
  assert.equal(png.headers.get("Content-Type"), "image/png");
  assert.equal(png.headers.get("X-Content-Type-Options"), "nosniff");

  for (const bad of ["/markdown/docs/app/docs/leak.md", "/markdown/docs/app/..%2F..%2Fsecret.md", "/markdown/docs/app/%2E%2E/%2E%2E/secret.md", "/markdown/docs/app/.git/config", "/markdown/docs/nope/README.md", "/markdown/docs/not-a-repo", "/markdown/raw/app/README.md", "/markdown/raw/app/..%2F..%2Fsecret.md"]) {
    const res = await get(bad);
    assert.equal(res.status, 404, bad);
    assert.doesNotMatch(await res.text(), /Secret/, bad);
  }
});

test("markdown: hosted, docs are local only and paste still works", async () => {
  const { dir } = checkouts();
  const a = new Hono();
  const ctx = testContext({ hosted: true, codeDir: dir, page: async (_c, o) => new Response(String(await o.body), { headers: { "content-type": "text/html" } }) });
  markdownPack.routes!(a as never, ctx);
  const get = (p: string) => a.request(`http://localhost${p}`);
  assert.match(await (await get("/markdown/docs")).text(), /only on a local Dovre/);
  assert.match(await (await get("/markdown/docs/app/README.md")).text(), /only on a local Dovre/);
  assert.equal((await get("/markdown/raw/app/docs/logo.png")).status, 404);
  assert.doesNotMatch(await (await get("/markdown")).text(), /Docs in checkouts/);
  assert.equal(markdownPack.pages!(ctx).some((p) => p.href === "/markdown/docs"), false);
  const pv = await a.request("http://localhost/markdown/preview", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: "src=%23+hi" });
  assert.match(await pv.text(), /<h1 id="md-hi">hi<\/h1>/);
});

test("markdown: paths in a checkout", () => {
  assert.equal(cleanPath("docs/a.md"), "docs/a.md");
  assert.equal(cleanPath("/docs/./a.md"), "docs/a.md");
  for (const bad of ["../x.md", "docs/../../x.md", ".git/config", "a/.env", "a\\b.md", "a\0.md", ""]) assert.equal(cleanPath(bad), null, bad);
  const { repo } = checkouts();
  const { files } = listDocs(repo);
  assert.deepEqual(files, ["README.md", "docs/guide.md", "docs/guide/README.md"], "a symlink isn't listed");
});

test("markdown: a PR's .md file read rendered at its head commit, through the forge's reads only", async () => {
  const { prDocHref, prDocOf } = await import("../pr.ts");
  const SHA = "c".repeat(40);
  const asked: string[] = [];
  const forge = {
    id: "github", name: "GitHub", host: "github.com", login: "me", owners: "acme",
    file: async (repo: string, path: string, at?: string) => {
      asked.push(`${repo} ${path} ${at}`);
      if (path === "docs/guide.md") return `# Guide ${HOSTILE}\n\n[next](./next.md#Part-2) · [code](../src/a.ts) · [up](../../../etc/passwd)\n\n![logo](logo.png)\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n`;
      return undefined;
    },
  };
  const a = new Hono();
  const ctx = testContext({ forge: () => forge, file: (n) => `/files/${n}`, page: async (_c, o) => new Response(String(await o.body), { headers: { "content-type": "text/html" } }) });
  markdownPack.routes!(a as never, ctx);
  const get = (p: string) => a.request(`http://localhost${p}`);

  // The slot: a button on .md files that are still there, nothing on others.
  const slot = markdownPack.slots!(ctx)["pr.file"]!;
  const pr = { repo: "acme/site", number: 7, branch: "b", title: "t", url: "https://github.com/acme/site/pull/7", sha: SHA };
  const btn = String(await slot({ ...pr, path: "docs/guide.md", status: "modified" }));
  assert.match(btn, new RegExp(`href="/markdown/pr/acme/site/7/${SHA}/docs/guide.md">Rendered</a>`));
  assert.equal(slot({ ...pr, path: "docs/guide.md", status: "removed" }), "");
  assert.equal(slot({ ...pr, path: "src/a.ts", status: "added" }), "");
  assert.equal(markdownPack.slots!(testContext({ forge: () => undefined }))["pr.file"]!({ ...pr, path: "a.md", status: "added" }), "", "no forge reads, no button");

  const res = await get(prDocHref({ repo: "acme/site", n: 7, sha: SHA, path: "docs/guide.md" }));
  assert.equal(res.status, 200);
  const out = await res.text();
  assertInert("pr doc", out);
  assert.deepEqual(asked, [`acme/site docs/guide.md ${SHA}`]);
  assert.match(out, new RegExp(`href="/markdown/pr/acme/site/7/${SHA}/docs/next.md#md-part-2"`), "a doc link stays at that commit");
  assert.match(out, new RegExp(`href="https://github.com/acme/site/blob/${SHA}/src/a.ts"`), "other files on the forge");
  assert.match(out, /md-broken[^>]*etc\/passwd/, "a link out of the repo is broken");
  assert.doesNotMatch(out, /<img/, "pictures aren't fetched");
  assert.match(out, /data-mermaid="\/files\/mermaid.js"/);
  assert.match(out, /href="\/prs\/acme\/site\/7\/files">acme\/site#7</);

  for (const bad of [`/markdown/pr/acme/site/7/main/docs/guide.md`, `/markdown/pr/acme/site/7/${SHA}/src/a.ts`, `/markdown/pr/acme/site/0/${SHA}/a.md`, `/markdown/pr/acme/site/7/${SHA}/..%2F..%2Fx.md`, `/markdown/pr/acme/site/7/${SHA}/missing.md`]) {
    assert.equal((await get(bad)).status, 404, bad);
  }
  assert.equal(asked.length, 2, "only a well-formed path reaches the forge");
  assert.equal(prDocOf("a b", "site", "1", SHA, "a.md"), null);
});

test("markdown: the dock, a scratch pad with a live preview that goes on to the editor", async () => {
  assert.deepEqual(markdownPack.dock!({} as never), { label: "Markdown", key: "M", title: "A scratch pad with a live preview: math and diagrams too" });
  const { get, post } = packApp([markdownPack]);
  const dock = await (await get("/markdown/dock")).text();
  assert.match(dock, /<form method="post" action="\/markdown\/dock" class="md-editor" data-md-live/);
  assert.match(dock, /formaction="\/markdown" formtarget="_top">Open in the editor/);
  assert.match(dock, /data-mermaid="\/assets\/files\/markdown\.mermaid\./);
  const out = await (await post("/markdown/dock", { src: `# ${HOSTILE}\n\n$x^2$` })).text();
  assertInert("dock", out);
  assertFragment("dock", out);
  assert.match(out, /class="md-tex"/);
  assert.equal((await post("/markdown/dock", { src: "x" }, { origin: "https://evil.example" })).status, 403);
});
