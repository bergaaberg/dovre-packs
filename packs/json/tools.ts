/**
 * JSON tools (`json`): pure functions over pasted text. Nothing here reads the network, the disk,
 * the clock (callers pass `now`) or a log: pasted text is someone's work data and stays in the request.
 */

/** Longest input any tool takes, in characters: a request bigger than this is refused, not cut. */
export const MAX_INPUT = 1_000_000;
/** Nodes the tree draws before it stops (the rest is summarised). */
export const MAX_NODES = 2000;
/** Differences or query matches listed before it stops. */
export const MAX_ROWS = 500;
/** Deepest nesting taken (the tree, sorting and diffing walk it). */
export const MAX_DEPTH = 512;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Parsed = { ok: true; value: Json } | { ok: false; error: string; line: number; column: number; pos: number };

/** Line and column (1-based) of an offset into text. */
export function lineCol(text: string, pos: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) (line++, (start = i + 1));
  return { line, column: pos - start + 1 };
}

/**
 * Finds where text stops being JSON (RFC 8259), and why: V8's JSON.parse often says neither.
 * Returns undefined when it is JSON. Iterative, so a deeply nested paste can't blow the stack.
 */
export function locateError(text: string): { pos: number; error: string } | undefined {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const show = (at: number) => (at >= n ? "end of input" : `'${text[at]}'`);
  const str = (): string | undefined => {
    i++; // opening quote
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) return void i++;
      if (c < 32) return "Control character in string (escape it, e.g. \\n)";
      if (c === 92) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return "Bad \\u escape: needs four hex digits";
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else return `Bad escape \\${e ?? ""}`;
      } else i++;
    }
    return "Unterminated string";
  };
  const num = (): string | undefined => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) return `Unexpected ${show(i)}`;
    i += m[0].length;
    return undefined;
  };
  // A stack of open containers: "{" expecting a key or "}", ":" after a key, "," after a value, etc.
  type Frame = { kind: "obj" | "arr"; state: "first" | "key" | "colon" | "value" | "after" };
  const stack: Frame[] = [];
  const value = (): string | undefined => {
    ws();
    const c = text[i];
    if ((c === "{" || c === "[") && stack.length >= MAX_DEPTH) return `Nested more than ${MAX_DEPTH} deep`;
    if (c === "{") return void (i++, stack.push({ kind: "obj", state: "first" }));
    if (c === "[") return void (i++, stack.push({ kind: "arr", state: "first" }));
    if (c === '"') return str();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return num();
    for (const w of ["true", "false", "null"]) if (text.startsWith(w, i)) return void (i += w.length);
    if (c === "'") return "Strings take double quotes";
    return `Unexpected ${show(i)}, expected a value`;
  };
  let err = value();
  while (!err && stack.length) {
    const top = stack[stack.length - 1]!;
    ws();
    const c = text[i];
    if (top.kind === "arr") {
      if (top.state === "first" && c === "]") (i++, stack.pop());
      else if (top.state === "first" || top.state === "value") (top.state = "after"), (err = value());
      else if (c === ",") {
        i++;
        ws();
        if (text[i] === "]") err = "Trailing comma before ']'";
        else top.state = "value";
      } else if (c === "]") (i++, stack.pop());
      else err = `Unexpected ${show(i)}, expected ',' or ']'`;
    } else {
      if ((top.state === "first" || top.state === "key") && c === '"') (err = str()), (top.state = "colon");
      else if (top.state === "first" && c === "}") (i++, stack.pop());
      else if (top.state === "first" || top.state === "key") err = top.state === "key" && c === "}" ? "Trailing comma before '}'" : c === "'" ? "Keys take double quotes" : `Unexpected ${show(i)}, expected a key in double quotes`;
      else if (top.state === "colon") {
        if (c === ":") (i++, (top.state = "after"), (err = value()));
        else err = `Unexpected ${show(i)}, expected ':'`;
      } else if (c === ",") (i++, (top.state = "key"));
      else if (c === "}") (i++, stack.pop());
      else err = `Unexpected ${show(i)}, expected ',' or '}'`;
    }
  }
  if (err) return { pos: i, error: err };
  ws();
  if (i < n) return { pos: i, error: `Unexpected ${show(i)} after the end of the document` };
  return undefined;
}

export function parse(text: string): Parsed {
  if (text.length > MAX_INPUT) return { ok: false, error: `Too long: ${text.length} characters (${MAX_INPUT} at most)`, line: 1, column: 1, pos: 0 };
  const where = locateError(text);
  if (!where) {
    try {
      return { ok: true, value: JSON.parse(text) as Json };
    } catch (e) {
      return { ok: false, error: String((e as Error).message).slice(0, 200), line: 1, column: 1, pos: 0 };
    }
  }
  return { ok: false, ...where, ...lineCol(text, where.pos) };
}

/** The error's line with a caret under its column, for showing (as text). */
export function excerpt(text: string, line: number, column: number): string {
  const l = text.split("\n")[line - 1] ?? "";
  const from = Math.max(0, column - 60);
  const cut = l.slice(from, from + 120);
  return `${cut}\n${" ".repeat(Math.max(0, column - 1 - from))}^`;
}

export const format = (v: Json, indent: number | string = 2) => JSON.stringify(v, null, indent);
export const minify = (v: Json) => JSON.stringify(v);

/** Same value, every object's keys sorted (for a stable, comparable form). */
export function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) Object.defineProperty(out, k, { value: sortKeys(v[k]!), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/** A JSONPath step for a key: `.name` when it's a plain identifier, `['odd key']` otherwise. */
export const keyStep = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `['${k.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`);
export const indexStep = (i: number) => `[${i}]`;

export type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";
export const kindOf = (v: Json): Kind => (v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as Kind));

// ── Query: a JSONPath subset ─────────────────────────────────────────────────

type Step =
  | { t: "key"; k: string }
  | { t: "index"; i: number }
  | { t: "slice"; a?: number; b?: number }
  | { t: "wild" }
  | { t: "deep"; k: string | null }
  | { t: "filter"; path: (string | number)[]; op?: string; lit?: Json };

export type Match = { path: string; value: Json };

/** Splits a JSONPath (the subset `$ .k ['k'] [n] [a:b] [*] .* ..k ..* [?(@.k op literal)]`) into steps. */
export function compile(q: string): Step[] {
  const s = q.trim();
  if (!s.startsWith("$")) throw new Error("A path starts with $");
  const steps: Step[] = [];
  let i = 1;
  const ident = () => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(s.slice(i));
    if (!m) throw new Error(`Expected a name at ${i + 1}`);
    i += m[0].length;
    return m[0];
  };
  const quoted = () => {
    const qc = s[i]!;
    let out = "";
    i++;
    while (i < s.length && s[i] !== qc) {
      if (s[i] === "\\" && i + 1 < s.length) i++;
      out += s[i++];
    }
    if (s[i] !== qc) throw new Error("Unterminated quoted key");
    i++;
    return out;
  };
  while (i < s.length) {
    if (s.startsWith("..", i)) {
      i += 2;
      if (s[i] === "*") (i++, steps.push({ t: "deep", k: null }));
      else if (s[i] === "[") {
        steps.push({ t: "deep", k: null });
      } else steps.push({ t: "deep", k: ident() });
    } else if (s[i] === ".") {
      i++;
      if (s[i] === "*") (i++, steps.push({ t: "wild" }));
      else steps.push({ t: "key", k: ident() });
    } else if (s[i] === "[") {
      i++;
      while (s[i] === " ") i++;
      if (s[i] === "*") (i++, steps.push({ t: "wild" }));
      else if (s[i] === "'" || s[i] === '"') steps.push({ t: "key", k: quoted() });
      else if (s[i] === "?") {
        const m = /^\?\(\s*@((?:\.[A-Za-z_$][A-Za-z0-9_$-]*|\[\d+\])*)\s*(?:(==|!=|<=|>=|<|>)\s*([^)]*?))?\s*\)/.exec(s.slice(i));
        if (!m) throw new Error("Filters look like [?(@.key == value)] or [?(@.key)]");
        i += m[0].length;
        const path = [...m[1]!.matchAll(/\.([^.[]+)|\[(\d+)\]/g)].map((p) => (p[2] !== undefined ? Number(p[2]) : p[1]!));
        let lit: Json | undefined;
        if (m[2]) {
          const raw = m[3]!.trim().replace(/^'(.*)'$/, (_x, b: string) => JSON.stringify(b));
          try {
            lit = JSON.parse(raw) as Json;
          } catch {
            throw new Error(`The filter's value ${raw.slice(0, 40)} isn't a JSON literal`);
          }
        }
        steps.push({ t: "filter", path, op: m[2], lit });
      } else {
        const m = /^(-?\d*)\s*(?::\s*(-?\d*))?/.exec(s.slice(i))!;
        if (!m[0]) throw new Error(`Unexpected '${s[i] ?? "end"}' in brackets`);
        i += m[0].length;
        if (m[2] !== undefined || m[0].includes(":")) steps.push({ t: "slice", a: m[1] ? Number(m[1]) : undefined, b: m[2] ? Number(m[2]) : undefined });
        else steps.push({ t: "index", i: Number(m[1]) });
      }
      while (s[i] === " ") i++;
      if (s[i] !== "]") throw new Error(`Expected ']' at ${i + 1}`);
      i++;
    } else throw new Error(`Unexpected '${s[i]}' at ${i + 1}`);
  }
  return steps;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function children(v: Json, p: string): Match[] {
  if (Array.isArray(v)) return v.map((x, i) => ({ path: p + indexStep(i), value: x }));
  if (v && typeof v === "object") return Object.keys(v).map((k) => ({ path: p + keyStep(k), value: v[k]! }));
  return [];
}

function descendants(m: Match, out: Match[], limit: number) {
  const stack = [m];
  while (stack.length && out.length < limit) {
    const x = stack.pop()!;
    out.push(x);
    stack.push(...children(x.value, x.path).reverse());
  }
}

function test(v: Json, f: Extract<Step, { t: "filter" }>): boolean {
  let x: Json | undefined = v;
  for (const p of f.path) {
    if (typeof p === "number") x = Array.isArray(x) ? x[p] : undefined;
    else x = x && typeof x === "object" && !Array.isArray(x) && own(x, p) ? x[p] : undefined;
  }
  if (!f.op) return x !== undefined;
  if (x === undefined) return false;
  const a = JSON.stringify(x), b = JSON.stringify(f.lit);
  if (f.op === "==") return a === b;
  if (f.op === "!=") return a !== b;
  if (typeof x !== typeof f.lit || (typeof x !== "number" && typeof x !== "string")) return false;
  const l = x as number | string, r = f.lit as number | string;
  return f.op === "<" ? l < r : f.op === "<=" ? l <= r : f.op === ">" ? l > r : l >= r;
}

/** Runs a JSONPath over a value: every match with its own path. Throws on a path it can't read. */
export function query(root: Json, q: string, limit = MAX_ROWS): { matches: Match[]; more: boolean } {
  const steps = compile(q);
  const cap = limit * 20;
  let cur: Match[] = [{ path: "$", value: root }];
  for (const st of steps) {
    const next: Match[] = [];
    for (const m of cur) {
      const v = m.value;
      if (st.t === "key") {
        if (v && typeof v === "object" && !Array.isArray(v) && own(v, st.k)) next.push({ path: m.path + keyStep(st.k), value: v[st.k]! });
      } else if (st.t === "index") {
        if (Array.isArray(v)) {
          const i = st.i < 0 ? v.length + st.i : st.i;
          if (i >= 0 && i < v.length) next.push({ path: m.path + indexStep(i), value: v[i]! });
        }
      } else if (st.t === "slice") {
        if (Array.isArray(v)) {
          const norm = (x: number | undefined, d: number) => (x === undefined ? d : x < 0 ? Math.max(0, v.length + x) : Math.min(v.length, x));
          for (let i = norm(st.a, 0); i < norm(st.b, v.length); i++) next.push({ path: m.path + indexStep(i), value: v[i]! });
        }
      } else if (st.t === "wild") next.push(...children(v, m.path));
      else if (st.t === "filter") next.push(...children(v, m.path).filter((c) => test(c.value, st)));
      else {
        const all: Match[] = [];
        descendants(m, all, cap);
        if (st.k === null) next.push(...all.slice(st === steps[steps.length - 1] ? 1 : 0));
        else for (const d of all) if (d.value && typeof d.value === "object" && !Array.isArray(d.value) && own(d.value, st.k)) next.push({ path: d.path + keyStep(st.k), value: d.value[st.k]! });
      }
      if (next.length > cap) break;
    }
    cur = next;
  }
  return { matches: cur.slice(0, limit), more: cur.length > limit };
}

// ── Diff: structural, key order ignored ──────────────────────────────────────

export type Change = { path: string; kind: "added" | "removed" | "changed"; before?: Json; after?: Json };

export function diff(a: Json, b: Json, limit = MAX_ROWS): { changes: Change[]; more: boolean } {
  const out: Change[] = [];
  type Task = { t: "cmp"; p: string; x: Json; y: Json } | Change;
  const stack: Task[] = [{ t: "cmp", p: "$", x: a, y: b }];
  while (stack.length) {
    const task = stack.pop()!;
    if (!("t" in task)) {
      if (out.length >= limit) return { changes: out, more: true };
      out.push(task);
      continue;
    }
    const { p, x, y } = task;
    const kx = kindOf(x), ky = kindOf(y);
    const todo: Task[] = [];
    if (kx !== ky) todo.push({ path: p, kind: "changed", before: x, after: y });
    else if (kx === "array") {
      const xa = x as Json[], ya = y as Json[];
      for (let i = 0; i < Math.max(xa.length, ya.length); i++) {
        const q = p + indexStep(i);
        if (i >= xa.length) todo.push({ path: q, kind: "added", after: ya[i]! });
        else if (i >= ya.length) todo.push({ path: q, kind: "removed", before: xa[i]! });
        else todo.push({ t: "cmp", p: q, x: xa[i]!, y: ya[i]! });
      }
    } else if (kx === "object") {
      const xo = x as Record<string, Json>, yo = y as Record<string, Json>;
      for (const k of [...new Set([...Object.keys(xo), ...Object.keys(yo)])].sort()) {
        const q = p + keyStep(k);
        if (!own(xo, k)) todo.push({ path: q, kind: "added", after: yo[k]! });
        else if (!own(yo, k)) todo.push({ path: q, kind: "removed", before: xo[k]! });
        else todo.push({ t: "cmp", p: q, x: xo[k]!, y: yo[k]! });
      }
    } else if (x !== y) todo.push({ path: p, kind: "changed", before: x, after: y });
    stack.push(...todo.reverse());
  }
  return { changes: out, more: false };
}

// ── Decoders ─────────────────────────────────────────────────────────────────

const dec = new TextDecoder("utf-8", { fatal: true });

/** Base64 or base64url to bytes; undefined when it isn't base64. */
export function b64Bytes(s: string): Uint8Array | undefined {
  const t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) return undefined;
  const padded = t.replace(/=+$/, "") + "===".slice((t.replace(/=+$/, "").length + 3) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function b64Encode(s: string, url = false): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const out = btoa(bin);
  return url ? out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : out;
}

export type Decoded = { ok: true; text: string; binary?: boolean } | { ok: false; error: string };

export function b64Decode(s: string): Decoded {
  const bytes = b64Bytes(s);
  if (!bytes) return { ok: false, error: "Not base64 (A–Z, a–z, 0–9, + / or - _, and = padding)" };
  try {
    return { ok: true, text: dec.decode(bytes) };
  } catch {
    const hex = [...bytes.slice(0, 4096)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return { ok: true, binary: true, text: hex + (bytes.length > 4096 ? " …" : "") };
  }
}

export function urlDecode(s: string): Decoded {
  try {
    return { ok: true, text: decodeURIComponent(s.replace(/\+/g, " ")) };
  } catch {
    return { ok: false, error: "Not valid percent-encoding (a % not followed by two hex digits, or bytes that aren't UTF-8)" };
  }
}
export const urlEncode = (s: string) => encodeURIComponent(s);

export type Jwt =
  | { ok: true; header: Json; payload: Json; signed: boolean; times: { claim: string; at: number; iso: string }[]; expired?: boolean; notYet?: boolean }
  | { ok: false; error: string };

/** Decodes a JWT's header and payload. It never verifies the signature: a decoded token proves nothing. */
export function jwtDecode(token: string, now: number): Jwt {
  const t = token.trim().replace(/^Bearer\s+/i, "");
  const parts = t.split(".");
  if (parts.length !== 3 && parts.length !== 5) return { ok: false, error: "A JWT has three parts separated by dots" };
  if (parts.length === 5) return { ok: false, error: "That's an encrypted JWT (JWE): its payload can't be read without the key" };
  const part = (p: string, what: string): Json => {
    const bytes = b64Bytes(p);
    if (!bytes) throw new Error(`The ${what} isn't base64url`);
    let text: string;
    try {
      text = dec.decode(bytes);
    } catch {
      throw new Error(`The ${what} isn't UTF-8 text`);
    }
    const r = parse(text);
    if (!r.ok) throw new Error(`The ${what} isn't JSON: ${r.error}`);
    return r.value;
  };
  try {
    const header = part(parts[0]!, "header");
    const payload = part(parts[1]!, "payload");
    const times: { claim: string; at: number; iso: string }[] = [];
    let expired: boolean | undefined, notYet: boolean | undefined;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const claim of ["iat", "nbf", "exp", "auth_time"]) {
        const v = payload[claim];
        if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e13) {
          times.push({ claim, at: v * 1000, iso: new Date(v * 1000).toISOString() });
          if (claim === "exp") expired = v * 1000 <= now;
          if (claim === "nbf") notYet = v * 1000 > now;
        }
      }
    }
    return { ok: true, header, payload, signed: parts[2]!.length > 0, times, expired, notYet };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type Epoch = { ok: true; ms: number; seconds: number; iso: string; unit: "s" | "ms" | "date" } | { ok: false; error: string };

/** A Unix time (seconds or milliseconds, guessed by size) or a date string, both ways. */
export function epoch(input: string): Epoch {
  const s = input.trim();
  if (!s) return { ok: false, error: "Give a Unix time or a date" };
  let ms: number;
  let unit: "s" | "ms" | "date";
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    unit = Math.abs(n) >= 1e11 ? "ms" : "s";
    ms = unit === "ms" ? n : n * 1000;
  } else {
    ms = Date.parse(s);
    unit = "date";
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return { ok: false, error: "Not a date I can read (try 2026-10-26T12:00:00Z or 1793016000)" };
  return { ok: true, ms, seconds: Math.floor(ms / 1000), iso: new Date(ms).toISOString(), unit };
}

/** "in 3 days", "5 minutes ago". */
export function relative(ms: number, now: number): string {
  const d = ms - now;
  const a = Math.abs(d);
  const units: [number, string][] = [[365 * 864e5, "year"], [30 * 864e5, "month"], [864e5, "day"], [36e5, "hour"], [6e4, "minute"], [1e3, "second"]];
  for (const [u, name] of units) {
    if (a >= u) {
      const n = Math.floor(a / u);
      const w = `${n} ${name}${n === 1 ? "" : "s"}`;
      return d > 0 ? `in ${w}` : `${w} ago`;
    }
  }
  return "now";
}
