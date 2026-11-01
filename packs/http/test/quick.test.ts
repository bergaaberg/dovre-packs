/**
 * HTTP client (`http`): the Quick view's model (dovre-packs#65, H-02/H-03): blanks, the command
 * line, an operation's reference from the spec, finding a repo's spec, and which endpoint a request
 * belongs to. Hostile input for each.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { caseKey, createResults, expectsText } from "../cases.ts";
import { buildCatalog, endpointFor, endpointKey } from "../catalog.ts";
import { findSpec } from "../files.ts";
import { blankReq, parseHttp, type Req } from "../model.ts";
import { specDoc } from "../openapi.ts";
import { askPrompt, blanksOf, blanksOfForm, fillBlanks, MAX_BLANKS, parseLine } from "../quick.ts";

const req = (o: Partial<Req>): Req => ({ ...blankReq(), ...o });

test("blanks: the placeholders nothing fills, once each, with where they are", () => {
  const r = req({
    method: "POST",
    url: "{{baseUrl}}/orders/{{id}}/lines?x={{x}}",
    query: ["page={{page}}", "id={{id}}"],
    headers: [
      ["Authorization", "Bearer {{API_TOKEN}}"],
      ["X-Trace", "{{trace}}"],
    ],
    body: '{"customer": "{{customer}}", "at": "{{$isoTimestamp}}", "t": "{{login.response.body.token}}", "bad": "{{a b}}"}',
  });
  const defined = new Set(["baseUrl", "API_TOKEN"]);
  assert.deepEqual(
    blanksOf(r, (n) => defined.has(n)),
    [
      { name: "id", where: "path" },
      { name: "x", where: "query" },
      { name: "page", where: "query" },
      { name: "trace", where: "header" },
      { name: "customer", where: "body" },
    ],
  );
  const many = req({ url: `{{baseUrl}}/${Array.from({ length: 50 }, (_, i) => `{{v${i}}}`).join("/")}` });
  assert.equal(blanksOf(many, () => false).length, MAX_BLANKS);
});

test("blanks in: as typed, empty ones left for prepare() to name; values that would be read again are refused", () => {
  const r = req({ method: "POST", url: "{{baseUrl}}/orders/{{id}}", headers: [["X-Trace", "{{trace}}"]], mode: "json", body: '{"note": "{{note}}"}' });
  const ok = fillBlanks(r, new Map([["id", "ord_1"], ["trace", ""], ["note", "two\nlines"]]));
  assert.ok(ok.ok);
  assert.equal(ok.req.url, "{{baseUrl}}/orders/ord_1");
  assert.deepEqual(ok.req.headers, [["X-Trace", "{{trace}}"]]);
  assert.equal(ok.req.body, '{"note": "two\nlines"}', "a line break is fine in a body");
  for (const [v, why] of [
    ["{{API_TOKEN}}", /holds \{\{ or \$\{/],
    ["${order.id}", /holds \{\{ or \$\{/],
    ["••••", /masked secret/],
    ["a\r\nX-Evil: 1", /line break/],
    ["a\0b", /line break/],
  ] as const) {
    const bad = fillBlanks(r, new Map([["id", v]]));
    assert.ok(!bad.ok, v);
    assert.match(bad.error, why);
    assert.match(bad.error, /nothing was sent/);
  }
  // Only blank.<plain name> fields are read.
  assert.deepEqual([...blanksOfForm({ "blank.id": "1", "blank.a b": "x", "blank.": "y", url: "z", "blank.n": 5 })], [["id", "1"]]);
});

test("the command line: httpie's shorthand, a pasted curl, else a sentence for an agent", () => {
  const a = parseLine("POST :3000/api/orders customer=cus_19 qty:=2 lines:='[1,2]' limit==20 X-Trace:abc");
  assert.equal(a.t, "req");
  if (a.t !== "req") return;
  assert.equal(a.req.method, "POST");
  assert.equal(a.req.url, "http://localhost:3000/api/orders");
  assert.deepEqual(a.req.query, ["limit=20"]);
  assert.deepEqual(a.req.headers, [["X-Trace", "abc"]]);
  assert.equal(a.req.mode, "json");
  assert.deepEqual(JSON.parse(a.req.body), { customer: "cus_19", qty: 2, lines: [1, 2] });

  const b = parseLine("/api/orders");
  assert.ok(b.t === "req" && b.req.method === "GET" && b.req.url === "{{baseUrl}}/api/orders" && b.req.mode === "none");
  const c = parseLine("api.example.com/x name=a");
  assert.ok(c.t === "req" && c.req.method === "POST" && c.req.url === "https://api.example.com/x");
  const d = parseLine("delete localhost:8080/items/3");
  assert.ok(d.t === "req" && d.req.method === "DELETE" && d.req.url === "http://localhost:8080/items/3");
  const e = parseLine("curl -X PUT https://api.example.com/a -d '{\"x\":1}' -H 'Content-Type: application/json'");
  assert.ok(e.t === "req" && e.req.method === "PUT" && e.req.url === "https://api.example.com/a");

  assert.deepEqual(parseLine("create an order for cus_19 and then cancel it"), { t: "ask", text: "create an order for cus_19 and then cancel it" });
  assert.deepEqual(parseLine("GET me the orders"), { t: "ask", text: "GET me the orders" });
  assert.equal(parseLine("  ").t, "error");
  const bad = parseLine("POST /x a:={nope");
  assert.ok(bad.t === "error" && /takes JSON/.test(bad.error));
  // A header name that isn't one, and a word that's neither, are left out and said.
  const f = parseLine('GET /x "Bad Name:1" loose');
  assert.ok(f.t === "req" && f.req.headers.length === 0 && f.notes.length === 2);
  // A line break can't be smuggled into a header through quotes.
  const g = parseLine("GET /x $'X-A:1\\r\\nX-B: 2'");
  assert.ok(g.t === "req" && g.req.headers.length === 0);
});

test("the ask prompt says draft, don't send", () => {
  const p = askPrompt("cancel order 7", { repo: "shop", env: "local", endpoint: "POST /orders/{id}/cancel" });
  assert.match(p, /the shop repo's `.http\/` folder: cancel order 7/);
  assert.match(p, /POST \/orders\/\{id\}\/cancel/);
  assert.match(p, /Don't send anything that changes data/);
});

const SPEC = `openapi: 3.0.3
info: { title: Shop }
components:
  securitySchemes: { bearer: { type: http, scheme: bearer } }
  schemas:
    Line:
      type: object
      required: [sku, qty]
      properties:
        sku: { type: string, description: from the catalogue }
        qty: { type: integer }
security: [{ bearer: [] }]
paths:
  /orders:
    post:
      tags: [orders]
      summary: Create an order
      description: Prices come from the catalogue.
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [customer]
              properties:
                customer: { type: string, example: cus_19 }
                lines: { type: array, items: { $ref: "#/components/schemas/Line" } }
                state: { type: string, enum: [open, paid] }
      responses:
        "201": { description: The order }
        "422": { description: Which line and why }
  /orders/{id}:
    parameters: [{ name: id, in: path, description: the order's id, schema: { type: string } }]
    get:
      summary: One order
      parameters: [{ name: expand, in: query, schema: { type: boolean } }]
      responses: { "200": { description: ok } }
`;

test("specDoc: an operation's parameters, body fields (nested one level) and responses, and the request to start from", () => {
  const d = specDoc(SPEC, "POST", "/orders")!;
  assert.equal(d.summary, "Create an order");
  assert.equal(d.about, "Prices come from the catalogue.");
  assert.deepEqual(
    d.fields.map((f) => [f.name, f.type, f.required]),
    [
      ["customer", "string", true],
      ["lines", "array", false],
      ["lines[].sku", "string", true],
      ["lines[].qty", "integer", true],
      ["state", "one of open, paid", false],
    ],
  );
  assert.equal(d.fields[2]!.about, "from the catalogue");
  assert.deepEqual(d.responses, [
    { code: "201", about: "The order" },
    { code: "422", about: "Which line and why" },
  ]);
  assert.equal(d.req.url, "{{baseUrl}}/orders");
  assert.deepEqual(d.req.headers, [["Authorization", "Bearer {{BEARER}}"]]);
  assert.equal(JSON.parse(d.req.body).customer, "cus_19");

  const g = specDoc(SPEC, "GET", "/orders/{id}")!;
  assert.deepEqual(
    g.params.map((p) => [p.name, p.in, p.required, p.about]),
    [
      ["id", "path", true, "the order's id"],
      ["expand", "query", false, ""],
    ],
  );
  assert.equal(g.req.url, "{{baseUrl}}/orders/{{id}}");
  assert.equal(specDoc(SPEC, "DELETE", "/orders"), undefined);
  assert.equal(specDoc(SPEC, "GET", "/nope"), undefined);
  assert.equal(specDoc("not: [a spec", "GET", "/"), undefined);
  // __proto__ and friends are only ever read as own keys.
  assert.equal(specDoc(SPEC, "GET", "__proto__"), undefined);
  assert.equal(specDoc(SPEC, "GET", "constructor"), undefined);
});

test("specDoc: hostile names come out as plain text, cut to size, on one line", () => {
  const H = "<script>alert(1)</script>";
  const spec = JSON.stringify({
    openapi: "3.0.0",
    paths: { "/x": { get: { summary: `${H}\n### injected`, description: "x".repeat(5000), parameters: [{ name: `${H}\r\nX: y`, in: "query", schema: { type: "string" } }], responses: { [`200${H}`]: { description: H } } } } },
  });
  const d = specDoc(spec, "GET", "/x")!;
  assert.ok(!d.summary.includes("\n"));
  assert.equal(d.about.length, 1000);
  assert.ok(!d.params[0]!.name.includes("\n"));
  assert.ok(d.responses[0]!.code.length <= 10);
});

test("findSpec: the first usual place, a plain file only (no symlinked file or folder)", () => {
  const root = mkdtempSync(join(tmpdir(), "dovre-spec-"));
  assert.equal(findSpec(root), undefined);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "openapi.yaml"), "openapi: 3.0.0\n");
  assert.deepEqual(findSpec(root), { name: "docs/openapi.yaml", text: "openapi: 3.0.0\n" });
  writeFileSync(join(root, "openapi.json"), "{}");
  assert.equal(findSpec(root)!.name, "openapi.json");

  const outside = mkdtempSync(join(tmpdir(), "dovre-spec-out-"));
  writeFileSync(join(outside, "secret.yaml"), "secret");
  const r2 = mkdtempSync(join(tmpdir(), "dovre-spec-"));
  symlinkSync(join(outside, "secret.yaml"), join(r2, "openapi.yaml"));
  symlinkSync(outside, join(r2, "api"));
  writeFileSync(join(outside, "openapi.yaml"), "secret too");
  assert.equal(findSpec(r2), undefined);
});

test("endpointFor: a saved request finds its spec endpoint by method and path, placeholders fitting params", () => {
  const files = [{ name: "orders.http", reqs: parseHttp("### Happy\nPOST {{baseUrl}}/orders\n\n### one\nGET {{baseUrl}}/orders/ord_1?expand=true\n\n### own\nGET https://h.example/health\n").reqs }];
  const c = buildCatalog(SPEC, files);
  assert.equal(endpointKey(endpointFor(c.endpoints, "GET", "{{baseUrl}}/orders/{{id}}")!), "GET /orders/{id}");
  assert.equal(endpointKey(endpointFor(c.endpoints, "GET", "http://localhost:3000/orders/ord_2")!), "GET /orders/{id}");
  assert.equal(endpointKey(endpointFor(c.endpoints, "GET", "{{baseUrl}}/health")!), "GET /health");
  assert.equal(endpointFor(c.endpoints, "DELETE", "{{baseUrl}}/orders/1"), undefined);
  assert.equal(endpointFor(c.endpoints, "GET", "not a url"), undefined);
});

test("case results: keyed by repo, file and name (index when unnamed), the newest kept, bounded", () => {
  const r = createResults(2);
  const a = { file: "a.http", n: 0, req: req({ name: "Happy" }) };
  const b = { file: "a.http", n: 3, req: req({ name: "" }) };
  assert.notEqual(caseKey("shop", a), caseKey("other", a));
  assert.match(caseKey("shop", b), /#3$/);
  r.set("1", { at: 1, env: "", state: "passed", checks: [] });
  r.set("2", { at: 2, env: "", state: "passed", checks: [] });
  r.set("3", { at: 3, env: "", state: "failed", checks: [] });
  assert.equal(r.get("1"), undefined);
  assert.equal(r.get("3")!.state, "failed");
  assert.equal(expectsText(req({})), "< 400");
  assert.equal(expectsText(req({ expect: ["json $.id exists", "status 201"] })), "201 · 1 more");
});
