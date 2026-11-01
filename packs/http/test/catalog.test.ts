import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, groupOf, pathOf } from "../catalog.ts";
import { parseHttp } from "../model.ts";

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Bakery" },
  paths: {
    "/api/orders": { get: { summary: "List orders", tags: ["orders"] }, post: { operationId: "createOrder", tags: ["orders"] } },
    "/api/orders/{id}": { get: { summary: "One order" }, parameters: [] },
    "/api/orders/{id}/cancel": { post: {} },
    "bad path": { get: {} },
    "/x\ny": { get: {} },
  },
});

const files = [
  { name: "orders.http", reqs: parseHttp("### Happy path\nPOST {{baseUrl}}/api/orders\n\n### By id\nGET {{baseUrl}}/api/orders/{{orderId}}?full=1\n\n### Cancel\nPOST http://localhost:3000/api/orders/7/cancel\n").reqs },
  { name: "misc.http", reqs: parseHttp("### Health\nGET {{baseUrl}}/health\n\n### Health again\nGET {{baseUrl}}/health/\n\n### Item\nGET {{baseUrl}}/v1/items/{{a}}\n\n### Item b\nGET {{baseUrl}}/v1/items/{{b}}\n\n### Relative\nGET example.test/x\n").reqs },
];

test("catalog: spec endpoints with the saved requests as their cases; the rest stand alone", () => {
  const c = buildCatalog(SPEC, files);
  assert.equal(c.title, "Bakery");
  const key = (m: string, p: string) => c.endpoints.find((e) => e.method === m && e.path === p);
  assert.deepEqual(key("POST", "/api/orders")?.cases, [{ file: "orders.http", name: "Happy path" }]);
  assert.equal(key("POST", "/api/orders")?.summary, "createOrder");
  assert.deepEqual(key("GET", "/api/orders/{id}")?.cases, [{ file: "orders.http", name: "By id" }]);
  // A literal 7 fits the spec's {id}: a saved example of that endpoint.
  assert.deepEqual(key("POST", "/api/orders/{id}/cancel")?.cases, [{ file: "orders.http", name: "Cancel" }]);
  assert.deepEqual(key("GET", "/api/orders")?.cases, []);
  assert.equal(key("GET", "/api/orders")?.group, "orders");
  // Not in the spec: one endpoint per method and path, placeholders read alike.
  assert.deepEqual(key("GET", "/health")?.cases.map((x) => x.name), ["Health", "Health again"]);
  assert.equal(key("GET", "/health")?.fromSpec, false);
  assert.deepEqual(key("GET", "/v1/items/{a}")?.cases.map((x) => x.name), ["Item", "Item b"]);
  assert.equal(key("GET", "/v1/items/{a}")?.group, "items");
  assert.ok(!c.endpoints.some((e) => e.path.includes("bad") || e.path.includes("\n")));
  assert.match(c.notes[0]!, /1 saved request with a URL/);
});

test("catalog: no spec, or one that can't be read, still lists the saved requests", () => {
  assert.equal(buildCatalog(undefined, files).endpoints.filter((e) => e.fromSpec).length, 0);
  const bad = buildCatalog("openapi: [", files);
  assert.match(bad.notes[0]!, /can't be read/);
  assert.ok(bad.endpoints.length > 0);
});

test("catalog: paths and groups", () => {
  assert.equal(pathOf("{{baseUrl}}/a/b?x=1#h"), "/a/b");
  assert.equal(pathOf("https://u:p@host:8080/a/"), "/a");
  assert.equal(pathOf("https://host"), "/");
  assert.equal(pathOf("{{baseUrl}}"), "/");
  assert.equal(pathOf("host/x"), undefined);
  assert.equal(groupOf("/api/v2/{id}/things"), "things");
  assert.equal(groupOf("/"), "other");
  assert.equal(groupOf("/x", "Tagged"), "Tagged");
});
