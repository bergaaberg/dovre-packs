/**
 * OpenAPI import (`fromOpenApi`): a request per operation, placeholders for parameters and auth, a
 * body from the example or the schema; hostile names and paths can't add lines to a `.http` file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHttp, serializeReq } from "../model.ts";
import { fileNameOf, fromOpenApi, MAX_OPS, sample } from "../openapi.ts";

const OAS3 = `openapi: 3.0.3
info: { title: Pet Store }
servers: [{ url: "https://pets.example.com/v1" }]
security: [{ bearer: [] }]
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
    key: { type: apiKey, in: header, name: X-Api-Key }
  schemas:
    Pet:
      type: object
      properties:
        id: { type: integer }
        name: { type: string, example: Rex }
        born: { type: string, format: date }
        tags: { type: array, items: { type: string } }
        parent: { $ref: "#/components/schemas/Pet" }
paths:
  /pets:
    get:
      operationId: listPets
      parameters:
        - { name: limit, in: query, required: true, schema: { type: integer } }
        - { name: page, in: query, schema: { type: integer } }
        - { name: X-Trace, in: header, required: true, example: abc }
    post:
      summary: Add a pet
      security: [{ key: [] }]
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Pet" }
  /pets/{petId}:
    parameters: [{ name: petId, in: path, required: true, schema: { type: string } }]
    delete: {}
    patch:
      requestBody:
        content:
          application/x-www-form-urlencoded:
            schema: { type: object, properties: { name: { type: string } } }
    trace: {}
`;

test("OpenAPI 3 YAML: a request per operation, placeholders for parameters and auth, a body from the schema", () => {
  const got = fromOpenApi(OAS3);
  assert.ok(got.ok, got.ok ? "" : got.error);
  assert.equal(got.title, "Pet Store");
  assert.equal(got.server, "https://pets.example.com/v1");
  assert.deepEqual(got.reqs.map((r) => `${r.method} ${r.name} ${r.url}`), ["GET listPets {{baseUrl}}/pets", "POST Add a pet {{baseUrl}}/pets", "DELETE DELETE /pets/{petId} {{baseUrl}}/pets/{{petId}}", "PATCH PATCH /pets/{petId} {{baseUrl}}/pets/{{petId}}"]);
  const [list, add, , patch] = got.reqs;
  assert.deepEqual(list!.query, ["limit={{limit}}"]);
  assert.deepEqual(list!.headers, [["X-Trace", "abc"], ["Authorization", "Bearer {{BEARER}}"]]);
  assert.deepEqual(add!.headers, [["X-Api-Key", "{{KEY}}"]]);
  assert.equal(add!.mode, "json");
  const body = JSON.parse(add!.body);
  assert.equal(body.name, "Rex");
  assert.equal(body.born, "2026-01-01");
  assert.deepEqual(body.tags, ["string"]);
  assert.equal(body.parent, null, "a schema that refers to itself is cut off");
  assert.equal(patch!.mode, "form");
  assert.equal(patch!.body, "name={{name}}");
  assert.match(got.notes.join(" "), /1 operation left out/);
});

test("Swagger 2 JSON: host and basePath, a body parameter, an API key in the query", () => {
  const got = fromOpenApi(
    JSON.stringify({
      swagger: "2.0",
      info: { title: "Old" },
      host: "old.example.com",
      basePath: "/api/",
      schemes: ["http", "https"],
      securityDefinitions: { k: { type: "apiKey", in: "query", name: "api_key" } },
      security: [{ k: [] }],
      paths: { "/things": { put: { operationId: "put", parameters: [{ name: "b", in: "body", schema: { type: "object", properties: { n: { type: "number" } } } }] } } },
    }),
  );
  assert.ok(got.ok);
  assert.equal(got.server, "https://old.example.com/api");
  assert.deepEqual(got.reqs[0]!.query, ["api_key={{K}}"]);
  assert.deepEqual(JSON.parse(got.reqs[0]!.body), { n: 0 });
});

test("refused: not JSON or YAML, not a spec, no paths, no operations; remote refs are not followed", () => {
  for (const [text, re] of [
    ["{ nope", /Not JSON or YAML/],
    ['{"a": 1}', /isn't an OpenAPI spec/],
    ["openapi: 3.1.0\ninfo: {}", /no paths/],
    ["openapi: 3.1.0\npaths: { /x: { trace: {} } }", /no operations/],
    ["x".repeat(1_000_001), /Too long/],
  ] as const) {
    const got = fromOpenApi(text);
    assert.equal(got.ok, false, text.slice(0, 40));
    if (!got.ok) assert.match(got.error, re);
  }
  assert.equal(sample({}, { $ref: "https://evil.example/schema.json" }), null);
  assert.equal(sample({}, { $ref: "#/a" }), null);
});

test("hostile names and paths can't add lines or requests to a .http file", () => {
  const spec = {
    openapi: "3.0.0",
    info: { title: "x\n### injected" },
    paths: {
      "/a\nGET https://evil.example/": { get: { operationId: "one\nGET https://evil.example/\n###" } },
      "/b/{id\n}": { post: { summary: "two", parameters: [{ name: "X-H\nEvil: 1", in: "header", required: true }, { name: "q", in: "query", required: true, example: "1\n###" }], requestBody: { content: { "application/json": { example: { s: "\n### GET https://evil.example/" } } } } } },
    },
  };
  const got = fromOpenApi(JSON.stringify(spec));
  assert.ok(got.ok);
  const text = got.reqs.map(serializeReq).join("\n");
  const back = parseHttp(text).reqs;
  assert.equal(back.length, 2);
  assert.ok(back.every((r) => r.url.startsWith("{{baseUrl}}/")));
  assert.ok(!back.some((r) => r.headers.some(([k]) => k === "Evil")));
  assert.equal(fileNameOf(got.title), "x-injected.http");
});

test("operations are capped", () => {
  const paths = Object.fromEntries(Array.from({ length: MAX_OPS + 3 }, (_, i) => [`/p${i}`, { get: {} }]));
  const got = fromOpenApi(JSON.stringify({ openapi: "3.0.0", paths }));
  assert.ok(got.ok);
  assert.equal(got.reqs.length, MAX_OPS);
  assert.match(got.notes[0]!, /3 operations left out/);
});
