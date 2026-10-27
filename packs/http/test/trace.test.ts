import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpanSlotArg } from "dovre/packs/types.ts";
import { reqOfSpan, routeVars, spanActions } from "../trace.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const span = (o: Partial<SpanSlotArg>): SpanSlotArg => ({ service: "api", kind: "server", method: "GET", route: "", attrs: {}, ...o });

test("trace: a route's parameters become variables, in each framework's spelling", () => {
  assert.equal(routeVars("/users/:id/posts/:postId?"), "/users/{{id}}/posts/{{postId}}");
  assert.equal(routeVars("/users/{id}/files/{name:.*}"), "/users/{{id}}/files/{{name}}");
  assert.equal(routeVars("/users/<int:id>"), "/users/{{id}}");
  assert.equal(routeVars("/static/*"), "/static/{{path}}");
  assert.equal(routeVars("/plain/path"), "/plain/path");
});

test("trace: a span becomes a request from what it kept, else nothing", () => {
  const r = reqOfSpan(span({ method: "post", route: "/orders/:id" }))!;
  assert.equal(r.method, "POST");
  assert.equal(r.url, "{{baseUrl}}/orders/{{id}}");
  assert.equal(r.name, "api POST /orders/:id");
  assert.deepEqual(r.headers, []);
  assert.equal(r.body, "");

  assert.equal(reqOfSpan(span({ route: "/orders/:id", attrs: { "url.full": "https://shop.example/orders/7" } }))!.url, "https://shop.example/orders/7", "a kept full URL wins");
  assert.equal(reqOfSpan(span({ route: "/x", attrs: { "url.full": "javascript:alert(1)" } }))!.url, "{{baseUrl}}/x", "only an http(s) URL is taken");
  assert.equal(reqOfSpan(span({ attrs: { "url.path": "/a b" } }))!.url, "{{baseUrl}}/a%20b", "the kept path, when there's no route");
  assert.equal(reqOfSpan(span({ method: "TRACE", route: "/x" })), undefined, "a method the editor doesn't send");
  assert.equal(reqOfSpan(span({ route: "" })), undefined, "no path at all");
  assert.equal(reqOfSpan(span({ route: "relative" })), undefined);
});

test("trace: the button posts to /http/open with the request, hostile text inert", () => {
  const out = String(spanActions(span({ service: H, route: `/x/${H}`, attrs: { "url.full": `https://a.example/"><script>alert(1)</script>` } })));
  assert.match(out, /<form method="post" action="\/http\/open"/);
  assert.match(out, /name="from" value="trace"/);
  assert.match(out, /Open in HTTP client/);
  assert.ok(!out.includes("<script>") && !out.includes("<img"), "escaped");
  assert.equal(spanActions(span({ method: "" })), "");
});
