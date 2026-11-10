import assert from "node:assert/strict";
import { test } from "node:test";
import { reqOfSpan, routeVars, type Span, spanActions } from "../trace.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const span = (o: Partial<Span>): Span => ({ service: "api", method: "GET", route: "", attrs: {}, ...o });

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

test("trace: what another pack hands over is checked, not trusted: a wrong shape is no button", () => {
  for (const a of [undefined, null, "GET /x", 7, [], {}, { service: "api", method: "GET" }, { service: "api", method: ["GET"], route: "/x" }, { service: { toString: () => "api" }, method: "GET", route: "/x" }, { service: "api", method: "GET", route: 5, attrs: {} }])
    assert.equal(spanActions(a), "", JSON.stringify(a));
  assert.equal(reqOfSpan({ service: "api", method: "GET", route: "/x", attrs: "url.full" })!.url, "{{baseUrl}}/x", "attrs that aren't an object: none");
  assert.equal(reqOfSpan({ service: "api", method: "GET", route: "/x", attrs: { "url.full": { href: "https://a.example" } } })!.url, "{{baseUrl}}/x", "an attribute that isn't text: skipped");
  const out = String(spanActions({ service: H, method: "GET", route: "", attrs: { "url.path": `/x/${H}`, "http.url": "javascript:alert(1)" }, extra: H }));
  assert.match(out, /Open in HTTP client/);
  assert.ok(!out.includes("<script>") && !out.includes("<img") && !out.includes("javascript:"), "escaped");
});
