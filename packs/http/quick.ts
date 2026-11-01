/**
 * HTTP client (`http`): the Quick view's model (dovre-packs#65, H-02). Pure: no files, no sends.
 *
 *  - Blanks: the `{{name}}` placeholders in a request that nothing fills in: not the environment, a
 *    secret, a `{{$guid}}`-style value or a response reference. The form asks only for those, and
 *    they go into the request as typed text before `prepare()`, which then does what it does for any
 *    typed text (the host check, secrets bound to their hosts).
 *  - The command line: `POST :3000/api/orders customer=cus_19 limit==20 X-Trace:1` (httpie's
 *    shorthand), a pasted curl command, or else a sentence for an agent.
 */
import { blankReq, fromCurl, METHODS, MAX_BODY_IN, MAX_URL, type Method, type Req, shellWords } from "./model.ts";

export type Blank = { name: string; where: "path" | "query" | "header" | "body" };

export const MAX_BLANKS = 30;
export const MAX_BLANK = 2_000;

const PLACE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const NAME = /^[A-Za-z_][\w.-]{0,63}$/;

/** The blanks in a request, in the order they're met, each once. `defined`: names the environment or a secret fills. */
export function blanksOf(r: Req, defined: (name: string) => boolean): Blank[] {
  const out: Blank[] = [];
  const add = (s: string, where: Blank["where"]) => {
    for (const m of s.matchAll(PLACE)) {
      const name = m[1]!;
      // `$guid` and friends, `login.response.body.x`, and anything that isn't a plain name aren't blanks.
      if (!NAME.test(name) || /\.response\./.test(name) || defined(name) || out.some((b) => b.name === name)) continue;
      if (out.length < MAX_BLANKS) out.push({ name, where });
    }
  };
  add(r.url.split(/[?#]/, 1)[0]!, "path");
  add(r.url.slice(r.url.split(/[?#]/, 1)[0]!.length), "query");
  for (const q of r.query) add(q, "query");
  for (const [, v] of r.headers) add(v, "header");
  add(r.body, "body");
  return out;
}

/** The blanks' values typed into the form (`blank.<name>` fields). */
export function blanksOfForm(f: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith("blank.") || typeof v !== "string") continue;
    const name = k.slice(6);
    if (NAME.test(name) && out.size < MAX_BLANKS) out.set(name, v.slice(0, MAX_BLANK));
  }
  return out;
}

/**
 * The request with its blanks' values in. An empty value leaves the placeholder (so `prepare()` says
 * what's missing). Refused: a value holding `{{`, `${` or a masked secret (it would be read again as
 * something else), or a line break outside the body.
 */
export function fillBlanks(r: Req, values: Map<string, string>): { ok: true; req: Req } | { ok: false; error: string } {
  let error: string | undefined;
  const put = (s: string, inBody = false) =>
    s.replace(PLACE, (whole, name: string) => {
      const v = values.get(name);
      if (v === undefined || v === "") return whole;
      if (v.includes("{{") || v.includes("${")) error ??= `${name} holds {{ or \${, so it isn't put in`;
      else if (v.includes("••••")) error ??= `${name} holds a masked secret, so it isn't put in`;
      else if (/\0/.test(v) || (!inBody && /[\r\n]/.test(v))) error ??= `${name} has a line break in it, so it isn't put in`;
      else return v;
      return whole;
    });
  const req: Req = { ...r, url: put(r.url), query: r.query.map((q) => put(q)), headers: r.headers.map(([k, v]) => [k, put(v)] as [string, string]), body: put(r.body, true) };
  return error ? { ok: false, error: `${error}: nothing was sent.` } : { ok: true, req };
}

export type Line = { t: "req"; req: Req; notes: string[] } | { t: "ask"; text: string } | { t: "error"; error: string };

const isMethod = (w: string): w is Method => (METHODS as readonly string[]).includes(w.toUpperCase());

/** A URL as typed on the line: `:3000/x` is localhost, `/x` goes after `{{baseUrl}}`, a bare host gets a scheme. */
function lineUrl(u: string): string | undefined {
  if (/^https?:\/\//i.test(u) || /^\{\{/.test(u)) return u;
  if (/^:\d{1,5}(\/|$)/.test(u)) return `http://localhost${u}`;
  if (u.startsWith("/")) return `{{baseUrl}}${u}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/|$)/i.test(u)) return `http://${u}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?(\/|$)/i.test(u)) return `https://${u}`;
  return undefined;
}

/** What the command line holds: a request (nothing sent), or a sentence for an agent. */
export function parseLine(text: string): Line {
  const t = text.trim().slice(0, MAX_BODY_IN);
  if (!t) return { t: "error", error: "Type a request (GET /api/orders), paste a curl command, or ask for one in a sentence." };
  if (/^curl\s/.test(t)) {
    const c = fromCurl(t);
    return c.ok ? { t: "req", req: c.req, notes: c.notes } : { t: "error", error: c.error };
  }
  const words = shellWords(t);
  const first = words?.[0] ?? "";
  const startsReq = words && (lineUrl(first) !== undefined || (isMethod(first) && words.length > 1 && lineUrl(words[1]!) !== undefined));
  if (!words || !startsReq) return { t: "ask", text: t.replace(/[\r\n]+/g, " ").slice(0, 2_000) };

  const req = blankReq();
  let i = 0;
  let method: Method | undefined;
  if (isMethod(first)) {
    method = first.toUpperCase() as Method;
    i++;
  }
  req.url = lineUrl(words[i++]!)!.slice(0, MAX_URL);
  if (/[\r\n]/.test(req.url)) return { t: "error", error: "The URL has a line break in it." };
  const fields: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const w of words.slice(i, i + 100)) {
    // The first of `:` and `=` decides: `a==b` query, `a:=1` raw JSON, `a=b` a JSON field, `A:b` a header.
    const at = w.search(/[:=]/);
    if (at <= 0) {
      notes.push(`${w.slice(0, 40)} isn't name=value, name==value, name:=json or Header:value, so it's left out.`);
      continue;
    }
    const name = w.slice(0, at);
    const rest = w.slice(at);
    if (rest.startsWith("==")) req.query.push(`${encodeURIComponent(name)}=${encodeURIComponent(rest.slice(2))}`);
    else if (rest.startsWith(":=")) {
      try {
        fields[name] = JSON.parse(rest.slice(2));
      } catch {
        return { t: "error", error: `${name}:= takes JSON, and ${rest.slice(2, 40)} isn't.` };
      }
    } else if (rest.startsWith("=")) fields[name] = rest.slice(1);
    else if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name) && !/[\r\n]/.test(rest)) req.headers.push([name, rest.slice(1).trim()]);
    else notes.push(`${name.slice(0, 40)} isn't a header name, so it's left out.`);
  }
  if (Object.keys(fields).length) {
    req.mode = "json";
    req.body = JSON.stringify(fields, null, 2);
  }
  req.method = method ?? (req.body ? "POST" : "GET");
  return { t: "req", req, notes };
}

/** The prompt for a sentence on the command line: draft the request (or a case), never send it. */
export function askPrompt(text: string, o: { repo: string; env: string; endpoint?: string }): string {
  return [
    `Draft an HTTP request for this, in ${o.repo ? `the ${o.repo} repo's` : "a repo's"} \`.http/\` folder: ${text}`,
    "",
    `Find the endpoint in the code or its OpenAPI spec${o.endpoint ? ` (I was looking at ${o.endpoint})` : ""}. Write it as a named request (\`### name\`) in the .http file for that part of the API, with \`{{baseUrl}}\` for the server and \`{{NAME}}\` for any secret (never a value). Add \`# @expect\` lines for what a good answer looks like (status 2xx, json $.id exists).`,
    "",
    `Don't send anything that changes data: I'll open it in Dovre's HTTP client${o.env ? ` (environment ${o.env})` : ""} and send it myself.`,
  ].join("\n");
}
