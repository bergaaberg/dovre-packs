/**
 * HTTP client (`http`): checks on a response, for running a `.http` file as a smoke test.
 *
 * A request's checks are `# @expect …` lines in its block (other clients read them as comments):
 *   # @expect status 200            (or 2xx, or several: 200 204)
 *   # @expect time < 800            (ms; <, <=)
 *   # @expect header content-type contains json   (or: header x-id, header etag == "abc")
 *   # @expect body contains ok
 *   # @expect json $.items[0].id == 3              (or: exists, !=, contains, <, <=, >, >=)
 * A request with none passes on any status below 400. Checks are literal: {{placeholders}} in them
 * aren't filled in. Nothing here does I/O; what it reads (the response) is already masked.
 */
import { type Json, parse, query } from "../json/tools.ts";
import type { Resp } from "./send.ts";

/** Most checks a request keeps, and the longest one. */
export const MAX_CHECKS = 30;
export const MAX_CHECK = 300;

type Op = "==" | "!=" | "contains" | "<" | "<=" | ">" | ">=";

export type Check =
  | { t: "status"; codes: string[] }
  | { t: "time"; op: "<" | "<="; ms: number }
  | { t: "header"; name: string; op?: "==" | "contains"; value?: string }
  | { t: "body"; value: string }
  | { t: "json"; path: string; op?: Op; lit?: Json; raw?: string };

export type Outcome = { text: string; ok: boolean; got?: string };

const unquote = (s: string) => (/^"(.*)"$/.test(s) ? s.slice(1, -1) : s);

/** A literal: JSON when it reads as JSON (3, true, null, "a b"), else the text as it is. */
function literal(s: string): Json {
  const p = parse(s);
  return p.ok ? p.value : s;
}

/** One check's text into a Check, or why it can't be read. */
export function parseCheck(text: string): Check | { error: string } {
  const s = text.trim();
  const [word = "", ...rest] = s.split(/\s+/);
  const tail = s.slice(word.length).trim();
  switch (word.toLowerCase()) {
    case "status": {
      const codes = rest.map((c) => c.toLowerCase());
      if (!codes.length || !codes.every((c) => /^[1-5](\d\d|xx)$/.test(c))) return { error: "status takes codes like 200 or 2xx" };
      return { t: "status", codes };
    }
    case "time": {
      const m = /^(<=?)\s*(\d{1,6})\s*(ms)?$/.exec(tail);
      if (!m) return { error: "time takes < or <= and milliseconds (time < 800)" };
      return { t: "time", op: m[1] as "<" | "<=", ms: Number(m[2]) };
    }
    case "header": {
      const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]{1,100})(?:\s+(==|contains)\s+(.+))?$/.exec(tail);
      if (!m) return { error: "header takes a name, then optionally == or contains and a value" };
      return { t: "header", name: m[1]!.toLowerCase(), ...(m[2] ? { op: m[2] as "==" | "contains", value: unquote(m[3]!.trim()) } : {}) };
    }
    case "body": {
      const m = /^contains\s+(.+)$/.exec(tail);
      if (!m) return { error: "body takes contains and a text (body contains ok)" };
      return { t: "body", value: unquote(m[1]!.trim()) };
    }
    case "json": {
      const m = /^(\$\S*)(?:\s+(exists|==|!=|contains|<=|>=|<|>)(?:\s+(.+))?)?$/.exec(tail);
      if (!m) return { error: "json takes a path from $, then exists, ==, !=, contains, <, <=, > or >= and a value" };
      const op = m[2] === "exists" ? undefined : (m[2] as Op | undefined);
      if (op && m[3] === undefined) return { error: `json … ${op} needs a value` };
      if (!op && m[3] !== undefined) return { error: "json … exists takes no value" };
      try {
        query(null, m[1]!);
      } catch (e) {
        return { error: `that path can't be read: ${(e as Error).message}` };
      }
      if (op && ["<", "<=", ">", ">="].includes(op) && typeof literal(m[3]!) !== "number") return { error: `json … ${op} compares with a number` };
      return { t: "json", path: m[1]!, ...(op ? { op, lit: op === "contains" ? unquote(m[3]!.trim()) : literal(m[3]!.trim()), raw: m[3]!.trim() } : {}) };
    }
    default:
      return { error: "a check starts with status, time, header, body or json" };
  }
}

const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/** Deep equality for JSON values (key order ignored). */
function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as Json[]).length && a.every((x, i) => same(x, (b as Json[])[i]!));
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => k in (b as object) && same((a as Record<string, Json>)[k]!, (b as Record<string, Json>)[k]!));
}

function statusOk(codes: string[], status: number): boolean {
  const s = String(status);
  return codes.some((c) => (c.endsWith("xx") ? s[0] === c[0] : s === c));
}

/** One check against a response. */
export function runCheck(text: string, resp: Resp): Outcome {
  const c = parseCheck(text);
  if ("error" in c) return { text, ok: false, got: `not understood: ${c.error}` };
  switch (c.t) {
    case "status":
      return { text, ok: statusOk(c.codes, resp.status), got: String(resp.status) };
    case "time":
      return { text, ok: c.op === "<" ? resp.ms < c.ms : resp.ms <= c.ms, got: `${resp.ms} ms` };
    case "header": {
      const vals = resp.headers.filter(([k]) => k.toLowerCase() === c.name).map(([, v]) => v);
      if (!vals.length) return { text, ok: false, got: "not there" };
      const v = vals.join(", ");
      const ok = !c.op ? true : c.op === "==" ? v === c.value : v.toLowerCase().includes(c.value!.toLowerCase());
      return { text, ok, got: short(v) };
    }
    case "body":
      if (resp.binary) return { text, ok: false, got: "a binary body" };
      return { text, ok: resp.body.includes(c.value), got: resp.body.includes(c.value) ? "found" : resp.truncated ? "not in the part that was read" : "not found" };
    case "json": {
      if (resp.binary) return { text, ok: false, got: "a binary body" };
      if (resp.truncated) return { text, ok: false, got: "the body was cut off" };
      const p = parse(resp.body);
      if (!p.ok) return { text, ok: false, got: "the body isn't JSON" };
      const found = query(p.value, c.path, 50).matches;
      if (!found.length) return { text, ok: false, got: "no match" };
      if (!c.op) return { text, ok: true, got: short(found[0]!.value) };
      const v = found[0]!.value;
      const got = short(found.length > 1 ? found.map((m) => m.value) : v);
      switch (c.op) {
        case "==":
          return { text, ok: same(v, c.lit!), got };
        case "!=":
          return { text, ok: !same(v, c.lit!), got };
        case "contains": {
          const want = c.lit as string;
          const ok = typeof v === "string" ? v.includes(want) : Array.isArray(v) ? v.some((x) => same(x, literal(want)) || x === want) : false;
          return { text, ok, got };
        }
        default: {
          if (typeof v !== "number") return { text, ok: false, got: `${got} (not a number)` };
          const n = c.lit as number;
          const ok = c.op === "<" ? v < n : c.op === "<=" ? v <= n : c.op === ">" ? v > n : v >= n;
          return { text, ok, got };
        }
      }
    }
  }
}

/** A request's checks against its response: the default (below 400) when it has none. */
export function runChecks(checks: string[] | undefined, resp: Resp): Outcome[] {
  if (!checks?.length) return [{ text: "status below 400", ok: resp.status < 400, got: String(resp.status) }];
  return checks.map((t) => runCheck(t, resp));
}

/** `# @expect …` lines as written in the editor's Checks box: one per line, cut to size. */
export function checkLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:#|\/\/)?\s*@expect\s+/, "").trim().slice(0, MAX_CHECK))
    .filter(Boolean)
    .slice(0, MAX_CHECKS);
}
