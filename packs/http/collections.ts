/**
 * HTTP client (`http`): a Postman collection (v2.0 / v2.1 JSON) or a Bruno collection (pasted `.bru`
 * files, or Bruno's JSON export) as `.http` requests. Read only, like the OpenAPI import: nothing is
 * fetched or sent, and the text is hostile, so names and values are cut to size and stripped of line
 * breaks (a line break in a `.http` file would start another line of the request).
 *
 *  - Folders become a name prefix ("Users / Get one"). `:id` path segments become `{{id}}` (or the
 *    collection's value for it). Both tools write variables as `{{name}}`, as `.http` files do.
 *  - Auth (the request's own, else its folder's, else the collection's) becomes a header. A
 *    collection often holds a real token: any credential value that isn't only `{{placeholders}}`
 *    is replaced by one (`{{TOKEN}}`, `{{API_KEY}}`…), and the note says how many.
 *  - Checks: Bruno's simple asserts and Postman's `pm.response.to.have.status(n)` become `# @expect`
 *    lines; other scripts are never run or kept (the note counts them).
 *  - Collection variables come back as `@name = value` lines, except ones whose name looks like a
 *    secret: those are left for an environment.
 */
import type { Json } from "../json/tools.ts";
import { CREDENTIAL_HEADERS, MAX_BODY_IN, MAX_NAME, MAX_URL, METHODS, type Method, type Req } from "./model.ts";
import { type Imported, MAX_OPS, MAX_SPEC } from "./openapi.ts";

type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
const one = (v: unknown, max = 500) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "");
const varName = (s: string) => s.replace(/[^\w.-]/g, "_").replace(/^[^A-Za-z_]/, "_$&").slice(0, 64) || "value";
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const SECRETISH = /token|secret|passw|pwd|api[_-]?key|auth|cookie|session|credential|private/i;
/** Only `{{placeholders}}` (after an auth scheme word): nothing to hide. */
const onlyPlaceholders = (v: string) => !v.replace(/^(Bearer|Basic|Token|Digest)\s+/i, "").replace(/\{\{[^{}]*\}\}/g, "").trim();
/** Encodes a query or form part, leaving `{{placeholders}}` as written. */
const enc = (s: string) => s.split(/(\{\{[^{}]*\}\})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join("");

/** What both formats are read into, before the secrets are taken out. */
type Draft = {
  name: string;
  method: string;
  url: string;
  paths: Record<string, string>;
  query?: [string, string][];
  headers: [string, string][];
  body: { kind: "none" | "json" | "text" | "form"; text: string; form: [string, string][]; type?: string } | { kind: "other"; what: string };
  auth?: Auth;
  expect: string[];
  scripts: number;
};
type Auth = { kind: "none" } | { kind: "bearer"; token: string } | { kind: "basic" } | { kind: "apikey"; key: string; value: string; in: "header" | "query" } | { kind: "other"; what: string };

type Tally = { scrubbed: Set<string>; scripts: number; dropped: string[]; skipped: number };

/** `:id` path segments as `{{id}}`, or the value given for them. */
function pathVars(url: string, given: Record<string, string>): string {
  const at = url.search(/[?#]/);
  const [path, rest] = at < 0 ? [url, ""] : [url.slice(0, at), url.slice(at)];
  return path.replace(/(^|\/):([A-Za-z_][\w-]{0,63})(?=\/|$)/g, (_, pre: string, n: string) => `${pre}${given[n] ? enc(given[n]) : `{{${varName(n)}}}`}`) + rest;
}

function splitQuery(url: string): { url: string; query: string[] } {
  const at = url.indexOf("?");
  if (at < 0) return { url, query: [] };
  const hash = url.indexOf("#", at);
  const end = hash < 0 ? url.length : hash;
  return { url: url.slice(0, at) + url.slice(end), query: url.slice(at + 1, end).split("&").filter(Boolean) };
}

/** A credential's value: kept when it's placeholders only, else a placeholder named for it. */
function guard(value: string, name: string, t: Tally): string {
  if (onlyPlaceholders(value)) return value;
  t.scrubbed.add(value);
  const scheme = /^(Bearer|Basic|Token|Digest)\s+/i.exec(value)?.[0] ?? "";
  return `${scheme}{{${name}}}`;
}

function finish(d: Draft, t: Tally): Req | undefined {
  const method = d.method.toUpperCase() as Method;
  t.scripts += d.scripts;
  if (!(METHODS as readonly string[]).includes(method)) {
    t.dropped.push(`${one(d.method, 20) || "?"} ${d.name}`.slice(0, 80));
    return undefined;
  }
  const split = splitQuery(pathVars(one(d.url, MAX_URL).replace(/\s/g, "%20"), d.paths));
  // The URL's own query is what the tool sends (switched-off ones aren't in it); a list is used
  // only when the URL has none. Both are as written there, so they aren't encoded again.
  const asWritten = (s: string) => s.replace(/[\s#&]/g, encodeURIComponent);
  const query = split.query.length || !d.query ? split.query : d.query.map(([k, v]) => (v ? `${asWritten(k)}=${asWritten(v)}` : asWritten(k)));
  const headers: [string, string][] = [];
  for (const [k, v] of d.headers) {
    if (!HEADER_NAME.test(k)) continue;
    const val = one(v, 4000);
    headers.push([k, CREDENTIAL_HEADERS.has(k.toLowerCase()) ? guard(val, k.toLowerCase() === "cookie" ? "COOKIE" : "TOKEN", t) : val]);
  }
  const has = (n: string) => headers.some(([k]) => k.toLowerCase() === n.toLowerCase());
  const a = d.auth;
  if (a?.kind === "bearer" && !has("authorization")) headers.push(["Authorization", `Bearer ${guard(one(a.token, 4000), "TOKEN", t)}`]);
  else if (a?.kind === "basic" && !has("authorization")) headers.push(["Authorization", "Basic {{BASIC_AUTH}}"]);
  else if (a?.kind === "apikey" && a.key) {
    const v = guard(one(a.value, 4000), "API_KEY", t);
    if (a.in === "query") query.push(`${enc(a.key.slice(0, 100))}=${v}`);
    else if (HEADER_NAME.test(a.key) && !has(a.key)) headers.push([a.key, v]);
  } else if (a?.kind === "other") t.dropped.push(`${a.what} auth on ${d.name}`.slice(0, 80));
  let mode: Req["mode"] = "none";
  let body = "";
  const b = d.body;
  if (b.kind === "other") t.dropped.push(`${b.what} body on ${d.name}`.slice(0, 80));
  else if (b.kind === "json") {
    mode = "json";
    body = b.text;
  } else if (b.kind === "text") {
    mode = b.text.trim() ? "raw" : "none";
    body = b.text;
    if (mode === "raw" && b.type && !has("content-type")) headers.push(["Content-Type", b.type]);
  } else if (b.kind === "form" && b.form.length) {
    mode = "form";
    body = b.form.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("\n");
  }
  if (body.length > MAX_BODY_IN) {
    t.dropped.push(`the body of ${d.name} (too long)`.slice(0, 80));
    mode = "none";
    body = "";
  }
  return { name: one(d.name, MAX_NAME).replace(/^#+/, "").trim() || `${method} request`, method, url: split.url.slice(0, MAX_URL), headers, query, mode, body, ...(d.expect.length ? { expect: d.expect.map((e) => one(e, 300)) } : {}) };
}

// ── Postman ──────────────────────────────────────────────────────────────────────────────────

/** An auth's parameter: v2.1 keeps them as [{key, value}], v2.0 as an object. */
function param(a: Obj, type: string, key: string): string {
  const p = a[type];
  if (Array.isArray(p)) {
    const hit = p.find((x) => isObj(x) && x.key === key);
    return isObj(hit) ? one(hit.value, 4000) : "";
  }
  return isObj(p) ? one(p[key], 4000) : "";
}

function postmanAuth(a: Json | undefined): Auth | undefined {
  if (!isObj(a) || typeof a.type !== "string") return undefined;
  if (a.type === "noauth") return { kind: "none" };
  if (a.type === "bearer") return { kind: "bearer", token: param(a, "bearer", "token") };
  if (a.type === "basic") return { kind: "basic" };
  if (a.type === "apikey") return { kind: "apikey", key: param(a, "apikey", "key"), value: param(a, "apikey", "value"), in: param(a, "apikey", "in") === "query" ? "query" : "header" };
  return { kind: "other", what: one(a.type, 30) };
}

const enabled = (x: Json): x is Obj => isObj(x) && x.disabled !== true && x.enabled !== false;

function postmanUrl(u: Json | undefined): { url: string; paths: Record<string, string>; query?: [string, string][] } {
  if (typeof u === "string") return { url: u, paths: {} };
  if (!isObj(u)) return { url: "", paths: {} };
  const paths: Record<string, string> = {};
  for (const v of arr(u.variable)) if (isObj(v) && typeof v.key === "string") paths[v.key] = one(v.value);
  let url = one(u.raw, MAX_URL);
  if (!url) {
    const host = Array.isArray(u.host) ? u.host.map((h) => one(h)).join(".") : one(u.host);
    const path = Array.isArray(u.path) ? u.path.map((p) => one(p)).join("/") : one(u.path);
    url = `${u.protocol ? `${one(u.protocol, 10)}://` : ""}${host}${u.port ? `:${one(u.port, 10)}` : ""}${path ? `/${path.replace(/^\//, "")}` : ""}`;
  }
  // A query list (when there is one) says which are switched off; the raw URL doesn't.
  const query = Array.isArray(u.query) ? u.query.filter(enabled).flatMap((q): [string, string][] => (typeof q.key === "string" ? [[one(q.key, 200), one(q.value ?? "", 2000)]] : [])) : undefined;
  return { url, paths, query };
}

function postmanBody(b: Json | undefined): Draft["body"] {
  if (!isObj(b) || b.disabled === true) return { kind: "none", text: "", form: [] };
  const opts = isObj(b.options) && isObj(b.options.raw) ? b.options.raw : {};
  if (b.mode === "raw") {
    const text = typeof b.raw === "string" ? b.raw.slice(0, MAX_BODY_IN + 1) : "";
    const lang = one(opts.language, 20).toLowerCase();
    if (lang === "json") return { kind: "json", text, form: [] };
    return { kind: "text", text, form: [], type: lang === "xml" ? "application/xml" : lang === "html" ? "text/html" : lang === "javascript" ? "application/javascript" : undefined };
  }
  if (b.mode === "urlencoded") return { kind: "form", text: "", form: arr(b.urlencoded).filter(enabled).flatMap((x): [string, string][] => (typeof x.key === "string" ? [[one(x.key, 200), one(x.value ?? "", 4000)]] : [])) };
  if (b.mode === "graphql" && isObj(b.graphql)) {
    let variables: Json = null;
    try {
      variables = typeof b.graphql.variables === "string" && b.graphql.variables.trim() ? (JSON.parse(b.graphql.variables) as Json) : null;
    } catch {
      // Left out: the query is still there.
    }
    return { kind: "json", text: JSON.stringify({ query: typeof b.graphql.query === "string" ? b.graphql.query : "", ...(variables ? { variables } : {}) }, null, 2), form: [] };
  }
  if (b.mode === "formdata") return arr(b.formdata).some(enabled) ? { kind: "other", what: "multipart" } : { kind: "none", text: "", form: [] };
  if (b.mode === "file") return { kind: "other", what: "file" };
  return { kind: "none", text: "", form: [] };
}

/** `pm.response.to.have.status(200)` in a test script, as checks; the rest is a script left out. */
function postmanEvents(ev: Json | undefined): { expect: string[]; scripts: number } {
  const expect: string[] = [];
  let scripts = 0;
  for (const e of arr(ev)) {
    if (!isObj(e) || !isObj(e.script)) continue;
    const exec = e.script.exec;
    const src = (Array.isArray(exec) ? exec.filter((l) => typeof l === "string").join("\n") : typeof exec === "string" ? exec : "").slice(0, 100_000);
    if (!src.trim()) continue;
    const codes = [...src.matchAll(/pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/g)].map((m) => m[1]!);
    if (e.listen === "test" && codes.length) expect.push(`status ${[...new Set(codes)].join(" ")}`);
    const rest = src.replace(/pm\.test\([^]*?pm\.response\.to\.have\.status\(\s*\d{3}\s*\);?\s*\}\);?/g, "").replace(/pm\.response\.to\.have\.status\(\s*\d{3}\s*\);?/g, "").replace(/\/\/.*$/gm, "");
    if (rest.trim()) scripts++;
  }
  return { expect, scripts };
}

function fromPostman(c: Obj): Imported {
  const t: Tally = { scrubbed: new Set(), scripts: 0, dropped: [], skipped: 0 };
  const reqs: Req[] = [];
  const walk = (items: Json | undefined, prefix: string, inherited: Auth | undefined, depth: number) => {
    if (depth > 20) return;
    for (const it of arr(items)) {
      if (!isObj(it)) continue;
      const name = one(it.name, MAX_NAME);
      const label = prefix ? `${prefix} / ${name}` : name;
      if (Array.isArray(it.item)) {
        walk(it.item, label, postmanAuth(it.auth) ?? inherited, depth + 1);
        continue;
      }
      if (it.request === undefined) continue;
      if (reqs.length >= MAX_OPS) {
        t.skipped++;
        continue;
      }
      const r = typeof it.request === "string" ? { url: it.request } : isObj(it.request) ? it.request : {};
      const u = postmanUrl(r.url);
      const headers = Array.isArray(r.header)
        ? r.header.filter(enabled).flatMap((h): [string, string][] => (typeof h.key === "string" ? [[h.key.trim(), one(h.value ?? "", 4000)]] : []))
        : typeof r.header === "string"
          ? r.header.split(/\r?\n/).flatMap((l): [string, string][] => {
              const at = l.indexOf(":");
              return at > 0 ? [[l.slice(0, at).trim(), l.slice(at + 1).trim()]] : [];
            })
          : [];
      const ev = postmanEvents(it.event);
      const got = finish({ name: label, method: one(r.method, 20) || "GET", url: u.url, paths: u.paths, query: u.query, headers, body: postmanBody(r.body), auth: postmanAuth(r.auth) ?? inherited, expect: ev.expect, scripts: ev.scripts }, t);
      if (got) reqs.push(got);
    }
  };
  const info = isObj(c.info) ? c.info : {};
  walk(c.item, "", postmanAuth(c.auth), 0);
  for (const e of [c.event]) t.scripts += postmanEvents(e).scripts;
  const vars = arr(c.variable).flatMap((v): [string, string][] => (isObj(v) && typeof v.key === "string" && v.disabled !== true ? [[v.key, one(v.value ?? "", 2000)]] : []));
  return done(t, reqs, one(info.name, 120) || "Postman collection", "a Postman collection", vars);
}

// ── Bruno ────────────────────────────────────────────────────────────────────────────────────

type Block = { tag: string; lines: string[] };

/** A `.bru` file's blocks: `tag {` at the start of a line, its lines (one indent off), `}` alone. */
function bruBlocks(text: string): Block[] {
  const out: Block[] = [];
  let cur: Block | undefined;
  for (const line of text.split("\n")) {
    if (!cur) {
      const m = /^([\w:~-]+)\s*\{\s*$/.exec(line);
      if (m) cur = { tag: m[1]!, lines: [] };
    } else if (/^\}\s*$/.test(line)) {
      out.push(cur);
      cur = undefined;
    } else cur.lines.push(line.replace(/^ {2}/, ""));
  }
  return out;
}

/** A dictionary block's entries, switched-off (`~`) ones left out. */
function bruDict(b: Block | undefined): [string, string][] {
  if (!b) return [];
  return b.lines.flatMap((l): [string, string][] => {
    const m = /^\s*([^:\s][^:]*?)\s*:\s?(.*)$/.exec(l);
    return m && !m[1]!.startsWith("~") ? [[m[1]!, m[2]!.trim()]] : [];
  });
}

/** A Bruno assert (`res.status: eq 200`) as a check, if it's one this client has. */
function bruAssert(key: string, rule: string): string | undefined {
  const m = /^(eq|neq|lt|lte|gt|gte|contains|isDefined|isString|isNumber)\s*(.*)$/.exec(rule.trim());
  if (!m) return undefined;
  const [, op, val] = m as unknown as [string, string, string];
  const ops: Record<string, string> = { eq: "==", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=", contains: "contains" };
  if (key === "res.status" && op === "eq" && /^\d{3}$/.test(val)) return `status ${val}`;
  if (key === "res.responseTime" && (op === "lt" || op === "lte") && /^\d+$/.test(val)) return `time ${ops[op]} ${val}`;
  const body = /^res\.body((?:\.[A-Za-z_$][\w$]*|\[\d+\])*)$/.exec(key);
  if (body) {
    const path = `$${body[1]}`;
    if (op === "isDefined") return `json ${path} exists`;
    if (ops[op] && val) return `json ${path} ${ops[op]} ${val}`;
  }
  return undefined;
}

function bruAuth(mode: string, get: (tag: string) => Block | undefined): Auth | undefined {
  const d = (tag: string) => Object.fromEntries(bruDict(get(tag)));
  if (!mode || mode === "none") return { kind: "none" };
  if (mode === "inherit") return undefined;
  if (mode === "bearer") return { kind: "bearer", token: d("auth:bearer").token ?? "" };
  if (mode === "basic") return { kind: "basic" };
  if (mode === "apikey") {
    const a = d("auth:apikey");
    return { kind: "apikey", key: a.key ?? "", value: a.value ?? "", in: a.placement === "queryparams" ? "query" : "header" };
  }
  return { kind: "other", what: mode.slice(0, 30) };
}

function bruFile(text: string, t: Tally): Draft | undefined {
  const blocks = bruBlocks(text);
  const get = (tag: string) => blocks.find((b) => b.tag === tag);
  const meta = Object.fromEntries(bruDict(get("meta")));
  const verb = blocks.find((b) => (METHODS as readonly string[]).includes(b.tag.toUpperCase()) || ["trace", "connect"].includes(b.tag));
  if (!verb) {
    if (meta.type && meta.type !== "http") t.dropped.push(`${one(meta.type, 20)} request ${one(meta.name, 60)}`.slice(0, 80));
    return undefined;
  }
  const v = Object.fromEntries(bruDict(verb));
  const raw = (tag: string) => get(tag)?.lines.join("\n").replace(/\s+$/, "") ?? "";
  const kind = v.body ?? "none";
  const body: Draft["body"] =
    kind === "json"
      ? { kind: "json", text: raw("body:json"), form: [] }
      : kind === "text" || kind === "xml" || kind === "sparql"
        ? { kind: "text", text: raw(`body:${kind}`), form: [], type: kind === "xml" ? "application/xml" : kind === "sparql" ? "application/sparql-query" : "text/plain" }
        : kind === "formUrlEncoded" || kind === "form-urlencoded"
          ? { kind: "form", text: "", form: bruDict(get("body:form-urlencoded")) }
          : kind === "graphql"
            ? { kind: "json", text: JSON.stringify({ query: raw("body:graphql") }, null, 2), form: [] }
            : kind === "none"
              ? { kind: "none", text: "", form: [] }
              : { kind: "other", what: one(kind, 30) };
  const queryBlock = get("params:query") ?? get("query");
  const expect = bruDict(get("assert")).flatMap(([k, r]) => {
    const c = bruAssert(k, r);
    if (!c) t.dropped.push(`the assert ${k}: ${r}`.slice(0, 80));
    return c ? [c] : [];
  });
  const scripts = blocks.filter((b) => /^(script:|tests$)/.test(b.tag) && b.lines.join("").trim()).length;
  return {
    name: meta.name ?? "",
    method: verb.tag,
    url: v.url ?? "",
    paths: Object.fromEntries(bruDict(get("params:path"))),
    query: queryBlock ? bruDict(queryBlock) : undefined,
    headers: bruDict(get("headers")),
    body,
    auth: bruAuth(v.auth ?? "none", get),
    expect,
    scripts,
  };
}

function fromBru(text: string): Imported {
  const t: Tally = { scrubbed: new Set(), scripts: 0, dropped: [], skipped: 0 };
  const reqs: Req[] = [];
  // Several files pasted one after another: each starts at its `meta {`.
  const files = text.split(/\n(?=meta\s*\{\s*$)/m);
  for (const f of files) {
    if (reqs.length >= MAX_OPS) {
      t.skipped++;
      continue;
    }
    const d = bruFile(f, t);
    const got = d && finish(d, t);
    if (got) reqs.push(got);
  }
  return done(t, reqs, files.length === 1 ? one(reqs[0]?.name, 120) || "Bruno request" : "Bruno collection", "a Bruno collection", []);
}

/** Bruno's JSON export: the same requests as the `.bru` files, as objects. */
function fromBrunoJson(c: Obj): Imported {
  const t: Tally = { scrubbed: new Set(), scripts: 0, dropped: [], skipped: 0 };
  const reqs: Req[] = [];
  const pairs = (list: Json | undefined, filter?: (x: Obj) => boolean): [string, string][] => arr(list).filter(enabled).filter((x) => !filter || filter(x)).flatMap((x): [string, string][] => (typeof x.name === "string" ? [[x.name.trim(), one(x.value ?? "", 4000)]] : []));
  const walk = (items: Json | undefined, prefix: string, inherited: Auth | undefined, depth: number) => {
    if (depth > 20) return;
    for (const it of arr(items)) {
      if (!isObj(it)) continue;
      const name = one(it.name, MAX_NAME);
      const label = prefix ? `${prefix} / ${name}` : name;
      const own = isObj(it.root) && isObj(it.root.request) ? jsonAuth(it.root.request.auth) : undefined;
      if (it.type === "folder") {
        walk(it.items, label, own ?? inherited, depth + 1);
        continue;
      }
      if (!isObj(it.request)) continue;
      if (it.type !== "http-request" && it.type !== "http") {
        t.dropped.push(`${one(it.type, 20)} request ${name}`.slice(0, 80));
        continue;
      }
      if (reqs.length >= MAX_OPS) {
        t.skipped++;
        continue;
      }
      const r = it.request;
      const b = isObj(r.body) ? r.body : {};
      const mode = one(b.mode, 30) || "none";
      const body: Draft["body"] =
        mode === "json"
          ? { kind: "json", text: typeof b.json === "string" ? b.json : "", form: [] }
          : mode === "text" || mode === "xml"
            ? { kind: "text", text: typeof b[mode] === "string" ? (b[mode] as string) : "", form: [], type: mode === "xml" ? "application/xml" : "text/plain" }
            : mode === "formUrlEncoded"
              ? { kind: "form", text: "", form: pairs(b.formUrlEncoded) }
              : mode === "graphql" && isObj(b.graphql)
                ? { kind: "json", text: JSON.stringify({ query: one(b.graphql.query, MAX_BODY_IN) }, null, 2), form: [] }
                : mode === "none"
                  ? { kind: "none", text: "", form: [] }
                  : { kind: "other", what: mode };
      const expect = pairs(r.assertions).flatMap(([k, v]) => {
        const c = bruAssert(k, v);
        if (!c) t.dropped.push(`the assert ${k}: ${v}`.slice(0, 80));
        return c ? [c] : [];
      });
      const scripts = [isObj(r.script) ? r.script.req : "", isObj(r.script) ? r.script.res : "", r.tests].filter((s) => typeof s === "string" && s.trim()).length;
      const params = arr(r.params);
      const hasQuery = params.some((p) => isObj(p) && p.type === "query");
      const got = finish(
        {
          name: label,
          method: one(r.method, 20) || "GET",
          url: one(r.url, MAX_URL),
          paths: Object.fromEntries(pairs(r.params, (x) => x.type === "path")),
          query: hasQuery ? pairs(r.params, (x) => x.type === "query") : undefined,
          headers: pairs(r.headers),
          body,
          auth: jsonAuth(r.auth) ?? inherited,
          expect,
          scripts,
        },
        t,
      );
      if (got) reqs.push(got);
    }
  };
  walk(c.items, "", isObj(c.root) && isObj(c.root.request) ? jsonAuth(c.root.request.auth) : undefined, 0);
  return done(t, reqs, one(c.name, 120) || "Bruno collection", "a Bruno collection", []);
}

function jsonAuth(a: Json | undefined): Auth | undefined {
  if (!isObj(a)) return undefined;
  const mode = one(a.mode, 30);
  const sub = (k: string) => (isObj(a[k]) ? (a[k] as Obj) : {});
  if (mode === "bearer") return { kind: "bearer", token: one(sub("bearer").token, 4000) };
  if (mode === "apikey") return { kind: "apikey", key: one(sub("apikey").key, 100), value: one(sub("apikey").value, 4000), in: sub("apikey").placement === "queryparams" ? "query" : "header" };
  return bruAuth(mode, () => undefined);
}

// ── Both ─────────────────────────────────────────────────────────────────────────────────────

function done(t: Tally, reqs: Req[], title: string, from: string, rawVars: [string, string][]): Imported {
  if (!reqs.length) return { ok: false, error: `${from[0]!.toUpperCase()}${from.slice(1)} with no requests this client can send.` };
  const notes: string[] = [];
  const vars: [string, string][] = [];
  const held: string[] = [];
  for (const [k, v] of rawVars.slice(0, 200)) {
    if (!/^[A-Za-z_][\w.-]{0,63}$/.test(k)) continue;
    if (SECRETISH.test(k) && v && !onlyPlaceholders(v)) held.push(k);
    else vars.push([k, v]);
  }
  if (t.scrubbed.size) notes.push(`${t.scrubbed.size} credential value${t.scrubbed.size === 1 ? "" : "s"} replaced by a {{placeholder}}.`);
  if (held.length) notes.push(`Variables left for an environment (they look secret): ${held.slice(0, 10).join(", ")}${held.length > 10 ? "…" : ""}.`);
  if (t.scripts) notes.push(`${t.scripts} script${t.scripts === 1 ? "" : "s"} left out (never run).`);
  if (t.dropped.length) notes.push(`Left out: ${t.dropped.slice(0, 5).join("; ")}${t.dropped.length > 5 ? ` and ${t.dropped.length - 5} more` : ""}.`);
  if (t.skipped) notes.push(`${t.skipped} request${t.skipped === 1 ? "" : "s"} past the first ${MAX_OPS} left out.`);
  return { ok: true, title, from, server: "", reqs, notes, vars };
}

/** Postman or Bruno text, or undefined when it's neither (then it may be an OpenAPI spec). */
export function fromCollection(text: string): Imported | undefined {
  if (text.length > MAX_SPEC) return undefined;
  const src = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  if (/^meta\s*\{\s*$/m.test(src) && /^\s*[^{[\s]/.test(src)) return fromBru(src);
  if (!/^\s*\{/.test(src)) return undefined;
  let v: Json;
  try {
    v = JSON.parse(src) as Json;
  } catch {
    return undefined;
  }
  if (!isObj(v)) return undefined;
  const info = isObj(v.info) ? v.info : undefined;
  if (info && (/getpostman\.com/.test(one(info.schema)) || typeof info._postman_id === "string") && Array.isArray(v.item)) return fromPostman(v);
  if (!info && Array.isArray(v.items) && typeof v.name === "string" && !("openapi" in v) && !("swagger" in v)) return fromBrunoJson(v);
  return undefined;
}

/** `@name = value` lines for a new file's top (values on one line, as `.http` reads them). */
export const varLines = (vars: [string, string][]) => vars.map(([k, v]) => `@${k} = ${v.replace(/[\r\n]+/g, " ")}`).join("\n");
