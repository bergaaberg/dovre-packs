/**
 * HTTP client Pack (`http`): its routes, with a fake fetch (nothing here reaches the network) and a
 * code folder in a temp dir.
 *  - the strict guard: cross-site and wrong-Origin POSTs are refused, nothing is sent on a GET
 *  - send → response page, in memory, secrets masked, logged as http.send
 *  - hostile responses, URLs and file names come out inert
 *  - saving .http files: new = one click, replace = Confirm, re-checked, traversal and symlinks refused
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { html } from "hono/html";
import { openDb } from "dovre/db.ts";
import { testContext } from "dovre/packs/testing.ts";
import { PACK_API, type PackContext } from "dovre/packs/types.ts";
import { STYLE } from "dovre/ui/style.ts";
import { readdirSync } from "node:fs";
import { createHttpPack, httpPack } from "../index.ts";
import { MAX_RESPONSE } from "../send.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const JS_URL = "javascript:alert(1)";
const ORIGIN = "http://localhost";
const SECRET = "s3cr3t-token-value";

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function codeDir() {
  const dir = mkdtempSync(join(tmpdir(), "dovre-http-"));
  mkdirSync(join(dir, "shop", ".git"), { recursive: true });
  mkdirSync(join(dir, "other", ".git"), { recursive: true });
  return dir;
}

function mounted(o: { fetchFn?: typeof fetch; env?: Record<string, string>; timeoutMs?: number; hosted?: boolean } = {}) {
  const code = o.env?.CODE_DIR ?? codeDir();
  const db = openDb();
  const published: string[][] = [];
  const ctx: PackContext = testContext({
    env: { CODE_DIR: code, HTTP_SECRETS: "API_TOKEN@api.example.com", API_TOKEN: SECRET, HTTP_ENVS: '{"dev": {"baseUrl": "https://api.example.com"}}', ...o.env },
    db: db.DB,
    hosted: o.hosted ?? false,
    publish: (t) => void published.push(t),
    page: async (c, p) => c.html(html`${p.head ?? ""}${p.body}`),
  });
  const fake = o.fetchFn ? { fetchFn: o.fetchFn, calls: [] as Call[] } : fakeFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
  const pack = createHttpPack({ fetchFn: fake.fetchFn, timeoutMs: o.timeoutMs });
  const app = new Hono();
  pack.routes!(app as never, ctx);
  const get = (p: string, headers: Record<string, string> = {}) => app.request(`${ORIGIN}${p}`, { headers });
  const post = (p: string, body: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }) =>
    app.request(`${ORIGIN}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
  const actions = async () => (await db.DB.prepare("SELECT kind, target, detail, ok, error FROM actions ORDER BY id").all<{ kind: string; target: string; detail: string | null; ok: number; error: string | null }>()).results;
  return { pack, ctx, db, app, get, post, code, calls: fake.calls, published, actions };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
async function landed(get: (p: string) => Promise<Response> | Response, path: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const out = await (await get(path)).text();
    if (!out.includes("data-pending")) return out;
    await tick();
  }
  throw new Error(`${path} never landed`);
}
const sentPath = (res: Response) => {
  assert.equal(res.status, 303);
  const at = res.headers.get("location")!;
  assert.match(at, /^\/http\/r\/[0-9a-f-]{36}$/);
  return at;
};
const send = (body: Record<string, string>) => ({ method: "GET", mode: "none", headers: "", query: "", body: "", env: "", repo: "", file: "", ...body });

/** Hostile text must arrive escaped: no live tag, no javascript: link. */
function inert(page: string) {
  assert.ok(!page.includes("<script>alert(1)</script>"), "a raw <script> got through");
  assert.ok(!page.includes("<img src=x"), "a raw <img> got through");
  assert.ok(!/href="javascript:/i.test(page), "a javascript: href got through");
  assert.ok(!/src="javascript:/i.test(page));
}

test("manifest: PACK_API, local only, private, its settings; off when hosted", () => {
  assert.equal(httpPack.manifest.api, PACK_API);
  assert.equal(httpPack.manifest.id, "http");
  assert.equal(httpPack.manifest.execution, "local-only");
  assert.equal(httpPack.manifest.private, true);
  assert.deepEqual(httpPack.manifest.settings!.map((s) => s.key), ["HTTP_SECRETS", "HTTP_ENVS"]);
  assert.equal(httpPack.available!(testContext({ hosted: true })), false);
  assert.equal(httpPack.available!(testContext({ hosted: false })), true);
});

test("the strict guard: another site's POST is a 404, a wrong or missing Origin a 403, and nothing is sent", async () => {
  const m = mounted();
  const body = send({ url: "https://api.example.com/x", method: "POST" });
  assert.equal((await m.post("/http/send", body, { origin: ORIGIN, "sec-fetch-site": "cross-site" })).status, 404);
  assert.equal((await m.post("/http/send", body, { origin: ORIGIN, "sec-fetch-site": "same-site" })).status, 404);
  assert.equal((await m.post("/http/send", body, { origin: "https://evil.example" })).status, 403);
  assert.equal((await m.post("/http/send", body, { origin: "null" })).status, 403);
  assert.equal((await m.post("/http/send", body, {})).status, 403);
  assert.equal((await m.post("/http/save", { ...body, repo: "shop", file: "x.http" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await m.post("/http/curl", body, {})).status, 403);
  assert.equal((await m.post("/http/import", { curl: "curl https://h" }, {})).status, 403);
  // Another site linking a page here gets nothing either.
  assert.equal((await m.get("/http", { "sec-fetch-site": "cross-site" })).status, 404);
  assert.equal(m.calls.length, 0);
  assert.deepEqual(readdirSync(join(m.code, "shop")), [".git"]);
});

test("a GET never sends: the editor only works out where it would go", async () => {
  const m = mounted();
  writeFileSync(join(m.code, "shop", ".gitkeep"), "");
  mkdirSync(join(m.code, "shop", ".http"));
  writeFileSync(join(m.code, "shop", ".http", "api.http"), "### Who\nPOST https://api.example.com/me\nAuthorization: Bearer {{API_TOKEN}}\n");
  const page = await (await m.get("/http?repo=shop&file=api.http&n=0")).text();
  assert.match(page, /Goes to <code>https:\/\/api.example.com\/me<\/code>/);
  assert.ok(page.includes("Bearer {{API_TOKEN}}"));
  assert.ok(!page.includes(SECRET));
  await m.get("/http");
  await m.get("/http?repo=shop");
  assert.equal(m.calls.length, 0);
});

test("send: one click, out from here with no redirects followed, the response in memory, masked, logged", async () => {
  const fake = fakeFetch((url, init) =>
    new Response(JSON.stringify({ echoed: new Headers(init.headers).get("authorization"), url }), { status: 201, statusText: "Created", headers: { "content-type": "application/json", "x-token": SECRET } }),
  );
  const m = mounted({ fetchFn: fake.fetchFn });
  const at = sentPath(await m.post("/http/send", send({ method: "POST", url: "{{baseUrl}}/items", query: "q={{API_TOKEN}}", headers: "Authorization: Bearer {{API_TOKEN}}", mode: "json", body: '{"a": 1}', env: "dev", name: "Make" })));
  const page = await landed(m.get, at);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.url, `https://api.example.com/items?q=${SECRET}`);
  assert.equal(fake.calls[0]!.init.redirect, "manual");
  assert.equal(fake.calls[0]!.init.body, '{"a": 1}');
  assert.ok(fake.calls[0]!.init.signal);
  assert.match(page, /201/);
  assert.match(page, /Created/);
  assert.match(page, /&quot;echoed&quot;: &quot;Bearer ••••&quot;/); // pretty JSON, the echoed secret masked
  assert.ok(!page.includes(SECRET), "a secret's value reached the page");
  assert.match(page, /<meta name="u-topics" content="http http-sent:/);
  const s = m.pack.history().list()[0]!;
  assert.ok(!JSON.stringify(s).includes(SECRET), "a secret's value is kept in memory");
  assert.deepEqual(s.out.headers.find(([k]) => k === "Authorization"), ["Authorization", "••••"]);
  const log = await m.actions();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.kind, "http.send");
  assert.equal(log[0]!.target, "POST https://api.example.com/items");
  assert.match(log[0]!.detail!, /^201 · \d+ ms$/);
  assert.ok(!JSON.stringify(log).includes(SECRET));
  assert.ok(m.published.some((t) => t.includes(`http-sent:${s.id}`)));
  // Raw view.
  assert.ok((await (await m.get(`${at}?view=raw`)).text()).includes("{&quot;echoed&quot;"));
  // An unknown id goes home.
  assert.equal((await m.get("/http/r/nope")).status, 303);
});

test("send refused before anything goes: a secret to another host, no URL scheme, missing variables", async () => {
  const m = mounted();
  for (const [body, why] of [
    [send({ url: "https://evil.example/", headers: "Authorization: Bearer {{API_TOKEN}}" }), /only goes to api\.example\.com/],
    [send({ url: JS_URL }), /http:\/\/ or https:\/\//],
    [send({ url: "file:///etc/passwd" }), /Only http/],
    [send({ url: "{{baseUrl}}/x" }), /No value for \{\{baseUrl\}\}/],
    [send({ url: "https://{{API_TOKEN}}/" }), /host can&#39;t come from a secret/],
  ] as const) {
    const res = await m.post("/http/send", body);
    assert.equal(res.status, 400);
    assert.match(await res.text(), why);
  }
  assert.equal(m.calls.length, 0);
  assert.equal(m.pack.history().list().length, 0);
});

test("a redirect is shown, not followed; a slow answer times out; a large one is cut off", async () => {
  const redirect = mounted({ fetchFn: fakeFetch(() => new Response(null, { status: 302, headers: { location: JS_URL } })).fetchFn });
  const page = await landed(redirect.get, sentPath(await redirect.post("/http/send", send({ url: "https://h.example/" }))));
  assert.match(page, /Redirects to<\/dt><dd><code>javascript:alert\(1\)<\/code> <span class="t3">\(not followed\)/);
  inert(page);

  const slow = mounted({
    timeoutMs: 30,
    fetchFn: ((_u: string, init: RequestInit) => new Promise((_, no) => init.signal!.addEventListener("abort", () => no(init.signal!.reason)))) as unknown as typeof fetch,
  });
  const out = await landed(slow.get, sentPath(await slow.post("/http/send", send({ url: "https://h.example/" }))));
  assert.match(out, /no answer within 0 s|timed out/);
  assert.equal((await slow.actions())[0]!.ok, 0);

  const big = mounted({ fetchFn: fakeFetch(() => new Response("x".repeat(MAX_RESPONSE + 5000), { headers: { "content-type": "text/plain" } })).fetchFn });
  const bigPage = await landed(big.get, sentPath(await big.post("/http/send", send({ url: "https://h.example/" }))));
  assert.match(bigPage, /cut off/);
  assert.equal(big.pack.history().list()[0]!.resp!.size, MAX_RESPONSE);

  const bin = mounted({ fetchFn: fakeFetch(() => new Response(new Uint8Array([0x89, 0x50, 0, 1, 2]), { headers: { "content-type": "image/png" } })).fetchFn });
  assert.match(await landed(bin.get, sentPath(await bin.post("/http/send", send({ url: "https://h.example/" })))), /of image\/png: not shown/);
});

test("history is bounded and in memory only", async () => {
  const m = mounted();
  for (let i = 0; i < 30; i++) sentPath(await m.post("/http/send", send({ url: `https://h.example/${i}` })));
  assert.equal(m.pack.history().list().length, 25);
  assert.equal(m.pack.history().list()[0]!.out.url, "https://h.example/29");
});

test("hostile input: response body, headers, status text, URLs, names and file names come out inert", async () => {
  const fake = fakeFetch(() => new Response(`<html><body>${H}<a href="${JS_URL}">x</a></body></html>`, { status: 200, statusText: H.replace(/[<>]/g, ""), headers: { "content-type": "text/html", "x-evil": H, link: `<${JS_URL}>; rel=next`, location: JS_URL } }));
  const m = mounted({ fetchFn: fake.fetchFn });
  mkdirSync(join(m.code, "shop", ".http"));
  writeFileSync(join(m.code, "shop", ".http", "api.http"), `### ${H}\nGET https://h.example/${H}?q=${H}\nX-Name: ${H}\n\n${H}\n`);
  writeFileSync(join(m.code, "shop", ".http", `${H.slice(0, 20).replace(/\//g, "")}.http`), "GET https://h.example/\n");
  const home = await (await m.get(`/http?repo=shop&file=api.http&n=0&env=${encodeURIComponent(H)}`)).text();
  inert(home);
  assert.ok(home.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!home.includes("&lt;script&gt;alert(1).http"), "a file with a hostile name was listed");

  const at = sentPath(await m.post("/http/send", send({ url: `https://h.example/${encodeURIComponent(H)}`, name: H, headers: `X-Name: ${H}` })));
  const page = await landed(m.get, at);
  inert(page);
  assert.ok(page.includes("&lt;html&gt;&lt;body&gt;&lt;script&gt;"), "an HTML response shows as its source");
  inert(await (await m.get("/http")).text());

  const imported = await (await m.post("/http/import", { curl: `curl '${JS_URL}' -H 'X: ${H}' -d '${H}'` })).text();
  inert(imported);
  inert(await (await m.post("/http/curl", send({ url: JS_URL, headers: `X: ${H}` }))).text());
  const bad = await m.post("/http/save", send({ url: `https://h.example/`, name: H, repo: "shop", file: `${H}.http` }));
  assert.equal(bad.status, 400);
  inert(await bad.text());
});

test("every class the views use is styled by core's stylesheet", () => {
  const src = ["view.ts", "index.ts"].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  const missing = new Set<string>();
  for (const m of src.matchAll(/class="([^"]*)"/g))
    for (const name of m[1]!.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean)) if (/^[a-z][a-z0-9-]*$/.test(name) && !new RegExp(`\\.${name}(?![a-z0-9-])`).test(STYLE)) missing.add(name);
  assert.deepEqual([...missing], []);
});

test("save: a new file is one click, logged; secrets' values are never written", async () => {
  const m = mounted();
  const res = await m.post("/http/save", send({ method: "POST", url: "{{baseUrl}}/items", headers: "Authorization: Bearer {{API_TOKEN}}", mode: "json", body: '{"a": 1}', name: "Make one", repo: "shop", file: "api.http", env: "dev" }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/http?repo=shop&file=api.http&n=0&env=dev&saved=1");
  const text = readFileSync(join(m.code, "shop", ".http", "api.http"), "utf8");
  assert.equal(text, `### Make one\nPOST {{baseUrl}}/items\nAuthorization: Bearer {{API_TOKEN}}\nContent-Type: application/json\n\n{"a": 1}\n`);
  assert.deepEqual((await m.actions()).map((a) => [a.kind, a.target, a.detail, a.ok]), [["http.save", "shop/.http/api.http", "created · POST Make one", 1]]);
  assert.match(await (await m.get(res.headers.get("location")!)).text(), /Saved in <code>shop\/.http\/api.http<\/code>/);

  // Added to the end of a file that's there: one click too, nothing that was there changes.
  assert.equal((await m.post("/http/save", send({ url: "https://h.example/2", name: "Two", repo: "shop", file: "api.http" }))).status, 303);
  assert.ok(readFileSync(join(m.code, "shop", ".http", "api.http"), "utf8").startsWith(text.trimEnd() + "\n\n### Two\nGET https://h.example/2"));

  // A secret's literal value.
  const leak = await m.post("/http/save", send({ url: "https://api.example.com/", headers: `Authorization: Bearer ${SECRET}`, repo: "shop", file: "leak.http" }));
  assert.equal(leak.status, 400);
  assert.match(await leak.text(), /API_TOKEN&#39;s value in it/);
  assert.throws(() => readFileSync(join(m.code, "shop", ".http", "leak.http")));
});

test("save: replacing a request is a Confirm, re-checked against the file as it was opened", async () => {
  const m = mounted();
  mkdirSync(join(m.code, "shop", ".http"));
  const file = join(m.code, "shop", ".http", "api.http");
  writeFileSync(file, "@baseUrl = https://h.example\n\n### one\nGET {{baseUrl}}/1\n\n### two\nGET {{baseUrl}}/2\n");
  const opened = await (await m.get("/http?repo=shop&file=api.http&n=1")).text();
  const hash = /name="hash" value="([0-9a-f]+)"/.exec(opened)![1]!;
  const edit = send({ method: "DELETE", url: "{{baseUrl}}/2", name: "two", repo: "shop", file: "api.http", opened: "api.http", n: "1", hash });

  // First click: the question, nothing written.
  const first = await m.post("/http/save", edit);
  assert.equal(first.status, 200);
  const q = await first.text();
  assert.match(q, /This replaces <strong>GET two<\/strong>/);
  assert.match(q, /<details class="confirm">/);
  assert.deepEqual(httpPack.writes, [{ kind: "replace", label: "Replace a saved request in a .http file" }], "Settings → Writes can make it one click (dovre#104)");
  assert.match(q, /name="confirm" value="1"/);
  assert.ok(readFileSync(file, "utf8").includes("GET {{baseUrl}}/2"));
  assert.equal((await m.actions()).length, 0);

  // Second click writes it; the other request and the file's variable stay.
  assert.equal((await m.post("/http/save", { ...edit, confirm: "1" })).status, 303);
  const after = readFileSync(file, "utf8");
  assert.match(after, /^@baseUrl = https:\/\/h.example\n\n### one\nGET \{\{baseUrl\}\}\/1\n\n### two\nDELETE \{\{baseUrl\}\}\/2\n$/);
  assert.equal((await m.actions())[0]!.detail, "replaced #2 · DELETE two");

  // The old hash no longer matches: refused, logged, untouched.
  const stale = await m.post("/http/save", { ...edit, method: "PUT", confirm: "1" });
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /changed since it was opened/);
  assert.equal(readFileSync(file, "utf8"), after);
  assert.equal((await m.actions()).at(-1)!.ok, 0);
});

test("save and open: only plain names in checkouts directly under CODE_DIR; traversal and symlinks refused", async () => {
  const m = mounted();
  const outside = mkdtempSync(join(tmpdir(), "dovre-http-out-"));
  for (const [repo, file, why] of [
    ["..", "x.http", /Pick a repo/],
    ["../shop", "x.http", /Pick a repo/],
    ["nope", "x.http", /Pick a repo/],
    ["shop", "../x.http", /plain name/],
    ["shop", "..%2Fx.http", /plain name/],
    ["shop", "sub/x.http", /plain name/],
    ["shop", ".hidden.http", /plain name/],
    ["shop", "x.txt", /plain name/],
    ["shop", "x..http", /plain name/],
  ] as const) {
    const res = await m.post("/http/save", send({ url: "https://h.example/", repo, file }));
    assert.equal(res.status, 400, `${repo} ${file}`);
    assert.match(await res.text(), why);
  }

  // A repo that's a symlink to somewhere else isn't a checkout here.
  mkdirSync(join(outside, "elsewhere", ".git"), { recursive: true });
  symlinkSync(join(outside, "elsewhere"), join(m.code, "linked"));
  assert.equal((await m.post("/http/save", send({ url: "https://h.example/", repo: "linked", file: "x.http" }))).status, 400);

  // .http as a symlink out of the repo.
  symlinkSync(outside, join(m.code, "other", ".http"));
  const viaDir = await m.post("/http/save", send({ url: "https://h.example/", repo: "other", file: "x.http" }));
  assert.equal(viaDir.status, 400);
  assert.match(await viaDir.text(), /isn&#39;t a plain folder/);
  assert.deepEqual(readdirSync(outside), ["elsewhere"]);
  assert.match(await (await m.get("/http?repo=other&file=x.http")).text(), /isn&#39;t a plain folder/);

  // A file that's a symlink: neither read nor written through.
  mkdirSync(join(m.code, "shop", ".http"));
  writeFileSync(join(outside, "target.http"), "GET https://h.example/secret-file\n");
  symlinkSync(join(outside, "target.http"), join(m.code, "shop", ".http", "link.http"));
  const read = await (await m.get("/http?repo=shop&file=link.http")).text();
  assert.match(read, /isn&#39;t a plain file/);
  assert.ok(!read.includes("secret-file"));
  const write = await m.post("/http/save", send({ url: "https://h.example/", repo: "shop", file: "link.http" }));
  assert.equal(write.status, 400);
  assert.equal(readFileSync(join(outside, "target.http"), "utf8"), "GET https://h.example/secret-file\n");
  // And the listing leaves it out.
  assert.ok(!(await (await m.get("/http?repo=shop")).text()).includes("link.http"));
  assert.match(await (await m.get("/http?repo=..&file=x.http")).text(), /isn&#39;t a checkout/);
});

test("environments: the repo's .http/http-client.env.json and mine, offered by name; values not shown", async () => {
  const m = mounted();
  mkdirSync(join(m.code, "shop", ".http"));
  writeFileSync(join(m.code, "shop", ".http", "http-client.env.json"), JSON.stringify({ staging: { baseUrl: "https://staging.example" } }));
  const page = await (await m.get("/http?repo=shop")).text();
  assert.match(page, /<option value="dev">dev<\/option>/);
  assert.match(page, /<option value="staging">staging<\/option>/);
  const at = sentPath(await m.post("/http/send", send({ url: "{{baseUrl}}/ping", env: "staging", repo: "shop" })));
  await landed(m.get, at);
  assert.equal(m.calls[0]!.url, "https://staging.example/ping");
});

test("import from curl and copy as curl: nothing sent, a secret's value never shown", async () => {
  const m = mounted();
  const page = await (await m.post("/http/import", { curl: `curl -X POST 'https://api.example.com/items' -H 'Authorization: Bearer ${SECRET}' --data-raw '{"a":1}'` })).text();
  assert.ok(!page.includes(SECRET));
  assert.ok(page.includes("Bearer {{API_TOKEN}}"));
  assert.match(page, /Imported: nothing was sent/);
  const curl = await (await m.post("/http/curl", send({ url: "{{baseUrl}}/x", env: "dev", headers: "Authorization: Bearer {{API_TOKEN}}" }))).text();
  assert.ok(curl.includes(`curl &#39;https://api.example.com/x&#39;`));
  assert.ok(curl.includes(`&quot;$API_TOKEN&quot;`));
  assert.ok(!curl.includes(SECRET));
  const bad = await m.post("/http/import", { curl: `curl 'unclosed ${SECRET}` });
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes(SECRET));
  assert.equal(m.calls.length, 0);
});

test("the actions log names its kinds; settings show secrets' names and hosts, never values", () => {
  const ctx = testContext({ env: { HTTP_SECRETS: "API_TOKEN@api.example.com,GONE@h", API_TOKEN: SECRET } });
  const slots = httpPack.slots!(ctx);
  assert.equal(slots["actions.what"]!({ kind: "http.send" }), "Sent an HTTP request");
  assert.equal(slots["actions.what"]!({ kind: "http.save" }), "Saved an HTTP request to a repo");
  assert.equal(slots["actions.what"]!({ kind: "other" }), undefined);
  const s = String(httpPack.settings!(ctx));
  assert.match(s, /API_TOKEN<\/code> to api.example.com/);
  assert.match(s, /GONE<\/code> to h \(not set on this machine\)/);
  assert.ok(!s.includes(SECRET));
});

test("a secret's value typed into the editor is drawn back as its {{NAME}}, never as itself", async () => {
  const m = mounted();
  const at = sentPath(await m.post("/http/send", send({ url: "https://api.example.com/x", headers: `Authorization: Bearer ${SECRET}` })));
  const page = await landed(m.get, at);
  assert.ok(!page.includes(SECRET));
  assert.ok(page.includes("Bearer {{API_TOKEN}}"));
  assert.equal(new Headers(m.calls[0]!.init.headers).get("authorization"), `Bearer ${SECRET}`);
  // Its value written out goes only where the secret may go.
  const refused = await m.post("/http/send", send({ url: "https://evil.example/x", headers: `X: ${SECRET}` }));
  assert.equal(refused.status, 400);
  const text = await refused.text();
  assert.match(text, /API_TOKEN&#39;s value in it, which only goes to api.example.com, not evil.example/);
  assert.ok(!text.includes(SECRET));
  assert.equal(m.calls.length, 1);
});
