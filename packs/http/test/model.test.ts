/**
 * HTTP client (`http`): the request model, without any I/O — .http files in and out, variables,
 * secrets bound to hosts, masking, curl in and out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { blankReq, fromCurl, fullUrl, masker, parseEnvs, parseHttp, parseSecrets, placeholdSecrets, prepare, type Req, reqOfForm, secretIn, serializeReq, shellWords, toCurl, varsOf, withReq } from "../model.ts";

const req = (over: Partial<Req> = {}): Req => ({ ...blankReq(), ...over });
const secrets = parseSecrets("API_TOKEN@api.example.com, API_TOKEN@localhost:3000, LOCAL@localhost, bad, x@", { API_TOKEN: "s3cr3t-token", LOCAL: "local-value-1" });

test(".http files: requests, names, file variables, query lines, headers, bodies", () => {
  const p = parseHttp(`@baseUrl = https://api.example.com
@user = kari

### List items
GET {{baseUrl}}/items?page=1&size=10
Accept: application/json

###
# @name create
POST {{baseUrl}}/items HTTP/1.1
Content-Type: application/json
# a comment in the headers

{ "name": "{{user}}" }

###
POST {{baseUrl}}/login
  ?next=/home
  &x=1
Content-Type: application/x-www-form-urlencoded

user=kari
&pass={{PASS}}

### just a url
https://example.com/health
`);
  assert.deepEqual(p.vars, { baseUrl: "https://api.example.com", user: "kari" });
  assert.equal(p.reqs.length, 4);
  assert.equal(p.reqs[0]!.name, "List items");
  assert.equal(p.reqs[0]!.url, "{{baseUrl}}/items");
  assert.deepEqual(p.reqs[0]!.query, ["page=1", "size=10"]);
  assert.deepEqual(p.reqs[0]!.headers, [["Accept", "application/json"]]);
  assert.equal(p.reqs[0]!.mode, "none");
  assert.equal(p.reqs[1]!.name, "create");
  assert.equal(p.reqs[1]!.method, "POST");
  assert.equal(p.reqs[1]!.mode, "json");
  assert.equal(p.reqs[1]!.body, '{ "name": "{{user}}" }');
  assert.deepEqual(p.reqs[2]!.query, ["next=/home", "x=1"]);
  assert.equal(p.reqs[2]!.mode, "form");
  assert.equal(p.reqs[2]!.body, "user=kari\npass={{PASS}}");
  assert.equal(p.reqs[3]!.method, "GET");
  assert.equal(p.reqs[3]!.url, "https://example.com/health");
});

test("a request saved and read back is the same request; replacing one keeps the rest", () => {
  const r = req({ name: "Make one", method: "POST", url: "{{baseUrl}}/x", query: ["a=1"], headers: [["X-Thing", "y"]], mode: "json", body: '{\n  "a": 1\n}' });
  const back = parseHttp(serializeReq(r)).reqs[0]!;
  const { span: _s, ...plain } = back;
  assert.deepEqual(plain, { ...r, headers: [["X-Thing", "y"], ["Content-Type", "application/json"]] });
  const form = req({ method: "POST", url: "http://h/", mode: "form", body: "a=1\nb=2" });
  assert.equal(parseHttp(serializeReq(form)).reqs[0]!.body, "a=1\nb=2");
  // A body line starting with ### would split the request when read back.
  assert.equal(parseHttp(serializeReq(req({ method: "POST", url: "http://h/", mode: "raw", body: "a\n### not a split" }))).reqs.length, 1);

  const file = `@baseUrl = http://localhost:3000\n\n### one\nGET {{baseUrl}}/1\n\n### two\nGET {{baseUrl}}/2\n\n### three\nGET {{baseUrl}}/3\n`;
  const next = withReq(file, req({ name: "TWO", method: "DELETE", url: "{{baseUrl}}/2" }), 1)!;
  const p = parseHttp(next);
  assert.deepEqual(p.reqs.map((x) => `${x.method} ${x.name}`), ["GET one", "DELETE TWO", "GET three"]);
  assert.equal(p.vars.baseUrl, "http://localhost:3000");
  assert.equal(withReq(file, req({ url: "http://h" }), 9), null);
  const added = parseHttp(withReq(file, req({ name: "four", url: "http://h/4" }))!);
  assert.deepEqual(added.reqs.map((x) => x.name), ["one", "two", "three", "four"]);
});

test("the editor's form: unknown methods and modes fall back, header lines are checked", () => {
  const r = reqOfForm({ method: "TRACE", mode: "evil", url: " http://h/\r\n ", headers: "Good: 1\nbad header: 2\nnocolon\nX-Y:  z ", query: "a=1\n\n b=2 ", name: "n\nm" });
  assert.equal(r.method, "GET");
  assert.equal(r.mode, "none");
  assert.equal(r.url, "http://h/");
  assert.deepEqual(r.headers, [["Good", "1"], ["X-Y", "z"]]);
  assert.deepEqual(r.query, ["a=1", "b=2"]);
  assert.equal(r.name, "n m");
  assert.equal(fullUrl({ url: "http://h/p?x=1#frag", query: ["a=1"] }), "http://h/p?x=1&a=1#frag");
});

test("environments: JetBrains shape, $shared, later sets win; junk dropped", () => {
  const theirs = parseEnvs(JSON.stringify({ $shared: { v: "1" }, dev: { baseUrl: "http://dev", n: 3, o: { no: 1 } }, "bad name!": {} }));
  const mine = parseEnvs('{"dev": {"baseUrl": "http://localhost:3000"}}');
  assert.deepEqual(varsOf("dev", theirs, mine), { v: "1", baseUrl: "http://localhost:3000", n: "3" });
  assert.deepEqual(parseEnvs("not json"), {});
  assert.deepEqual(parseEnvs("[1]"), {});
});

test("HTTP_SECRETS: NAME@host entries, junk skipped, values from this machine", () => {
  assert.deepEqual(secrets.map((s) => [s.name, s.hosts, !!s.value]), [
    ["API_TOKEN", ["api.example.com", "localhost:3000"], true],
    ["LOCAL", ["localhost"], true],
  ]);
});

test("prepare: variables, then the host, then only the secrets bound to it", () => {
  const vars = { baseUrl: "https://api.example.com", id: "7", nested: "{{id}}-x" };
  const ok = prepare(req({ method: "POST", url: "{{baseUrl}}/items/{{nested}}", query: ["t={{$timestamp}}"], headers: [["Authorization", "Bearer {{API_TOKEN}}"]], mode: "json", body: '{"id": "{{id}}"}' }), vars, secrets, 1_700_000_000_000);
  assert.ok(ok.ok);
  assert.equal(ok.url, "https://api.example.com/items/7-x?t=1700000000");
  assert.deepEqual(ok.headers, [["Authorization", "Bearer s3cr3t-token"], ["Content-Type", "application/json"]]);
  assert.equal(ok.body, '{"id": "7"}');
  assert.deepEqual(ok.secrets, ["API_TOKEN"]);
  // Port-bound and hostname-bound.
  assert.ok(prepare(req({ url: "http://localhost:3000/?k={{API_TOKEN}}" }), {}, secrets).ok);
  assert.ok(prepare(req({ url: "http://localhost:9999/", headers: [["X", "{{LOCAL}}"]] }), {}, secrets).ok);

  const no = (r: Req, v: Record<string, string> = {}) => {
    const p = prepare(r, v, secrets);
    assert.equal(p.ok, false, JSON.stringify(r));
    return p.ok ? "" : p.error;
  };
  // A secret to a host it isn't bound to (the env, a file's variable or the URL itself pointing elsewhere).
  assert.match(no(req({ url: "{{baseUrl}}/x", headers: [["Authorization", "Bearer {{API_TOKEN}}"]] }), { baseUrl: "https://evil.example" }), /only goes to api\.example\.com, localhost:3000, not evil\.example/);
  assert.match(no(req({ url: "https://evil.example/?t={{API_TOKEN}}" })), /only goes to/);
  assert.match(no(req({ url: "http://localhost:3001/", headers: [["X", "{{API_TOKEN}}"]] })), /only goes to/);
  // The host can't come from a secret, directly or through a variable.
  assert.match(no(req({ url: "https://{{API_TOKEN}}/x" })), /host can't come from a secret/);
  assert.match(no(req({ url: "{{u}}/x" }), { u: "https://{{LOCAL}}" }), /host can't come from a secret/);
  assert.match(no(req({ url: "https://user:{{API_TOKEN}}@api.example.com/" })), /host can't come from a secret/);
  // Unknown names, and REST Client's ways of reading this machine's environment, are refused.
  assert.match(no(req({ url: "https://h/{{nope}}" })), /No value for \{\{nope\}\}/);
  assert.match(no(req({ url: "https://h/{{$processEnv HOME}}" })), /\{\{\$processEnv\}\}/);
  assert.match(no(req({ url: "https://h/{{$dotenv X}}" })), /\$dotenv/);
  // Only http(s).
  assert.match(no(req({ url: "javascript:alert(1)" })), /http:\/\/ or https:\/\//);
  assert.match(no(req({ url: "file:///etc/passwd" })), /Only http/);
  assert.match(no(req({ url: "ftp://h/x" })), /Only http/);
  // A secret that isn't set.
  const unset = parseSecrets("GONE@h", {});
  const p = prepare(req({ url: "https://h/", headers: [["X", "{{GONE}}"]] }), {}, unset);
  assert.ok(!p.ok && /isn't set/.test(p.error));
  // Bad JSON (said without quoting it: it may hold a secret).
  assert.match(no(req({ method: "POST", url: "https://api.example.com/", mode: "json", body: '{"t": {{API_TOKEN}}}' })), /isn't valid JSON/);
  assert.ok(!no(req({ method: "POST", url: "https://api.example.com/", mode: "json", body: '{"t": {{API_TOKEN}}}' })).includes("s3cr3t"));
  // Header injection.
  assert.match(no(req({ url: "https://h/", headers: [["X", "{{v}}"]] }), { v: "a\r\nInjected: 1" }), /line break/);
});

test("masking: every set secret's value (and its URL-encoded form) becomes ••••", () => {
  const s = parseSecrets("A@h,B@h", { A: "abcd/ef", B: "zz" });
  const mask = masker(s);
  assert.equal(mask("x abcd/ef y abcd%2Fef zz"), "x •••• y •••• zz"); // shorter than 4: left (it would mask everything)
  assert.equal(secretIn("token abcd/ef", s)?.name, "A");
  assert.equal(secretIn("nothing", s), undefined);
});

test("shell words: quotes, escapes, continuations", () => {
  assert.deepEqual(shellWords(`curl -H 'A: b c' "x\\"y" $'l1\\nl2' a\\ b \\\n --x`), ["curl", "-H", "A: b c", 'x"y', "l1\nl2", "a b", "--x"]);
  assert.equal(shellWords("curl 'open"), null);
});

test("curl in: methods, headers, data, json, basic auth, -G; files left out", () => {
  const a = fromCurl(`curl -X PUT 'https://api.example.com/items/1?x=1' -H 'Content-Type: application/json' -H "Authorization: Bearer s3cr3t-token" --data-raw '{"a":1}' --compressed -sL`);
  assert.ok(a.ok);
  assert.equal(a.req.method, "PUT");
  assert.equal(a.req.url, "https://api.example.com/items/1");
  assert.deepEqual(a.req.query, ["x=1"]);
  assert.equal(a.req.mode, "json");
  assert.equal(a.req.body, '{\n  "a": 1\n}');
  // A secret's literal value becomes its placeholder.
  assert.deepEqual(placeholdSecrets(a.req, secrets).headers[1], ["Authorization", "Bearer {{API_TOKEN}}"]);

  const b = fromCurl(`curl https://h/login -d user=kari -d 'pass=x y' -u me:pw`);
  assert.ok(b.ok);
  assert.equal(b.req.method, "POST");
  assert.equal(b.req.mode, "form");
  assert.equal(b.req.body, "user=kari\npass=x y");
  assert.ok(b.req.headers.some(([k, v]) => k === "Authorization" && v === `Basic ${Buffer.from("me:pw").toString("base64")}`));

  const g = fromCurl(`curl -G https://h/s --data-urlencode 'q=a b'`);
  assert.ok(g.ok && g.req.method === "GET" && g.req.query[0] === "q=a%20b");
  const j = fromCurl(`curl --json '{"x":1}' https://h/j`);
  assert.ok(j.ok && j.req.method === "POST" && j.req.mode === "json");
  const f = fromCurl(`curl -F file=@/etc/passwd -d @/etc/passwd https://h/u`);
  assert.ok(f.ok && f.req.body === "" && f.notes.length === 2);
  assert.equal(fromCurl("wget https://h").ok, false);
  assert.equal(fromCurl("curl -s").ok, false);
  assert.equal(fromCurl("curl -X TRACE https://h").ok, false);
});

test("curl out: plain variables filled in, a secret stays a shell variable", () => {
  const r = req({ method: "POST", url: "{{baseUrl}}/x", headers: [["Authorization", "Bearer {{API_TOKEN}}"]], mode: "json", body: `{"it's": 1}` });
  const out = toCurl(r, { baseUrl: "https://api.example.com" }, secrets);
  assert.equal(out, `curl 'https://api.example.com/x' \\\n  -H 'Authorization: Bearer '"$API_TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"it'\\''s": 1}'`);
  assert.ok(!out.includes("s3cr3t"));
  // And it reads back as the same request.
  const back = fromCurl(out.replace('"$API_TOKEN"', "TOKEN"));
  assert.ok(back.ok && back.req.method === "POST" && back.req.body.includes(`"it's"`));
  assert.equal(toCurl(req({ method: "DELETE", url: "https://h/1" }), {}, []), "curl 'https://h/1' \\\n  -X DELETE");
  assert.equal(toCurl(req({ method: "HEAD", url: "https://h/1" }), {}, []), "curl 'https://h/1' \\\n  -I");
});
