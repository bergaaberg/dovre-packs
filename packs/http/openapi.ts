/**
 * HTTP client (`http`): an OpenAPI 3 or Swagger 2 spec (JSON or YAML) as one request per operation.
 * Read only: nothing is fetched (only `#/…` refs are followed), and the spec is hostile text like
 * anything pasted in, so every name and value that lands in a request is cut to size and stripped
 * of line breaks (a line break in a `.http` file would start another line of the request).
 *
 *  - URL: `{{baseUrl}}` + the path, `{id}` → `{{id}}`. The spec's own server is reported, not put in
 *    the file, so an environment's `baseUrl` decides where it goes.
 *  - Required query and header parameters as `{{name}}` (or the parameter's example).
 *  - Auth from the security schemes as placeholders: `Authorization: Bearer {{token}}`, an API-key
 *    header `{{API_KEY}}`-style. A secret's value is never in a spec, so none is in the result.
 *  - A JSON body from the example, or a sample built from the schema (refs followed, cycles cut).
 */
import { fromYaml } from "../json/convert.ts";
import type { Json } from "../json/tools.ts";
import { MAX_BODY_IN, MAX_NAME, MAX_URL, METHODS, type Method, type Req } from "./model.ts";

export const MAX_SPEC = 1_000_000;
export const MAX_OPS = 500;

export type Imported = { ok: true; title: string; /** "an OpenAPI spec", "a Postman collection"… */ from: string; server: string; reqs: Req[]; notes: string[]; /** `@name = value` lines for a new file. */ vars?: [string, string][] } | { ok: false; error: string };

type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const one = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "");
/** A placeholder name the `.http` variables accept. */
export const varName = (s: string) => (s.replace(/[^\w.-]/g, "_").replace(/^[^A-Za-z_]/, "_$&").slice(0, 64) || "value");
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

/** `#/a/b` in the spec, or undefined. */
function pointer(root: Json, ref: string): Json | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let at: Json | undefined = root;
  for (const raw of ref.slice(2).split("/")) {
    const k = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(at) || !Object.hasOwn(at, k)) return undefined;
    at = at[k];
  }
  return at;
}

/** Follows refs (a few hops, local only). */
function deref(root: Json, v: Json | undefined): Json | undefined {
  for (let i = 0; i < 20 && isObj(v) && typeof v.$ref === "string"; i++) v = pointer(root, v.$ref);
  return isObj(v) && typeof v.$ref === "string" ? undefined : v;
}

/** A value shaped like the schema: its example or default if it has one, else a stand-in. */
export function sample(root: Json, schema: Json | undefined, depth = 0, seen = new Set<Json>()): Json {
  const s = deref(root, schema);
  if (!isObj(s) || depth > 8 || seen.has(s)) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0]!;
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]!;
  const inner = new Set(seen).add(s);
  for (const k of ["allOf", "oneOf", "anyOf"] as const) {
    const list = s[k];
    if (!Array.isArray(list) || !list.length) continue;
    if (k !== "allOf") return sample(root, list[0], depth + 1, inner);
    const parts = list.map((x) => sample(root, x, depth + 1, inner));
    return parts.every(isObj) ? Object.assign({}, ...parts) : (parts[0] ?? null);
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "object" || (!type && isObj(s.properties))) {
    const out: Obj = {};
    if (isObj(s.properties)) for (const [k, p] of Object.entries(s.properties).slice(0, 50)) out[k] = sample(root, p, depth + 1, inner);
    return out;
  }
  if (type === "array") return [sample(root, s.items, depth + 1, inner)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "string") {
    const f = typeof s.format === "string" ? s.format : "";
    return f === "date-time" ? "2026-01-01T00:00:00Z" : f === "date" ? "2026-01-01" : f === "uuid" ? "00000000-0000-0000-0000-000000000000" : f === "email" ? "someone@example.com" : "string";
  }
  return null;
}

/** The spec's text as a value: JSON when it looks like JSON, else YAML. */
function read(text: string): { ok: true; v: Json } | { ok: false; error: string } {
  if (text.length > MAX_SPEC) return { ok: false, error: `Too long: ${text.length} characters (${MAX_SPEC} at most).` };
  if (/^\s*[{[]/.test(text)) {
    try {
      return { ok: true, v: JSON.parse(text) as Json };
    } catch {
      // Could still be YAML's flow style: tried below.
    }
  }
  const y = fromYaml(text);
  return y.ok ? { ok: true, v: y.value } : { ok: false, error: `Not JSON or YAML: ${y.error} (line ${y.line}).` };
}

/** The spec's first server, as written (for the note; it's not put in the requests). */
function serverOf(spec: Obj, v2: boolean): string {
  if (v2) {
    const host = one(spec.host);
    if (!host) return "";
    const scheme = Array.isArray(spec.schemes) && spec.schemes.includes("https") ? "https" : one(Array.isArray(spec.schemes) ? spec.schemes[0] : "") || "https";
    return `${scheme}://${host}${one(spec.basePath, 500).replace(/\/$/, "")}`.slice(0, 500);
  }
  const s = Array.isArray(spec.servers) ? spec.servers[0] : undefined;
  return isObj(s) ? one(s.url, 500) : "";
}

type Param = { name: string; in: string; required: boolean; example: Json | undefined; schema: Json | undefined; about: string };

function paramsOf(root: Json, list: Json | undefined): Param[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) => {
    const p = deref(root, x);
    if (!isObj(p) || typeof p.name !== "string" || typeof p.in !== "string") return [];
    const ex = p.example !== undefined ? p.example : isObj(p.examples) ? (Object.values(p.examples).map((e) => deref(root, e)).find(isObj)?.value as Json | undefined) : undefined;
    return [{ name: p.name.slice(0, 100), in: p.in, required: p.required === true || p.in === "path", example: ex, schema: p.schema ?? (p.type !== undefined ? p : undefined), about: one(p.description, 300) }];
  });
}

/** A parameter's value: its example if it's a plain one (encoded for a URL or form), else `{{name}}`. */
function valueOf(p: Param, encode = true): string {
  const ex = p.example;
  if (typeof ex === "string" || typeof ex === "number" || typeof ex === "boolean") return encode ? encodeURIComponent(String(ex).slice(0, 500)) : one(String(ex), 500);
  return `{{${varName(p.name)}}}`;
}

/** Headers for the operation's security (its own, else the spec's): placeholders only. */
function authHeaders(root: Json, spec: Obj, op: Obj, v2: boolean): { headers: [string, string][]; query: string[] } {
  const reqs = Array.isArray(op.security) ? op.security : Array.isArray(spec.security) ? spec.security : [];
  const first = reqs.find(isObj);
  const schemes = v2 ? spec.securityDefinitions : isObj(spec.components) ? spec.components.securitySchemes : undefined;
  const headers: [string, string][] = [];
  const query: string[] = [];
  if (!first || !isObj(schemes)) return { headers, query };
  for (const name of Object.keys(first).slice(0, 4)) {
    const s = deref(root, schemes[name]);
    if (!isObj(s)) continue;
    const ph = `{{${varName(name).toUpperCase()}}}`;
    if ((s.type === "http" && one(s.scheme).toLowerCase() === "bearer") || s.type === "oauth2" || s.type === "openIdConnect") headers.push(["Authorization", `Bearer ${ph}`]);
    else if ((s.type === "http" && one(s.scheme).toLowerCase() === "basic") || s.type === "basic") headers.push(["Authorization", `Basic ${ph}`]);
    else if (s.type === "apiKey" && typeof s.name === "string") {
      if (s.in === "header" && HEADER_NAME.test(s.name)) headers.push([s.name, ph]);
      else if (s.in === "query") query.push(`${encodeURIComponent(s.name.slice(0, 100))}=${ph}`);
    }
  }
  return { headers, query };
}

/** The body: JSON (example, else a sample), a form's fields as placeholders, or just its type. */
function bodyOf(root: Json, op: Obj, params: Param[], v2: boolean): Pick<Req, "mode" | "body"> & { type?: string } {
  if (v2) {
    const b = params.find((p) => p.in === "body");
    const consumes = Array.isArray(op.consumes) ? op.consumes.map((c) => one(c)) : [];
    if (b) return { mode: "json", body: JSON.stringify(b.example ?? sample(root, b.schema), null, 2) };
    const form = params.filter((p) => p.in === "formData");
    if (form.length) return consumes.some((c) => c.includes("multipart")) ? { mode: "raw", body: "", type: "multipart/form-data" } : { mode: "form", body: form.map((p) => `${encodeURIComponent(p.name)}=${valueOf(p)}`).join("\n") };
    return { mode: "none", body: "" };
  }
  const rb = deref(root, op.requestBody);
  const content = isObj(rb) && isObj(rb.content) ? rb.content : undefined;
  if (!content) return { mode: "none", body: "" };
  const types = Object.keys(content);
  const json = types.find((t) => /^application\/(.+\+)?json\b/i.test(t));
  if (json) {
    const m = deref(root, content[json]);
    const ex = isObj(m) ? (m.example !== undefined ? m.example : isObj(m.examples) ? (Object.values(m.examples).map((e) => deref(root, e)).find(isObj)?.value as Json | undefined) : undefined) : undefined;
    return { mode: "json", body: JSON.stringify(ex ?? sample(root, isObj(m) ? m.schema : undefined), null, 2), type: json.toLowerCase() === "application/json" ? undefined : json };
  }
  const form = types.find((t) => t.toLowerCase() === "application/x-www-form-urlencoded");
  if (form) {
    const m = deref(root, content[form]);
    const s = deref(root, isObj(m) ? m.schema : undefined);
    const props = isObj(s) && isObj(s.properties) ? Object.keys(s.properties).slice(0, 50) : [];
    return { mode: "form", body: props.map((k) => `${encodeURIComponent(k)}={{${varName(k)}}}`).join("\n") };
  }
  return { mode: "raw", body: "", type: one(types[0], 100) || undefined };
}

/** One operation as a request: `{{baseUrl}}` + its path, required parameters and auth as placeholders, a sample body. */
function opReq(spec: Obj, v2: boolean, path: string, item: Obj, method: Method, op: Obj): Req {
  const shared = paramsOf(spec, item.parameters);
  // An operation's own parameter replaces the path's of the same name and place.
  const own = paramsOf(spec, op.parameters);
  const params = [...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)), ...own];
  const url = `{{baseUrl}}${path.replace(/[\s]+/g, "").replace(/\{([^}/]{1,100})\}/g, (_, n: string) => {
    const p = params.find((x) => x.in === "path" && x.name === n);
    return p && p.example !== undefined && typeof p.example !== "object" ? encodeURIComponent(String(p.example)) : `{{${varName(n)}}}`;
  })}`.slice(0, MAX_URL);
  const auth = authHeaders(spec, spec, op, v2);
  const query = [...params.filter((p) => p.in === "query" && p.required).map((p) => `${encodeURIComponent(p.name)}=${valueOf(p)}`), ...auth.query];
  const headers: [string, string][] = [...params.filter((p) => p.in === "header" && p.required && HEADER_NAME.test(p.name)).map((p): [string, string] => [p.name, valueOf(p, false)]), ...auth.headers];
  const body = bodyOf(spec, op, params, v2);
  if (body.type && !headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", body.type]);
  if (body.body.length > MAX_BODY_IN) body.body = "";
  const name = one(op.operationId, MAX_NAME) || one(op.summary, MAX_NAME) || `${method} ${path}`.slice(0, MAX_NAME);
  return { name: name.replace(/^#+/, "").trim(), method, url, headers, query, mode: body.mode, body: body.body };
}

export function fromOpenApi(text: string): Imported {
  const r = read(text);
  if (!r.ok) return r;
  const spec = r.v;
  if (!isObj(spec)) return { ok: false, error: "That isn't an OpenAPI spec: it's not an object." };
  const v2 = typeof spec.swagger === "string" && spec.swagger.startsWith("2");
  if (!v2 && !(typeof spec.openapi === "string" && spec.openapi.startsWith("3"))) return { ok: false, error: 'That isn\'t an OpenAPI spec: no "openapi: 3…" or "swagger: 2.0" at the top.' };
  if (!isObj(spec.paths)) return { ok: false, error: "The spec has no paths." };

  const reqs: Req[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const [path, rawItem] of Object.entries(spec.paths)) {
    const item = deref(spec, rawItem);
    if (!isObj(item) || !path.startsWith("/")) continue;
    for (const [m, rawOp] of Object.entries(item)) {
      const method = m.toUpperCase() as Method;
      if (!(METHODS as readonly string[]).includes(method)) {
        if (m === "trace") skipped++;
        continue;
      }
      const op = deref(spec, rawOp);
      if (!isObj(op)) continue;
      if (reqs.length >= MAX_OPS) {
        skipped++;
        continue;
      }
      reqs.push(opReq(spec, v2, path, item, method, op));
    }
  }
  if (!reqs.length) return { ok: false, error: "The spec has no operations this client can send." };
  if (skipped) notes.push(`${skipped} operation${skipped === 1 ? "" : "s"} left out (TRACE, or more than ${MAX_OPS}).`);
  const info = isObj(spec.info) ? spec.info : {};
  return { ok: true, title: one(info.title, 120) || "OpenAPI", from: "an OpenAPI spec", server: serverOf(spec, v2), reqs, notes };
}

/** A file name for the spec's requests: its title as a plain name. */
export const fileNameOf = (title: string) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "openapi"}.http`;

/** One operation as the catalog lists it: the path as the spec writes it (`/orders/{id}`). */
export type SpecOp = { method: Method; path: string; summary: string; tag: string };

/** A spec's operations for the catalog (catalog.ts), without building requests. */
export function specOps(text: string): { ok: true; title: string; ops: SpecOp[] } | { ok: false; error: string } {
  const r = read(text);
  if (!r.ok) return r;
  const spec = r.v;
  if (!isObj(spec) || !isObj(spec.paths)) return { ok: false, error: "That isn't an OpenAPI spec: it has no paths." };
  const ops: SpecOp[] = [];
  for (const [path, rawItem] of Object.entries(spec.paths)) {
    const item = deref(spec, rawItem);
    if (!isObj(item) || !path.startsWith("/") || path.length > 500 || /[\s\r\n]/.test(path)) continue;
    for (const [m, rawOp] of Object.entries(item)) {
      const method = m.toUpperCase() as Method;
      if (!(METHODS as readonly string[]).includes(method)) continue;
      const op = deref(spec, rawOp);
      if (!isObj(op) || ops.length >= MAX_OPS) continue;
      const tags = Array.isArray(op.tags) ? op.tags : [];
      ops.push({ method, path, summary: one(op.summary, MAX_NAME) || one(op.operationId, MAX_NAME), tag: one(tags[0], 60) });
    }
  }
  const info = isObj(spec.info) ? spec.info : {};
  return { ok: true, title: one(info.title, 120) || "OpenAPI", ops };
}

/** One operation's reference, for the Quick view: what to send and what comes back. */
export type SpecDoc = {
  summary: string;
  about: string;
  params: { name: string; in: string; required: boolean; type: string; about: string }[];
  /** The JSON body's fields, nested ones as `lines[].sku`. */
  fields: { name: string; type: string; required: boolean; about: string }[];
  responses: { code: string; about: string }[];
  /** The request to start from: `{{baseUrl}}` + the path, its blanks as placeholders. */
  req: Req;
};

const MAX_FIELDS = 40;

/** A schema's type in a few words: `string (uuid)`, `array`, `one of a, b`. */
function typeOf(root: Json, schema: Json | undefined): string {
  const s = deref(root, schema);
  if (!isObj(s)) return "";
  if (Array.isArray(s.enum) && s.enum.length) return `one of ${s.enum.slice(0, 6).map((v) => one(String(v), 40)).join(", ")}${s.enum.length > 6 ? ", …" : ""}`;
  const type = Array.isArray(s.type) ? s.type.filter((t) => t !== "null").join(" or ") : one(s.type, 40);
  const format = one(s.format, 40);
  return (type || (isObj(s.properties) ? "object" : "")) + (format ? ` (${format})` : "");
}

/** A schema's properties as rows, one level of nesting into objects and arrays of objects. */
function fieldsOf(root: Json, schema: Json | undefined, prefix = "", depth = 0, out: SpecDoc["fields"] = []): SpecDoc["fields"] {
  let s = deref(root, schema);
  if (isObj(s) && Array.isArray(s.allOf)) {
    const parts = s.allOf.map((x) => deref(root, x)).filter(isObj);
    s = { properties: Object.assign({}, ...parts.map((p) => (isObj(p.properties) ? p.properties : {}))), required: parts.flatMap((p) => (Array.isArray(p.required) ? p.required : [])) };
  }
  if (!isObj(s) || !isObj(s.properties) || depth > 1) return out;
  const required = Array.isArray(s.required) ? s.required : [];
  for (const [k, raw] of Object.entries(s.properties)) {
    if (out.length >= MAX_FIELDS) break;
    const p = deref(root, raw);
    const name = `${prefix}${one(k, 60)}`;
    out.push({ name, type: typeOf(root, p), required: required.includes(k), about: isObj(p) ? one(p.description, 300) : "" });
    if (!isObj(p)) continue;
    const items = p.type === "array" ? deref(root, p.items) : undefined;
    if (isObj(items) && isObj(items.properties)) fieldsOf(root, items, `${name}[].`, depth + 1, out);
    else if (isObj(p.properties)) fieldsOf(root, p, `${name}.`, depth + 1, out);
  }
  return out;
}

/** The reference for `method path` (the path as the spec writes it), or undefined when the spec has no such operation. */
export function specDoc(text: string, method: Method, path: string): SpecDoc | undefined {
  const r = read(text);
  if (!r.ok || !isObj(r.v) || !isObj(r.v.paths)) return undefined;
  const spec = r.v;
  const paths = r.v.paths;
  const v2 = typeof spec.swagger === "string" && spec.swagger.startsWith("2");
  if (!Object.hasOwn(paths, path)) return undefined;
  const item = deref(spec, paths[path]);
  const op = isObj(item) ? deref(spec, item[method.toLowerCase()]) : undefined;
  if (!isObj(item) || !isObj(op)) return undefined;
  const own = paramsOf(spec, op.parameters);
  const params = [...paramsOf(spec, item.parameters).filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)), ...own];
  let bodySchema: Json | undefined;
  if (v2) bodySchema = params.find((p) => p.in === "body")?.schema;
  else {
    const rb = deref(spec, op.requestBody);
    const content = isObj(rb) && isObj(rb.content) ? rb.content : undefined;
    const json = content && Object.keys(content).find((t) => /^application\/(.+\+)?json\b/i.test(t));
    const m = json ? deref(spec, content[json]) : undefined;
    bodySchema = isObj(m) ? m.schema : undefined;
  }
  const responses = isObj(op.responses)
    ? Object.entries(op.responses)
        .slice(0, 20)
        .map(([code, raw]) => {
          const x = deref(spec, raw);
          return { code: one(code, 10), about: isObj(x) ? one(x.description, 300) : "" };
        })
    : [];
  return {
    summary: one(op.summary, MAX_NAME),
    about: one(op.description, 1000),
    params: params
      .filter((p) => p.in !== "body")
      .slice(0, MAX_FIELDS)
      .map((p) => ({ name: one(p.name, 100), in: one(p.in, 20), required: p.required, type: typeOf(spec, p.schema), about: p.about })),
    fields: fieldsOf(spec, bodySchema),
    responses,
    req: opReq(spec, v2, path, item, method, op),
  };
}
