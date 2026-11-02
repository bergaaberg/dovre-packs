/**
 * JSON tools (`json`): format, minify, validate (with line and column), a tree with each node's
 * JSONPath, a JSONPath query, a structural diff, JSON ↔ YAML and types/a schema from a sample, and the decoders that come with JSON (JWT, base64,
 * URL-encoding, Unix time). Pure: no settings, no refresh, nothing fetched.
 *
 * What's pasted is someone's work data: it's posted to these routes (not put in a URL, where it'd
 * land in history and logs), handled in the request, and never logged, stored or published.
 * The forms post under core's strictOrigin guard, so only Dovre's own pages can post to them.
 */
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import type { AppEnv } from "dovre/env.ts";
import { type Pack } from "dovre/packs/types.ts";
import { strictOrigin } from "dovre/strict.ts";
import { MAX_INPUT, b64Decode, b64Encode, diff, epoch, format, jwtDecode, minify, parse, query, sortKeys, urlDecode, urlEncode } from "./tools.ts";
import { fromToml, fromYaml, shapeOf, toJsonSchema, toToml, toTypeScript, toYaml } from "./convert.ts";
import { type ConvertOp, type ConvertState, type DecodeOp, type DecodeResult, type DockOp, CONVERT_OPS, DECODE_OPS, DOCK_OPS, convertPage, decodePage, diffPage, dockView, formatPage, jqPage, queryPage, styles } from "./view.ts";
import { SCRIPT, WORKER_JS } from "./script.ts";
import { JQ_JS_SHA, JQ_WASM_SHA } from "./gen.ts";

/** FNV-1a: a served file's URL changes when it does. */
const hashOf = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
export const WORKER_PATH = `/json/jq-worker.${hashOf(WORKER_JS)}.js`;
const vendored = (name: string) => () => new Uint8Array(readFileSync(new URL(`./vendor/${name}`, import.meta.url)));

/** What the dock's buttons do: the format and decode tools, on one box. */
export function dockRun(op: DockOp, input: string, now: number): { out?: string; error?: string } {
  if (op === "format" || op === "minify") {
    const p = parse(input);
    if (!p.ok) return { error: `Not valid JSON: ${p.error} (line ${p.line}, column ${p.column})` };
    return { out: op === "minify" ? minify(p.value) : format(p.value) };
  }
  const r = decode(op, input.trim(), now);
  if (r.op === "error") return { error: r.error };
  if (r.op === "text") return { out: r.json !== undefined ? format(r.json) : r.text };
  if (r.op === "epoch") return { out: `${r.iso}\n${r.seconds} s · ${r.ms} ms (read as ${r.unit})` };
  const times = Object.fromEntries(r.times.map((t) => [t.claim, t.iso]));
  const state = r.expired ? "expired" : r.notYet ? "not valid yet" : undefined;
  return { out: `${state ? `(${state}; signature not checked)\n` : "(signature not checked)\n"}${format({ header: r.header, payload: r.payload, ...(r.times.length ? { times } : {}) } as never)}` };
}

/** A body bigger than this is refused before it's read (two documents at MAX_INPUT, form-encoded). */
const MAX_BODY = 8 * MAX_INPUT;

async function form(c: Context<AppEnv>): Promise<Record<string, string> | undefined> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY) return undefined;
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v.length > MAX_INPUT ? v.slice(0, MAX_INPUT + 1) : v;
  return out;
}

const tooBig = (c: Context<AppEnv>) => c.text(`Too much to paste at once (${MAX_INPUT} characters at most per box).`, 413);

export function decode(op: DecodeOp, input: string, now: number): DecodeResult {
  if (input.length > MAX_INPUT) return { op: "error", error: `Too long (${MAX_INPUT} characters at most)` };
  if (op === "jwt") {
    const r = jwtDecode(input, now);
    return r.ok ? { op: "jwt", ...r } : { op: "error", error: r.error };
  }
  if (op === "epoch") {
    const r = epoch(input);
    return r.ok ? { op: "epoch", ms: r.ms, seconds: r.seconds, iso: r.iso, unit: r.unit } : { op: "error", error: r.error };
  }
  if (op === "b64e" || op === "b64ue") return { op: "text", text: b64Encode(input, op === "b64ue") };
  if (op === "urle") return { op: "text", text: urlEncode(input) };
  const r = op === "b64d" ? b64Decode(input) : urlDecode(input);
  if (!r.ok) return { op: "error", error: r.error };
  const asJson = !r.binary && /^\s*[[{]/.test(r.text) ? parse(r.text) : undefined;
  return { op: "text", text: r.text, binary: r.binary, json: asJson?.ok ? asJson.value : undefined };
}

export function convert(op: ConvertOp, input: string, root = "Root"): ConvertState["result"] {
  if (op === "json") {
    const y = fromYaml(input);
    return y.ok ? { out: format(y.value) } : { yaml: y };
  }
  if (op === "fromtoml") {
    const t = fromToml(input);
    return t.ok ? { out: format(t.value) } : { toml: t };
  }
  const p = parse(input);
  if (!p.ok) return { json: p };
  if (op === "yaml") return { out: toYaml(p.value) };
  if (op === "toml") {
    const t = toToml(p.value);
    return t.ok ? { out: t.out } : { error: t.error };
  }
  if (op === "ts") return { out: toTypeScript(shapeOf(p.value), root) };
  return { out: format(toJsonSchema(shapeOf(p.value))) };
}

export function createJsonPack(opts: { now?: () => number } = {}): Pack {
  const now = opts.now ?? Date.now;
  return {
    manifest: {
      api: "1.6",
      version: "1.0.0",
      id: "json",
      name: "JSON tools",
      description: "Format, validate, browse, query, diff and convert JSON (YAML, TypeScript types, JSON Schema); decode JWTs, base64, URL-encoding and Unix times. Runs in the request; nothing is sent anywhere.",
      domain: "general",
      execution: "any",
      private: true,
    },
    styles,
    script: SCRIPT,
    wasm: { jq: { sha256: JQ_WASM_SHA, load: vendored("jq.wasm") } },
    files: { "jq.js": { sha256: JQ_JS_SHA, load: vendored("jq.js") } },
    dock: () => ({ label: "JSON", key: "J", title: "Format JSON, decode a JWT, base64 or a Unix time" }),
    nav: () => [{ href: "/json", title: "JSON", icon: "code", group: "Code" }],
    pages: () => [
      { title: "JSON: format & tree", href: "/json", icon: "{}", about: "Format, minify, validate JSON and browse it as a tree", also: ["json", "pretty print", "validate", "minify", "beautify", "tree"] },
      { title: "JSON: query", href: "/json/query", icon: "{}", about: "Run a JSONPath over a document", also: ["jsonpath", "query"] },
      { title: "JSON: jq", href: "/json/jq", icon: "{}", about: "Filter and reshape JSON with jq, in your browser", also: ["jq", "filter", "select", "map"] },
      { title: "JSON: diff", href: "/json/diff", icon: "{}", about: "Compare two JSON documents, key order ignored", also: ["compare", "diff"] },
      { title: "JSON: convert", href: "/json/convert", icon: "{}", about: "JSON to YAML or TOML and back; TypeScript types or a JSON Schema from a sample", also: ["yaml", "toml", "typescript", "types", "interface", "json schema", "convert"] },
      { title: "JSON: decode", href: "/json/decode", icon: "{}", about: "Decode a JWT, base64 or URL-encoding; Unix time to date", also: ["jwt", "base64", "url decode", "epoch", "timestamp", "unix time"] },
    ],
    about: (_ctx, path) => (path.startsWith("/json") ? "JSON tools (what's pasted here isn't shared)" : undefined),
    routes(app, ctx) {
      const page = (c: Context<AppEnv>, title: string, body: Parameters<typeof ctx.page>[1]["body"]) => ctx.page(c, { title, body, current: "/json" });

      app.get("/json", (c) => page(c, "JSON", formatPage({ input: "" })));
      app.post("/json", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const input = f.input ?? "";
        const op = f.op === "minify" || f.op === "tree" ? f.op : "format";
        const indent = f.indent === "4" || f.indent === "tab" ? f.indent : "2";
        const sort = f.sort === "1";
        const parsed = parse(input);
        let out: string | undefined, value;
        if (parsed.ok) {
          value = sort ? sortKeys(parsed.value) : parsed.value;
          out = op === "minify" ? minify(value) : op === "format" ? format(value, indent === "tab" ? "\t" : Number(indent)) : undefined;
        }
        return page(c, "JSON", formatPage({ input, op, indent, sort, result: { parsed, out, value } }));
      });

      app.get("/json/query", (c) => page(c, "JSON query", queryPage({ input: "", path: "$" })));
      app.post("/json/query", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const input = f.input ?? "";
        const path = (f.path ?? "$").slice(0, 2000);
        const parsed = parse(input);
        if (!parsed.ok) return page(c, "JSON query", queryPage({ input, path, result: { parsed } }));
        try {
          const r = query(parsed.value, path);
          return page(c, "JSON query", queryPage({ input, path, result: { parsed, matches: r.matches, more: r.more } }));
        } catch (e) {
          return page(c, "JSON query", queryPage({ input, path, result: { parsed, error: (e as Error).message } }));
        }
      });

      const jqAt = () => ({ worker: WORKER_PATH, core: ctx.file("jq.js"), wasm: ctx.wasm("jq") });
      app.get("/json/jq", (c) => page(c, "jq", jqPage({ input: "", filter: ".", at: jqAt() })));
      // Only without the page's script: jq never runs on the server.
      app.post("/json/jq", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        return page(c, "jq", jqPage({ input: f.input ?? "", filter: (f.filter ?? ".").slice(0, 4000), at: jqAt(), posted: true }));
      });
      app.get(WORKER_PATH, (c) => {
        c.header("Content-Type", "text/javascript; charset=utf-8");
        c.header("Cache-Control", "private, max-age=31536000, immutable");
        return c.body(WORKER_JS);
      });

      app.get("/json/dock", (c) => ctx.dockPage(c, { title: "JSON", body: dockView({ input: "" }) }));
      app.post("/json/dock", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const input = f.input ?? "";
        const op = (DOCK_OPS.find(([v]) => v === f.op)?.[0] ?? "format") as DockOp;
        return ctx.dockPage(c, { title: "JSON", body: dockView({ input, op, ...dockRun(op, input, now()) }) });
      });

      app.get("/json/diff", (c) => page(c, "JSON diff", diffPage({ a: "", b: "" })));
      app.post("/json/diff", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const a = f.a ?? "", b = f.b ?? "";
        const pa = parse(a), pb = parse(b);
        const r = pa.ok && pb.ok ? diff(pa.value, pb.value) : undefined;
        return page(c, "JSON diff", diffPage({ a, b, result: { pa, pb, changes: r?.changes, more: r?.more } }));
      });

      app.get("/json/convert", (c) => page(c, "Convert", convertPage({ input: "" })));
      app.post("/json/convert", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const input = f.input ?? "";
        const op = (CONVERT_OPS.find(([v]) => v === f.op)?.[0] ?? "yaml") as ConvertOp;
        const root = (f.root ?? "").trim().slice(0, 60) || "Root";
        return page(c, "Convert", convertPage({ input, op, root, result: convert(op, input, root) }));
      });

      app.get("/json/decode", (c) => page(c, "Decode", decodePage({ input: "", now: now() })));
      app.post("/json/decode", strictOrigin, async (c) => {
        const f = await form(c);
        if (!f) return tooBig(c);
        const input = f.input ?? "";
        const op = (DECODE_OPS.find(([v]) => v === f.op)?.[0] ?? "jwt") as DecodeOp;
        const at = now();
        return page(c, "Decode", decodePage({ input, op, now: at, result: decode(op, input, at) }));
      });
    },
  };
}

export const jsonPack = createJsonPack();
