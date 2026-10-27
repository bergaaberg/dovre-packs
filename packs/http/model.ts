/**
 * HTTP client (`http`): the request itself, without any I/O.
 *
 *  - A request (`Req`) is what the editor holds and what a `.http` file stores: method, URL, headers,
 *    query lines, a body (none / raw / JSON / form). `{{name}}` placeholders stay in it unresolved.
 *  - `.http` files are the VS Code REST Client / JetBrains HTTP Client format: requests separated by
 *    `###` lines (the rest of the line names it, as does `# @name x`), `@name = value` file variables.
 *  - `prepare()` resolves a request for sending in two steps. Plain variables (an environment, the
 *    file's own) first; then the URL's host is fixed, and only then are secrets put in, each only for
 *    the hosts HTTP_SECRETS binds it to. A host can never come from a secret, and a repo's file or
 *    environment can't send a secret anywhere it isn't bound to.
 *  - curl in (`fromCurl`) and out (`toCurl`): out, a secret stays a shell variable ("$API_TOKEN").
 */

import { checkLines, MAX_CHECK, MAX_CHECKS } from "./checks.ts";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];
export const MODES = ["none", "raw", "json", "form"] as const;
export type BodyMode = (typeof MODES)[number];

/** `expect`: the request's checks for a run (checks.ts), kept as `# @expect …` lines in its block. */
export type Req = { name: string; method: Method; url: string; headers: [string, string][]; query: string[]; mode: BodyMode; body: string; expect?: string[] };

/** Longest URL, header block, body and name the editor takes. */
export const MAX_URL = 8_000;
export const MAX_HEADERS = 16_000;
export const MAX_BODY_IN = 256_000;
export const MAX_NAME = 120;

export const blankReq = (): Req => ({ name: "", method: "GET", url: "", headers: [], query: [], mode: "none", body: "" });

const isMethod = (m: string): m is Method => (METHODS as readonly string[]).includes(m);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

/** "Name: value" lines into pairs; lines that aren't a header are dropped. */
export function headerLines(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!HEADER_NAME.test(k)) continue;
    out.push([k, line.slice(i + 1).trim()]);
  }
  return out;
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** The editor's form (strings) as a request; anything unknown falls back to the plain choice. */
export function reqOfForm(f: Record<string, unknown>): Req {
  const s = (k: string, max: number) => (typeof f[k] === "string" ? (f[k] as string).slice(0, max) : "");
  const method = s("method", 10).toUpperCase();
  const mode = s("mode", 10);
  return {
    name: s("name", MAX_NAME).replace(/[\r\n]/g, " ").trim(),
    method: isMethod(method) ? method : "GET",
    url: s("url", MAX_URL).replace(/[\r\n]/g, "").trim(),
    headers: headerLines(s("headers", MAX_HEADERS)),
    query: lines(s("query", MAX_URL)),
    mode: (MODES as readonly string[]).includes(mode) ? (mode as BodyMode) : "none",
    body: s("body", MAX_BODY_IN),
    ...(s("expect", MAX_CHECKS * (MAX_CHECK + 20)).trim() ? { expect: checkLines(s("expect", MAX_CHECKS * (MAX_CHECK + 20))) } : {}),
  };
}

export const headersText = (h: [string, string][]) => h.map(([k, v]) => `${k}: ${v}`).join("\n");

const hasHeader = (h: [string, string][], name: string) => h.some(([k]) => k.toLowerCase() === name);

/** The URL with its query lines on (each line as it goes on the wire: `key=value`, encoded by me). */
export function fullUrl(r: Pick<Req, "url" | "query">): string {
  if (!r.query.length) return r.url;
  const [base, hash] = r.url.split("#", 2) as [string, string | undefined];
  return `${base}${base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?"}${r.query.join("&")}${hash !== undefined ? `#${hash}` : ""}`;
}

/** Headers as sent: a JSON or form body gets its Content-Type when none was given. */
export function sentHeaders(r: Req): [string, string][] {
  const h = [...r.headers];
  if (r.mode === "json" && !hasHeader(h, "content-type")) h.push(["Content-Type", "application/json"]);
  if (r.mode === "form" && !hasHeader(h, "content-type")) h.push(["Content-Type", "application/x-www-form-urlencoded"]);
  return h;
}

/** The body as sent: form lines joined with `&` (as they go on the wire), nothing for none. */
export function sentBody(r: Req): string | undefined {
  if (r.mode === "none" || r.method === "GET" || r.method === "HEAD") return undefined;
  if (r.mode === "form") return lines(r.body).map((l) => l.replace(/^&/, "")).join("&");
  return r.body;
}

// ── .http files ──────────────────────────────────────────────────────────────────────────────

export type Parsed = {
  /** `@name = value` lines anywhere in the file. */
  vars: Record<string, string>;
  reqs: (Req & { /** Lines [start, end) of the file this request was read from. */ span: [number, number] })[];
};

const SEP = /^###/;
const VAR_LINE = /^@([A-Za-z_][\w.-]{0,63})\s*=\s*(.*)$/;
const COMMENT = /^(#|\/\/)/;
const NAME_COMMENT = /^(?:#|\/\/)\s*@name\s+(.+)$/;
const EXPECT_COMMENT = /^(?:#|\/\/)\s*@expect\s+(.+)$/;
const REQUEST_LINE = /^(?:([A-Z]+)\s+)?(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/;

function modeOf(headers: [string, string][], body: string): BodyMode {
  const ct = headers.find(([k]) => k.toLowerCase() === "content-type")?.[1].toLowerCase() ?? "";
  if (!body.trim()) return "none";
  if (ct.includes("json")) return "json";
  if (ct.includes("x-www-form-urlencoded")) return "form";
  return "raw";
}

/** Splits a URL's own query into query lines (left as written: nothing decoded). */
function splitQuery(url: string): Pick<Req, "url" | "query"> {
  const hashAt = url.indexOf("#");
  const at = url.indexOf("?");
  if (at < 0 || (hashAt >= 0 && hashAt < at)) return { url, query: [] };
  const end = hashAt >= 0 ? hashAt : url.length;
  return { url: url.slice(0, at) + url.slice(end), query: url.slice(at + 1, end).split("&").filter(Boolean) };
}

export function parseHttp(text: string): Parsed {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  const vars: Record<string, string> = {};
  const reqs: Parsed["reqs"] = [];
  // Segments: from each ### line to the next (the first from the top).
  const starts = [0, ...all.flatMap((l, i) => (i > 0 && SEP.test(l) ? [i] : []))];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : all.length;
    let name = SEP.test(all[from] ?? "") ? all[from]!.replace(SEP, "").trim() : "";
    let i = SEP.test(all[from] ?? "") ? from + 1 : from;
    let firstContent = -1;
    const expect: string[] = [];
    const expected = (l: string) => {
      const e = EXPECT_COMMENT.exec(l);
      if (e && expect.length < MAX_CHECKS) expect.push(e[1]!.trim().slice(0, MAX_CHECK));
      return !!e;
    };
    // Before the request line: blanks, comments (# @name), file variables.
    for (; i < to; i++) {
      const l = all[i]!.trim();
      if (!l) continue;
      const v = VAR_LINE.exec(l);
      if (v) {
        vars[v[1]!] = v[2]!.trim();
        continue;
      }
      if (firstContent < 0) firstContent = i;
      const n = NAME_COMMENT.exec(l);
      if (n) {
        name = n[1]!.trim();
        continue;
      }
      if (expected(l)) continue;
      if (COMMENT.test(l)) continue;
      break;
    }
    if (i >= to) continue;
    const m = REQUEST_LINE.exec(all[i]!.trim());
    if (!m || (m[1] && !isMethod(m[1]))) continue;
    let url = m[2]!;
    i++;
    // Query continuation lines (?a=1 / &b=2), then headers up to a blank line, then the body.
    for (; i < to && /^\s*[?&]/.test(all[i]!); i++) url += all[i]!.trim();
    const headers: [string, string][] = [];
    for (; i < to && all[i]!.trim(); i++) {
      const l = all[i]!.trim();
      if (expected(l) || COMMENT.test(l)) continue;
      headers.push(...headerLines(l));
    }
    const bodyLines = all.slice(i + 1, to);
    while (bodyLines.length && !bodyLines[bodyLines.length - 1]!.trim()) bodyLines.pop();
    const body = bodyLines.join("\n");
    const mode = modeOf(headers, body);
    reqs.push({
      name: name.slice(0, MAX_NAME),
      method: (m[1] as Method | undefined) ?? "GET",
      ...splitQuery(url),
      headers,
      mode,
      body: mode === "form" ? body.split(/\n|&/).map((x) => x.trim()).filter(Boolean).join("\n") : body,
      ...(expect.length ? { expect } : {}),
      span: [SEP.test(all[from] ?? "") ? from : Math.max(0, firstContent), to],
    });
  }
  return { vars, reqs };
}

/** One request as a `.http` block (from its `###` line). */
export function serializeReq(r: Req): string {
  const out = [`### ${r.name.replace(/[\r\n]/g, " ").trim()}`.trimEnd(), ...(r.expect ?? []).map((e) => `# @expect ${e.replace(/[\r\n]/g, " ").trim()}`), `${r.method} ${fullUrl(r)}`];
  for (const [k, v] of sentHeaders(r)) out.push(`${k}: ${v}`);
  const body = r.mode === "none" ? "" : r.mode === "form" ? lines(r.body).map((l, i) => (i ? `&${l.replace(/^&/, "")}` : l)).join("\n") : r.body.replace(/\s+$/, "");
  // A body line that starts with ### would end the request when it's read back.
  if (body) out.push("", body.replace(/^###/gm, " ###"));
  return out.join("\n") + "\n";
}

/**
 * The file with request `n` replaced by `r` (or `r` added at the end when `n` is undefined). The
 * file's variables inside the replaced lines are kept, above it.
 */
export function withReq(text: string, r: Req, n?: number): string | null {
  const block = serializeReq(r);
  if (n === undefined) {
    const t = text.replace(/\s+$/, "");
    return t ? `${t}\n\n${block}` : block;
  }
  const p = parseHttp(text);
  const at = p.reqs[n];
  if (!at) return null;
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  const kept = all.slice(at.span[0], at.span[1]).filter((l) => VAR_LINE.test(l.trim()));
  const tail = all.slice(at.span[1]);
  return [...all.slice(0, at.span[0]), ...kept, ...block.split("\n").slice(0, -1), ...(tail.length ? ["", ...tail] : [""])].join("\n").replace(/\n{3,}(?=###)/g, "\n\n");
}

// ── Variables and secrets ────────────────────────────────────────────────────────────────────

export type Secret = { name: string; hosts: string[]; value: string | undefined };

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** HTTP_SECRETS: `NAME@host` entries (comma or space separated), a name once per host it may go to. */
export function parseSecrets(spec: string | undefined, env: Record<string, string | undefined>): Secret[] {
  const by = new Map<string, Secret>();
  for (const part of (spec ?? "").split(/[\s,]+/).filter(Boolean)) {
    const at = part.indexOf("@");
    if (at <= 0) continue;
    const name = part.slice(0, at);
    const host = part.slice(at + 1).toLowerCase();
    if (!SECRET_NAME.test(name) || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(host) && !/^\[[0-9a-f:]+\](:\d{1,5})?$/.test(host)) continue;
    const s = by.get(name) ?? { name, hosts: [], value: env[name] || undefined };
    if (!s.hosts.includes(host)) s.hosts.push(host);
    by.set(name, s);
  }
  return [...by.values()];
}

/** A secret may go to a URL whose host (with its port) or hostname is one of its hosts. */
export const boundTo = (s: Secret, u: URL) => s.hosts.includes(u.host.toLowerCase()) || s.hosts.includes(u.hostname.toLowerCase());

export type Envs = Record<string, Record<string, string>>;

/** The JetBrains env file shape: `{ "dev": { "baseUrl": "…" }, "$shared": { … } }`; strings, numbers, booleans kept. */
export function parseEnvs(text: string | undefined): Envs {
  if (!text?.trim()) return {};
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return {};
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  const out: Envs = {};
  for (const [env, vars] of Object.entries(j as Record<string, unknown>).slice(0, 50)) {
    if (!/^[\w$.-]{1,64}$/.test(env) || !vars || typeof vars !== "object" || Array.isArray(vars)) continue;
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars as Record<string, unknown>).slice(0, 200))
      if (/^[A-Za-z_][\w.-]{0,63}$/.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) kept[k] = String(v).slice(0, 4000);
    out[env] = kept;
  }
  return out;
}

/** The environments' names, `$shared` aside. */
export const envNames = (...sets: Envs[]) => [...new Set(sets.flatMap((s) => Object.keys(s)).filter((n) => n !== "$shared"))].sort();

/** One environment's variables: each set's `$shared` and then the environment, later sets winning. */
export function varsOf(env: string, ...sets: Envs[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sets) Object.assign(out, s.$shared ?? {}, env && env !== "$shared" ? (s[env] ?? {}) : {});
  return out;
}

const PLACE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The `{{$…}}` values REST Client knows that need nothing from this machine. `$processEnv`, `$dotenv` are refused. */
function dynamic(expr: string, now: number): string | undefined {
  const [name, ...args] = expr.split(/\s+/);
  if (name === "$guid" || name === "$uuid" || name === "$random.uuid") return crypto.randomUUID();
  if (name === "$timestamp") return String(Math.floor(now / 1000));
  if (name === "$isoTimestamp") return new Date(now).toISOString();
  if (name === "$randomInt") {
    const lo = Number(args[0] ?? 0) || 0;
    const hi = Number(args[1] ?? 1000) || 1000;
    return String(lo + Math.floor(Math.random() * Math.max(1, hi - lo)));
  }
  return undefined;
}

/** Plain variables in (repeatedly, a few levels deep); secrets' placeholders stay; unknown names collected. */
function plain(s: string, vars: Record<string, string>, secretNames: Set<string>, missing: Set<string>, now: number, depth = 0): string {
  return s.replace(PLACE, (whole, inner: string) => {
    if (secretNames.has(inner)) return whole;
    if (inner.startsWith("$")) {
      const d = dynamic(inner, now);
      if (d === undefined) missing.add(inner.split(/\s+/)[0]!);
      return d ?? whole;
    }
    if (Object.hasOwn(vars, inner)) return depth < 5 ? plain(vars[inner]!, vars, secretNames, missing, now, depth + 1) : vars[inner]!;
    missing.add(inner);
    return whole;
  });
}

export type Prepared = {
  method: Method;
  url: string;
  headers: [string, string][];
  body?: string;
  /** The secrets it carries, by name. */
  secrets: string[];
};

export type PrepareResult = ({ ok: true } & Prepared) | { ok: false; error: string };

/** A request resolved for sending: variables, then the host, then the secrets bound to that host. */
export function prepare(r: Req, vars: Record<string, string>, secrets: Secret[], now = Date.now()): PrepareResult {
  const names = new Set(secrets.map((s) => s.name));
  const missing = new Set<string>();
  const url1 = plain(fullUrl(r), vars, names, missing, now).trim();
  const headers1 = sentHeaders(r).map(([k, v]) => [k, plain(v, vars, names, missing, now)] as [string, string]);
  const raw = sentBody(r);
  const body1 = raw === undefined ? undefined : plain(raw, vars, names, missing, now);
  if (missing.size) return { ok: false, error: `No value for ${[...missing].map((m) => `{{${m}}}`).join(", ")}: nothing was sent.` };
  const authority = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)/i.exec(url1);
  if (!authority) return { ok: false, error: "The URL must start with http:// or https://." };
  if (!/^https?:$/i.test(authority[1]!)) return { ok: false, error: "Only http:// and https:// URLs are sent." };
  if (authority[2]!.includes("{{")) return { ok: false, error: "A URL's host can't come from a secret: nothing was sent." };
  let target: URL;
  try {
    target = new URL(url1.replace(PLACE, "x"));
  } catch {
    return { ok: false, error: "That URL doesn't parse." };
  }
  // A secret's value written out (typed, pasted, in a variable) goes only where the secret may go.
  const written = [url1, ...headers1.map(([, v]) => v), body1 ?? ""].join("\n");
  const stray = secrets.find((x) => x.value && x.value.length >= 4 && written.includes(x.value) && !boundTo(x, target));
  if (stray) return { ok: false, error: `That has ${stray.name}'s value in it, which only goes to ${stray.hosts.join(", ")}, not ${target.host}: nothing was sent.` };
  const used = new Set<string>();
  let refused: string | undefined;
  const put = (s: string) =>
    s.replace(PLACE, (whole, inner: string) => {
      const sec = secrets.find((x) => x.name === inner);
      if (!sec) return whole;
      if (!sec.value) {
        refused ??= `${inner} isn't set on this machine: nothing was sent.`;
        return whole;
      }
      if (!boundTo(sec, target)) {
        refused ??= `${inner} only goes to ${sec.hosts.join(", ")}, not ${target.host}: nothing was sent.`;
        return whole;
      }
      used.add(inner);
      return sec.value;
    });
  const url = put(url1);
  const headers = headers1.map(([k, v]) => [k, put(v)] as [string, string]);
  const body = body1 === undefined ? undefined : put(body1);
  if (refused) return { ok: false, error: refused };
  let final: URL;
  try {
    final = new URL(url);
  } catch {
    return { ok: false, error: "That URL doesn't parse." };
  }
  if (final.host !== target.host) return { ok: false, error: "A URL's host can't come from a secret: nothing was sent." };
  for (const [, v] of headers) if (/[\r\n\0]/.test(v)) return { ok: false, error: "A header's value has a line break in it: nothing was sent." };
  if (r.mode === "json" && body !== undefined && body.trim()) {
    try {
      JSON.parse(body);
    } catch {
      return { ok: false, error: "The JSON body isn't valid JSON (after its variables are filled in): nothing was sent." };
    }
  }
  return { ok: true, method: r.method, url: final.href, headers, body, secrets: [...used] };
}

/** What a page or the actions log may show of a text: every secret's value (set ones, 4+ characters) as ••••. */
export function masker(secrets: Secret[]): (s: string) => string {
  const values = secrets.map((s) => s.value).filter((v): v is string => !!v && v.length >= 4).sort((a, b) => b.length - a.length);
  if (!values.length) return (s) => s;
  return (s) => {
    let out = s;
    for (const v of values) out = out.split(v).join("••••");
    for (const v of values) {
      const enc = encodeURIComponent(v);
      if (enc !== v) out = out.split(enc).join("••••");
    }
    return out;
  };
}

/** The secret whose value a text holds, if any (a request isn't saved with one in it). */
export const secretIn = (text: string, secrets: Secret[]) => secrets.find((s) => s.value && s.value.length >= 4 && text.includes(s.value));

/** Header values that are credentials whatever they hold: shown as •••• in a request's summary. */
export const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-auth-token"]);

// ── curl ─────────────────────────────────────────────────────────────────────────────────────

/** A shell command line into words: quotes, backslashes, line continuations, $'…'. No expansion. */
export function shellWords(s: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  const src = s.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
      continue;
    }
    has = true;
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += src.slice(i + 1, end);
      i = end + 1;
    } else if (c === "$" && src[i + 1] === "'") {
      i += 2;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === "\\" && i + 1 < src.length) {
          const e = src[i + 1]!;
          cur += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          i += 2;
        } else cur += src[i++];
      }
      if (i >= src.length) return null;
      i++;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1]!)) {
          cur += src[i + 1];
          i += 2;
        } else cur += src[i++];
      }
      if (i >= src.length) return null;
      i++;
    } else if (c === "\\" && i + 1 < src.length) {
      cur += src[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

export type CurlResult = { ok: true; req: Req; notes: string[] } | { ok: false; error: string };

/** A pasted curl command as a request. Nothing is sent or read: -F, @file and the like are noted and left out. */
export function fromCurl(text: string): CurlResult {
  const words = shellWords(text.trim().slice(0, MAX_BODY_IN));
  if (!words) return { ok: false, error: "A quote in that command isn't closed." };
  if (words[0] !== "curl") return { ok: false, error: "That doesn't start with curl." };
  const req = blankReq();
  const notes = new Set<string>();
  const data: string[] = [];
  let method: string | undefined;
  let get = false;
  let json = false;
  let url = "";
  const takes = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "-u", "--user", "--url", "-A", "--user-agent", "-b", "--cookie", "-e", "--referer", "-F", "--form", "-o", "--output", "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "--retry", "-w", "--write-out", "-T", "--upload-file"]);
  for (let i = 1; i < words.length; i++) {
    let w = words[i]!;
    let val: string | undefined;
    // --opt=value and -Xvalue forms.
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(w);
    if (eq && takes.has(eq[1]!)) [w, val] = [eq[1]!, eq[2]!];
    else if (/^-[XHdAbueFoxmTw]./s.test(w) && !w.startsWith("--")) [w, val] = [w.slice(0, 2), w.slice(2)];
    if (takes.has(w) && val === undefined) val = words[++i];
    if (takes.has(w) && val === undefined) return { ok: false, error: `${w} needs a value.` };
    switch (w) {
      case "-X":
      case "--request":
        method = val!.toUpperCase();
        break;
      case "-H":
      case "--header":
        req.headers.push(...headerLines(val!));
        break;
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        if (val!.startsWith("@") && w !== "--data-raw") notes.add(`${w} ${val} reads a file: left out.`);
        else data.push(w === "-d" || w === "--data" || w === "--data-ascii" ? val!.replace(/[\r\n]/g, "") : val!);
        break;
      case "--data-urlencode": {
        const at = val!.indexOf("=");
        data.push(at < 0 ? encodeURIComponent(val!) : `${val!.slice(0, at)}=${encodeURIComponent(val!.slice(at + 1))}`);
        break;
      }
      case "--json":
        json = true;
        data.push(val!);
        break;
      case "-u":
      case "--user":
        req.headers.push(["Authorization", `Basic ${Buffer.from(val!).toString("base64")}`]);
        break;
      case "--url":
        url = val!;
        break;
      case "-A":
      case "--user-agent":
        req.headers.push(["User-Agent", val!]);
        break;
      case "-b":
      case "--cookie":
        req.headers.push(["Cookie", val!]);
        break;
      case "-e":
      case "--referer":
        req.headers.push(["Referer", val!]);
        break;
      case "-G":
      case "--get":
        get = true;
        break;
      case "-I":
      case "--head":
        method = "HEAD";
        break;
      case "-F":
      case "--form":
      case "-T":
      case "--upload-file":
        notes.add(`${w} (multipart or file uploads) isn't supported yet: left out.`);
        break;
      default:
        if (takes.has(w)) break;
        if (w.startsWith("-")) break; // -s, -L, -k, --compressed, -v, -i: nothing to carry over.
        url ||= w;
    }
  }
  if (!url) return { ok: false, error: "There's no URL in that command." };
  if (get && data.length) {
    url += (url.includes("?") ? "&" : "?") + data.join("&");
    data.length = 0;
  }
  const m = (method ?? (data.length ? "POST" : "GET")).toUpperCase();
  if (!isMethod(m)) return { ok: false, error: `${m} isn't a method this client sends.` };
  req.method = m;
  Object.assign(req, splitQuery(url));
  if (data.length) {
    const body = data.join("&");
    if (json) {
      if (!hasHeader(req.headers, "content-type")) req.headers.push(["Content-Type", "application/json"]);
      if (!hasHeader(req.headers, "accept")) req.headers.push(["Accept", "application/json"]);
    }
    const ct = req.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1].toLowerCase();
    if (!ct) req.headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
    req.mode = modeOf(req.headers, body);
    req.body = req.mode === "form" ? body.split("&").filter(Boolean).join("\n") : body;
    if (req.mode === "json") {
      try {
        req.body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Kept as it was: it may hold {{placeholders}}.
      }
    }
  }
  return { ok: true, req, notes: [...notes] };
}

/** Replaces any secret's literal value in an imported request with its {{NAME}} (so it's never saved). */
export function placeholdSecrets(r: Req, secrets: Secret[]): Req {
  const vals = secrets.filter((s) => s.value && s.value.length >= 4).sort((a, b) => b.value!.length - a.value!.length);
  if (!vals.length) return r;
  const swap = (s: string) => vals.reduce((t, x) => t.split(x.value!).join(`{{${x.name}}}`), s);
  return { ...r, url: swap(r.url), query: r.query.map(swap), headers: r.headers.map(([k, v]) => [k, swap(v)]), body: swap(r.body) };
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The request as a curl command, plain variables filled in. A secret stays a shell variable
 * ("$API_TOKEN"), so the command is safe to paste anywhere; unknown names stay {{as written}}.
 */
export function toCurl(r: Req, vars: Record<string, string>, secrets: Secret[], now = Date.now()): string {
  const names = new Set(secrets.map((s) => s.name));
  const missing = new Set<string>();
  const quote = (s: string) => sq(plain(s, vars, names, missing, now)).replace(PLACE, (whole, inner: string) => (names.has(inner) ? `'"$${inner}"'` : whole)).replace(/^''(?=")|(?<=")''$/g, "");
  const parts = ["curl", quote(fullUrl(r))];
  if (r.method === "HEAD") parts.push("-I");
  else if (r.method !== "GET" && !(r.method === "POST" && sentBody(r))) parts.push("-X", r.method);
  for (const [k, v] of sentHeaders(r)) parts.push("-H", quote(`${k}: ${v}`));
  const body = sentBody(r);
  if (body !== undefined && body !== "") parts.push("--data-raw", quote(body));
  return parts.reduce((acc, p, i) => (i === 0 ? p : /^-/.test(p) ? `${acc} \\\n  ${p}` : `${acc} ${p}`), "");
}
