/**
 * JSON tools (`json`): format, minify, validate (with line and column), a tree with each node's
 * JSONPath, a JSONPath query, a structural diff, JSON ↔ YAML and types/a schema from a sample, and the decoders that come with JSON (JWT, base64,
 * URL-encoding, Unix time). Pure: no settings, no refresh, nothing fetched.
 *
 * What's pasted is someone's work data: it's posted to these routes (not put in a URL, where it'd
 * land in history and logs), handled in the request, and never logged, stored or published.
 * The forms post under core's strictOrigin guard, so only Dovre's own pages can post to them.
 */
import type { Context } from "hono";
import type { AppEnv } from "dovre/env.ts";
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { strictOrigin } from "dovre/strict.ts";
import { MAX_INPUT, b64Decode, b64Encode, diff, epoch, format, jwtDecode, minify, parse, query, sortKeys, urlDecode, urlEncode } from "./tools.ts";
import { fromYaml, shapeOf, toJsonSchema, toTypeScript, toYaml } from "./convert.ts";
import { type ConvertOp, type ConvertState, type DecodeOp, type DecodeResult, CONVERT_OPS, DECODE_OPS, convertPage, decodePage, diffPage, formatPage, queryPage, styles } from "./view.ts";

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
  const p = parse(input);
  if (!p.ok) return { json: p };
  if (op === "yaml") return { out: toYaml(p.value) };
  if (op === "ts") return { out: toTypeScript(shapeOf(p.value), root) };
  return { out: format(toJsonSchema(shapeOf(p.value))) };
}

export function createJsonPack(opts: { now?: () => number } = {}): Pack {
  const now = opts.now ?? Date.now;
  return {
    manifest: {
      api: PACK_API,
      id: "json",
      name: "JSON tools",
      description: "Format, validate, browse, query, diff and convert JSON (YAML, TypeScript types, JSON Schema); decode JWTs, base64, URL-encoding and Unix times. Runs in the request; nothing is sent anywhere.",
      domain: "general",
      execution: "any",
      private: true,
    },
    styles,
    nav: () => [{ href: "/json", title: "JSON", icon: "code", group: "Code" }],
    pages: () => [
      { title: "JSON: format & tree", href: "/json", icon: "{}", about: "Format, minify, validate JSON and browse it as a tree", also: ["json", "pretty print", "validate", "minify", "beautify", "tree"] },
      { title: "JSON: query", href: "/json/query", icon: "{}", about: "Run a JSONPath over a document", also: ["jsonpath", "jq", "query"] },
      { title: "JSON: diff", href: "/json/diff", icon: "{}", about: "Compare two JSON documents, key order ignored", also: ["compare", "diff"] },
      { title: "JSON: convert", href: "/json/convert", icon: "{}", about: "JSON to YAML and back; TypeScript types or a JSON Schema from a sample", also: ["yaml", "typescript", "types", "interface", "json schema", "convert"] },
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
