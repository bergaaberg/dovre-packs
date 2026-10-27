/**
 * Postman / Bruno import (`fromCollection`): folders as name prefixes, `:id` as `{{id}}`, auth as a
 * header with real credentials swapped for placeholders, simple checks kept, scripts left out; hostile
 * names and values can't add lines to a `.http` file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromCollection, varLines } from "../collections.ts";
import { parseHttp, serializeReq } from "../model.ts";

const ok = (text: string) => {
  const got = fromCollection(text);
  assert.ok(got?.ok, got && !got.ok ? got.error : "not read as a collection");
  return got;
};

const POSTMAN = {
  info: { _postman_id: "x", name: "Shop", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: "sk_live_abcdef123456", type: "string" }] },
  variable: [
    { key: "baseUrl", value: "https://api.shop.example" },
    { key: "apiToken", value: "real-secret-value" },
    { key: "userToken", value: "{{fromEnv}}" },
  ],
  item: [
    {
      name: "Items",
      item: [
        {
          name: "Get one",
          event: [{ listen: "test", script: { exec: ['pm.test("ok", function () {', "  pm.response.to.have.status(200);", "});"] } }],
          request: {
            method: "GET",
            header: [
              { key: "Accept", value: "application/json" },
              { key: "X-Off", value: "1", disabled: true },
            ],
            url: { raw: "{{baseUrl}}/items/:id?expand=tags&q=a%20b", host: ["{{baseUrl}}"], path: ["items", ":id"], query: [{ key: "expand", value: "tags" }, { key: "q", value: "a%20b" }, { key: "off", value: "1", disabled: true }], variable: [{ key: "id", value: "42" }] },
          },
        },
        {
          name: "Add",
          event: [{ listen: "prerequest", script: { exec: ["pm.environment.set('t', Date.now())"] } }],
          request: { method: "POST", auth: { type: "noauth" }, header: [{ key: "Cookie", value: "sid=abc123" }], url: "{{baseUrl}}/items", body: { mode: "raw", raw: '{"name":"{{name}}"}', options: { raw: { language: "json" } } } },
        },
      ],
    },
    { name: "Login", request: { method: "POST", auth: { type: "apikey", apikey: [{ key: "key", value: "X-Api-Key" }, { key: "value", value: "{{API_KEY}}" }] }, url: "{{baseUrl}}/login", body: { mode: "urlencoded", urlencoded: [{ key: "user", value: "me@x.io" }, { key: "pw", value: "{{pw}}" }] } } },
    { name: "Upload", request: { method: "POST", url: "{{baseUrl}}/up", body: { mode: "formdata", formdata: [{ key: "f", type: "file", src: "/a" }] } } },
    { name: "Graph", request: { method: "POST", url: "{{baseUrl}}/gql", body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: '{"a":1}' } } } },
    { name: "Odd", request: { method: "COPY", url: "{{baseUrl}}/x" } },
  ],
};

test("Postman: folders, path variables, query as written, auth as headers with secrets swapped, checks and notes", () => {
  const got = ok(JSON.stringify(POSTMAN));
  assert.equal(got.title, "Shop");
  assert.equal(got.from, "a Postman collection");
  assert.deepEqual(got.reqs.map((r) => `${r.method} ${r.name}`), ["GET Items / Get one", "POST Items / Add", "POST Login", "POST Upload", "POST Graph"]);
  const [get, add, login, up, gql] = got.reqs as [any, any, any, any, any];
  assert.equal(get.url, "{{baseUrl}}/items/42");
  assert.deepEqual(get.query, ["expand=tags", "q=a%20b"], "the raw URL's query, not encoded again; switched-off ones out");
  assert.deepEqual(get.headers, [["Accept", "application/json"], ["Authorization", "Bearer {{TOKEN}}"]], "collection auth inherited, real token swapped");
  assert.deepEqual(get.expect, ["status 200"]);
  assert.equal(add.mode, "json");
  assert.equal(add.body, '{"name":"{{name}}"}');
  assert.deepEqual(add.headers, [["Cookie", "{{COOKIE}}"]], "noauth: no Authorization; a cookie's value swapped");
  assert.equal(login.mode, "form");
  assert.equal(login.body, "user=me%40x.io\npw={{pw}}");
  assert.deepEqual(login.headers, [["X-Api-Key", "{{API_KEY}}"]]);
  assert.equal(up.mode, "none");
  assert.deepEqual(JSON.parse(gql.body), { query: "{ me { id } }", variables: { a: 1 } });
  const notes = got.notes.join(" ");
  assert.match(notes, /2 credential values replaced/);
  assert.match(notes, /look secret\): apiToken\./);
  assert.match(notes, /1 script left out/);
  assert.match(notes, /multipart body on Upload/);
  assert.match(notes, /COPY Odd/);
  assert.deepEqual(got.vars, [["baseUrl", "https://api.shop.example"], ["userToken", "{{fromEnv}}"]]);
  assert.ok(!JSON.stringify(got).includes("sk_live_abcdef123456") && !JSON.stringify(got).includes("abc123") && !JSON.stringify(got).includes("real-secret-value"), "no secret value anywhere in the result");
  assert.equal(varLines(got.vars!), "@baseUrl = https://api.shop.example\n@userToken = {{fromEnv}}");
});

test("Postman v2.0: string request, string headers, auth as an object, URL without raw", () => {
  const got = ok(JSON.stringify({ info: { name: "Old", schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json" }, item: [{ name: "a", request: "https://x.example/a" }, { name: "b", request: { method: "PUT", header: "X-A: 1\nAuthorization: Bearer {{t}}", auth: { type: "bearer", bearer: { token: "abc" } }, url: { protocol: "https", host: ["x", "example"], path: ["b", ":id"], query: [{ key: "q", value: "a b" }] } } }] }));
  assert.equal(got.reqs[0]!.url, "https://x.example/a");
  const b = got.reqs[1]!;
  assert.equal(b.url, "https://x.example/b/{{id}}");
  assert.deepEqual(b.query, ["q=a%20b"]);
  assert.deepEqual(b.headers, [["X-A", "1"], ["Authorization", "Bearer {{t}}"]], "the header's own placeholder kept; auth doesn't add a second one");
});

const BRU = `meta {
  name: Get user
  type: http
  seq: 1
}

get {
  url: {{baseUrl}}/users/:id?page=2
  body: none
  auth: bearer
}

params:query {
  page: 2
  ~off: 1
}

params:path {
  id: 7
}

headers {
  Accept: application/json
  ~X-Off: 1
}

auth:bearer {
  token: eyJhbGciOiJIUzI1NiJ9.real
}

assert {
  res.status: eq 200
  res.responseTime: lt 500
  res.body.items[0].id: eq 3
  res.body.name: isDefined
  res.headers.etag: matches x
}

tests {
  test("x", () => {});
}
meta {
  name: Create
  type: http
  seq: 2
}

post {
  url: {{baseUrl}}/users
  body: json
  auth: none
}

body:json {
  {
    "name": "{{name}}"
  }
}
meta {
  name: Socket
  type: grpc
}
`;

test("Bruno .bru files: blocks, switched-off entries out, asserts as checks, token swapped, several files", () => {
  const got = ok(BRU);
  assert.equal(got.from, "a Bruno collection");
  assert.equal(got.reqs.length, 2);
  const [a, b] = got.reqs as [any, any];
  assert.equal(a.name, "Get user");
  assert.equal(a.url, "{{baseUrl}}/users/7");
  assert.deepEqual(a.query, ["page=2"]);
  assert.deepEqual(a.headers, [["Accept", "application/json"], ["Authorization", "Bearer {{TOKEN}}"]]);
  assert.deepEqual(a.expect, ["status 200", "time < 500", "json $.items[0].id == 3", "json $.name exists"]);
  assert.equal(b.method, "POST");
  assert.deepEqual(JSON.parse(b.body), { name: "{{name}}" });
  const notes = got.notes.join(" ");
  assert.match(notes, /1 credential value replaced/);
  assert.match(notes, /1 script left out/);
  assert.match(notes, /the assert res\.headers\.etag: matches x/);
  assert.match(notes, /grpc request Socket/);
});

test("Bruno JSON export: folders, params, form body, folder auth inherited", () => {
  const got = ok(JSON.stringify({ name: "Bru", version: "1", items: [{ type: "folder", name: "F", root: { request: { auth: { mode: "apikey", apikey: { key: "k", value: "live-key-123", placement: "queryparams" } } } }, items: [{ type: "http-request", name: "x", request: { method: "POST", url: "{{h}}/x/:id", params: [{ name: "id", value: "", type: "path", enabled: true }, { name: "q", value: "1", type: "query", enabled: true }, { name: "z", value: "1", type: "query", enabled: false }], headers: [], auth: { mode: "inherit" }, body: { mode: "formUrlEncoded", formUrlEncoded: [{ name: "a", value: "b c", enabled: true }] }, assertions: [{ name: "res.status", value: "eq 201", enabled: true }] } }] }] }));
  const r = got.reqs[0]!;
  assert.equal(r.name, "F / x");
  assert.equal(r.url, "{{h}}/x/{{id}}");
  assert.deepEqual(r.query, ["q=1", "k={{API_KEY}}"]);
  assert.equal(r.body, "a=b%20c");
  assert.deepEqual(r.expect, ["status 201"]);
});

test("not a collection: OpenAPI, YAML, plain JSON, and empty collections", () => {
  assert.equal(fromCollection('{"openapi":"3.0.0","paths":{}}'), undefined);
  assert.equal(fromCollection("openapi: 3.0.0\npaths: {}"), undefined);
  assert.equal(fromCollection('{"a":1}'), undefined);
  assert.equal(fromCollection("{ nope"), undefined);
  const empty = fromCollection(JSON.stringify({ info: { _postman_id: "x", name: "E" }, item: [] }));
  assert.ok(empty && !empty.ok && /no requests/.test(empty.error));
});

test("hostile names, headers and URLs can't add lines or requests to a .http file", () => {
  const evil = "a\n### b\nGET https://evil.example\n";
  const got = ok(JSON.stringify({ info: { _postman_id: "x", name: evil }, variable: [{ key: "x", value: evil }, { key: "bad name\n", value: "1" }], item: [{ name: evil, request: { method: "GET", header: [{ key: "X-A\nX-B", value: "1" }, { key: "X-C", value: evil }], url: `https://ok.example/${evil}` } }] }));
  const r = got.reqs[0]!;
  const text = `${varLines(got.vars!)}\n${serializeReq(r)}`;
  const back = parseHttp(text);
  assert.equal(back.reqs.length, 1, "one request, as imported");
  assert.equal(back.reqs[0]!.headers.length, 1, "the header with a bad name is left out");
  assert.deepEqual(Object.keys(back.vars), ["x"]);
  assert.ok(!/^GET https:\/\/evil/m.test(text));
});
