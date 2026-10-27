/**
 * JSON tools (`json`): conversions. JSON ↔ YAML (the `yaml` package), and a shape inferred from a
 * sample, written out as TypeScript types or a JSON Schema. Pure, like tools.ts.
 */
import { parseDocument, stringify, YAMLParseError } from "yaml";
import { type Json, MAX_DEPTH, MAX_INPUT, lineCol } from "./tools.ts";

// ── YAML ─────────────────────────────────────────────────────────────────────

export const toYaml = (v: Json) => stringify(v, { lineWidth: 0, aliasDuplicateObjects: false });

export type FromYaml = { ok: true; value: Json } | { ok: false; error: string; line: number; column: number };

/** Depth of a value, stopping once it's past `max`. */
function deeper(v: unknown, max: number, d = 0): boolean {
  if (d > max) return true;
  if (v && typeof v === "object") for (const x of Object.values(v)) if (deeper(x, max, d + 1)) return true;
  return false;
}

/**
 * YAML to a JSON value. The core schema only (no dates or custom tags), few aliases (a "billion
 * laughs" document is refused), and keys must be unique.
 */
export function fromYaml(text: string): FromYaml {
  if (text.length > MAX_INPUT) return { ok: false, error: `Too long: ${text.length} characters (${MAX_INPUT} at most)`, line: 1, column: 1 };
  const doc = parseDocument(text, { schema: "core", uniqueKeys: true, prettyErrors: false });
  const err = doc.errors[0];
  if (err) {
    return { ok: false, error: err.message.split("\n")[0]!.slice(0, 200), ...lineCol(text, err.pos[0]) };
  }
  try {
    const v = doc.toJS({ maxAliasCount: 50 });
    if (deeper(v, MAX_DEPTH)) return { ok: false, error: `Nested too deep (${MAX_DEPTH} levels at most)`, line: 1, column: 1 };
    // Round-trip through JSON: what YAML has and JSON hasn't (.inf, .nan, an undefined) becomes what JSON makes of it.
    return { ok: true, value: JSON.parse(JSON.stringify(v ?? null)) as Json };
  } catch (e) {
    const m = e instanceof YAMLParseError || e instanceof Error ? e.message : String(e);
    return { ok: false, error: m.split("\n")[0]!.slice(0, 200), line: 1, column: 1 };
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

type Prim = "string" | "integer" | "number" | "boolean" | "null";

/** What every value seen at one place looked like. */
export type Shape = {
  /** Values seen here. */
  n: number;
  prims: Set<Prim>;
  obj?: { n: number; keys: Map<string, Shape> };
  arr?: { n: number; items: Shape };
};

const empty = (): Shape => ({ n: 0, prims: new Set() });

function add(s: Shape, v: Json): void {
  s.n++;
  if (v === null) s.prims.add("null");
  else if (typeof v === "string") s.prims.add("string");
  else if (typeof v === "boolean") s.prims.add("boolean");
  else if (typeof v === "number") s.prims.add(Number.isInteger(v) ? "integer" : "number");
  else if (Array.isArray(v)) {
    s.arr ??= { n: 0, items: empty() };
    s.arr.n++;
    for (const x of v) add(s.arr.items, x);
  } else {
    s.obj ??= { n: 0, keys: new Map() };
    s.obj.n++;
    for (const [k, x] of Object.entries(v)) {
      let ks = s.obj.keys.get(k);
      if (!ks) s.obj.keys.set(k, (ks = empty()));
      add(ks, x);
    }
  }
}

/** The shape of a sample: arrays' items merged, a key optional where some objects lack it. */
export function shapeOf(v: Json): Shape {
  const s = empty();
  add(s, v);
  return s;
}

const optional = (parent: Shape, key: Shape) => key.n < parent.obj!.n;

// ── TypeScript ───────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function pascal(hint: string): string {
  const p = hint
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
  return !p ? "Item" : /^[0-9]/.test(p) ? `T${p}` : p;
}

/** A plural key's item name: `users` → `User`, `entries` → `Entry`. */
export function singular(hint: string): string {
  if (/ies$/i.test(hint) && hint.length > 3) return hint.slice(0, -3) + "y";
  if (/[^sui]s$/i.test(hint) && hint.length > 2) return hint.slice(0, -1);
  return `${hint}Item`;
}

/** TypeScript declarations for a shape: one interface per object, the root named `root`. */
export function toTypeScript(s: Shape, root = "Root"): string {
  const used = new Set<string>();
  const out: string[] = [];
  const name = (hint: string) => {
    const base = pascal(hint);
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}${i}`;
    used.add(n);
    return n;
  };
  const typeOf = (sh: Shape, hint: string): string => {
    const parts: string[] = [];
    if (sh.obj) {
      const iface = name(hint);
      const at = out.length;
      out.push("");
      const lines = [...sh.obj.keys].map(([k, ks]) => `  ${IDENT.test(k) ? k : JSON.stringify(k)}${optional(sh, ks) ? "?" : ""}: ${typeOf(ks, k)};`);
      out[at] = lines.length ? `export interface ${iface} {\n${lines.join("\n")}\n}` : `export type ${iface} = Record<string, never>;`;
      parts.push(iface);
    }
    if (sh.arr) {
      const t = sh.arr.items.n ? typeOf(sh.arr.items, singular(hint)) : "unknown";
      parts.push(t.includes(" | ") ? `(${t})[]` : `${t}[]`);
    }
    if (sh.prims.has("string")) parts.push("string");
    if (sh.prims.has("integer") || sh.prims.has("number")) parts.push("number");
    if (sh.prims.has("boolean")) parts.push("boolean");
    if (sh.prims.has("null")) parts.push("null");
    return parts.length ? parts.join(" | ") : "unknown";
  };
  // A root that isn't just an object gets a type alias of its own, named before the rest take names.
  const alias = s.obj ? undefined : name(root);
  const t = typeOf(s, root);
  if (!s.obj || s.arr || s.prims.size) out.unshift(`export type ${alias ?? name(root)} = ${t};`);
  return out.join("\n\n") + "\n";
}

// ── JSON Schema ──────────────────────────────────────────────────────────────

export type Schema = { [k: string]: Json };

/** A JSON Schema (draft 2020-12) a sample fits; every key seen in all objects is required. */
export function toJsonSchema(s: Shape): Schema {
  const of = (sh: Shape): Schema => {
    const types: string[] = [];
    const out: Schema = {};
    if (sh.obj) {
      types.push("object");
      const props: Schema = {};
      const required: string[] = [];
      for (const [k, ks] of sh.obj.keys) {
        props[k] = of(ks);
        if (!optional(sh, ks)) required.push(k);
      }
      out.properties = props;
      if (required.length) out.required = required;
    }
    if (sh.arr) {
      types.push("array");
      if (sh.arr.items.n) out.items = of(sh.arr.items);
    }
    if (sh.prims.has("string")) types.push("string");
    if (sh.prims.has("number")) types.push("number");
    else if (sh.prims.has("integer")) types.push("integer");
    if (sh.prims.has("boolean")) types.push("boolean");
    if (sh.prims.has("null")) types.push("null");
    return types.length ? { type: types.length === 1 ? types[0]! : types, ...out } : {};
  };
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...of(s) };
}
