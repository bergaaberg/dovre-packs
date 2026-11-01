/**
 * HTTP client (`http`): stories, chains of requests that carry values from one step to the next
 * (dovre-packs#65). A story is `.http/stories/<name>.story`; a setup (what a story's `given` names)
 * is `.http/setups/<name>.story`, in the same format:
 *
 *   # A customer orders, cancels and gets the money back      ← the title, then more # lines: about
 *   given: fresh db, one customer                              ← setups, run first, in this order
 *   only: local, test                                          ← the environments it may run in
 *
 *   step: The customer orders two cinnamon buns
 *     case: orders.http#Happy path                             ← a request saved in .http/orders.http
 *     take: order.id = $.id, order.total = $.total
 *
 *   step: They cancel it
 *     POST {{baseUrl}}/api/orders/${order.id}/cancel           ← or a request written here,
 *     Content-Type: application/json                           ←   its headers right below it,
 *     body: {"reason": "changed my mind"}                      ←   and a body: one line, or lines indented further
 *     expect: json $.status == cancelled                       ← checks.ts checks; `$…` alone means `json $…`
 *
 *   step: Wait until the refund is paid
 *     GET {{baseUrl}}/api/refunds?order=${order.id}
 *     until: $[0].status == paid  every 500ms  max 10s         ← sent again until the check passes
 *     take: refund.amount = $[0].amount
 *
 *   check: refund.amount == order.total                        ← taken values (a bare word that isn't one is text)
 *
 *   always: Remove the customer                                ← runs last, whatever happened
 *     DELETE {{baseUrl}}/api/customers/${customer.id}
 *
 * `expect: 2xx` is `expect: status 2xx`. A take reads the response: `$…` (a JSONPath on the body), `header <name>`, or `status`. `${name}`
 * puts a taken value into a later request, never into its host, and never one holding `{{`, `${`, a
 * line break or a masked secret (the rest is prepare()'s job, as for typed text). Inside a step, a
 * line starting with case:, expect:, take:, until: or body: is that, so a header of one of those
 * names can't be written inline (save it as a case). Comments inside steps are dropped on save.
 *
 * Parsing is pure and tolerant: each line it can't read is reported with its number, and a story
 * with errors isn't run.
 */
import { parseCheck, type Outcome } from "./checks.ts";
import { resolveRef } from "./chain.ts";
import { FILE_RE, readStoryFile } from "./files.ts";
import { MAX_BODY_IN, MAX_GIVEN, MAX_NAME, METHODS, type Req, givenList, parseHttp, serializeReq } from "./model.ts";
import type { Resp } from "./send.ts";

export const MAX_STORY = 64_000;
/** Most steps a story (or a story with its setups, planned) has, `always` ones included. */
export const MAX_STEPS = 50;
export const MAX_TAKES = 20;
export const UNTIL_EVERY = { min: 100, max: 60_000, fallback: 500 };
export const UNTIL_MAX = { max: 300_000, fallback: 10_000 };

export type CaseRef = { file: string; name: string };
/** `order.id = $.id`: what a later step calls it, and where in the response it's read. */
export type Take = { name: string; from: string };
export type Until = { check: string; everyMs: number; maxMs: number };
export type Send = { title: string; ask: { t: "case"; ref: CaseRef } | { t: "req"; req: Req }; expect: string[]; take: Take[]; until?: Until };
export type Step = ({ t: "send" } & Send) | { t: "check"; text: string };
export type Story = { title: string; about: string[]; given: string[]; only: string[]; steps: Step[]; always: Send[] };
export type StoryError = { line: number; message: string };
export type StoryParse = { story: Story; errors: StoryError[] };

const VALUE_NAME = /^[A-Za-z_]\w{0,63}(?:\.[A-Za-z_]\w{0,63}){0,4}$/;
const ENV_NAME = /^[\w$.-]{1,64}$/;
const VALUE_REF = /\$\{\s*([^{}]*?)\s*\}/g;
const KEYWORD = /^(case|expect|take|until|body):(?:\s+(.*))?$/;
const TOP = /^(given|only|step|check|always):(?:\s+(.*))?$/;
const REQUEST_LINE = new RegExp(`^(${METHODS.join("|")})\\s+\\S`);
const CHECK_OPS = ["==", "!=", "<=", ">=", "<", ">", "contains"] as const;

export const emptyStory = (): Story => ({ title: "", about: [], given: [], only: [], steps: [], always: [] });

/** A setup's file name (without `.story`) from the name a `given` uses: `fresh db` → `fresh-db`. */
export const setupFile = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** Shorthand: `$[0].status == paid` is `json $[0].status == paid`, and `2xx` is `status 2xx`. */
const fullCheck = (s: string) => (s.startsWith("$") ? `json ${s}` : /^[1-5](\d\d|xx)(\s+[1-5](\d\d|xx))*$/i.test(s) ? `status ${s}` : s);

const isJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};
const duration = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
const one = (s: string, max: number) => s.replace(/[\r\n]/g, " ").trim().slice(0, max);

/** A take's source: `$…`, `header <name>` or `status`; undefined when it's none of those. */
function takeSource(s: string): string | undefined {
  const t = s.trim();
  if (t === "status") return t;
  if (/^\$/.test(t) && t.length <= 300) return t;
  const h = /^header\s+([!#$%&'*+.^_`|~0-9A-Za-z-]{1,100})$/i.exec(t);
  return h ? `header ${h[1]}` : undefined;
}

/** `a = $.x, b = header Location`: split before each `name =`, so a JSONPath may hold commas. */
function parseTakes(s: string): Take[] | string {
  const out: Take[] = [];
  for (const part of s.split(/,\s*(?=[A-Za-z_][\w.]*\s*=)/)) {
    const m = /^\s*([^=\s]+)\s*=\s*(.+?)\s*$/.exec(part);
    if (!m || !VALUE_NAME.test(m[1]!)) return `"${one(part, 60)}" isn't a take: write name = $.path, name = header Location or name = status`;
    const from = takeSource(m[2]!);
    if (!from) return `${m[1]} = ${one(m[2]!, 60)}: a take reads $.path, header <name> or status`;
    out.push({ name: m[1]!, from });
  }
  return out;
}

const DURATION = /^(\d{1,6})\s*(ms|s)$/;
const ms = (m: RegExpExecArray) => Number(m[1]) * (m[2] === "s" ? 1000 : 1);

/** `$[0].status == paid  every 500ms  max 10s` (every and max optional, either order). */
function parseUntil(s: string): Until | string {
  let rest = s.trim();
  let every: number | undefined;
  let max: number | undefined;
  for (let i = 0; i < 2; i++) {
    const m = /\s+(every|max)\s+(\d{1,6}\s*(?:ms|s))$/.exec(rest);
    if (!m) break;
    const d = ms(DURATION.exec(m[2]!)!);
    if (m[1] === "every") every ??= d;
    else max ??= d;
    rest = rest.slice(0, m.index).trim();
  }
  const check = fullCheck(rest);
  const c = parseCheck(check);
  if ("error" in c) return `until: ${c.error}`;
  const everyMs = every ?? UNTIL_EVERY.fallback;
  const maxMs = max ?? UNTIL_MAX.fallback;
  if (everyMs < UNTIL_EVERY.min || everyMs > UNTIL_EVERY.max) return `until: every takes ${UNTIL_EVERY.min}ms to ${UNTIL_EVERY.max / 1000}s`;
  if (maxMs > UNTIL_MAX.max || maxMs < everyMs) return `until: max takes from the every interval up to ${UNTIL_MAX.max / 1000}s`;
  return { check, everyMs, maxMs };
}

/** A `check:` on taken values: `a == b`, `a contains b`… Returns why not, or undefined when it reads. */
function checkError(s: string): string | undefined {
  const m = splitValueCheck(s);
  if (!m) return `check: write a value, then ${CHECK_OPS.join(", ")}, then a value or text (refund.amount == order.total)`;
  if (!VALUE_NAME.test(m.left)) return `check: ${one(m.left, 60)} isn't a value name`;
  return undefined;
}

function splitValueCheck(s: string): { left: string; op: (typeof CHECK_OPS)[number]; right: string } | undefined {
  const m = /^(\S+)\s+(==|!=|<=|>=|<|>|contains)\s+(.+)$/.exec(s.trim());
  return m ? { left: m[1]!, op: m[2] as (typeof CHECK_OPS)[number], right: m[3]!.trim() } : undefined;
}

/** `${…}` in a request that a step writes: names only, and none in the URL's host. */
function refsError(req: Req): string | undefined {
  const all = [req.url, ...req.query, ...req.headers.flatMap(([k, v]) => [k, v]), req.body].join("\n");
  for (const m of all.matchAll(VALUE_REF)) if (!VALUE_NAME.test(m[1]!)) return `\${${one(m[1]!, 60)}} isn't a value name`;
  if (req.headers.some(([k]) => k.includes("${"))) return "A header's name can't come from a value";
  if (hostHasRef(req.url)) return "A URL's host can't come from a value";
  return undefined;
}

/** True when `${` is before the path starts: in the scheme or the host (or the URL starts with one). */
function hostHasRef(url: string): boolean {
  const u = url.trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(u);
  if (m) return m[1]!.includes("${") || u.slice(0, u.indexOf("//")).includes("${");
  // No scheme yet (it comes from {{baseUrl}}, say): a value before the first path slash could be the host.
  const head = u.replace(/^\{\{[^{}]*\}\}/, "");
  return head === u ? u.split(/[/?#]/, 1)[0]!.includes("${") : head.split(/[/?#]/, 1)[0]!.includes("${");
}

type Block = { line: number; text: string; indent: number }[];

/** One step's lines (indented under its `step:`/`always:`) into a Send, adding errors. */
function parseSend(title: string, at: number, body: Block, errors: StoryError[]): Send | undefined {
  const err = (line: number, message: string) => void errors.push({ line, message });
  let ref: CaseRef | undefined;
  let reqLines: string[] | undefined;
  let reqLine = at;
  let bodyText: string | undefined;
  let headersOpen = false;
  const expect: string[] = [];
  const take: Take[] = [];
  let until: Until | undefined;
  for (let i = 0; i < body.length; i++) {
    const { line, text, indent } = body[i]!;
    const t = text.trim();
    if (!t || t.startsWith("#")) continue;
    const k = KEYWORD.exec(t);
    if (!k) {
      if (REQUEST_LINE.test(t)) {
        if (reqLines || ref) err(line, "A step sends one request: this one has a second");
        else {
          reqLines = [t];
          reqLine = line;
          headersOpen = true;
        }
        continue;
      }
      if (headersOpen && reqLines && (/^[?&]/.test(t) || /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}:/.test(t))) {
        reqLines.push(t);
        continue;
      }
      err(line, `"${one(t, 60)}" isn't something a step has: case:, a request (GET …), expect:, take:, until: or body:`);
      continue;
    }
    headersOpen = false;
    const [, key, v = ""] = k as unknown as [string, string, string | undefined];
    if (key === "case") {
      const m = /^([^#]+)#(.+)$/.exec(v.trim());
      if (!m || !FILE_RE.test(m[1]!.trim())) err(line, "case: write file.http#Request name (a file in .http/)");
      else if (ref || reqLines) err(line, "A step sends one request: this one has a second");
      else ref = { file: m[1]!.trim(), name: one(m[2]!, MAX_NAME) };
    } else if (key === "expect") {
      const c = parseCheck(fullCheck(v.trim()));
      if ("error" in c) err(line, `expect: ${c.error}`);
      else expect.push(fullCheck(v.trim()));
    } else if (key === "take") {
      const got = parseTakes(v);
      if (typeof got === "string") err(line, got);
      else if (take.length + got.length > MAX_TAKES) err(line, `A step takes at most ${MAX_TAKES} values`);
      else take.push(...got);
    } else if (key === "until") {
      const got = parseUntil(v);
      if (typeof got === "string") err(line, got);
      else if (until) err(line, "A step has one until:");
      else until = got;
    } else {
      if (bodyText !== undefined) err(line, "A step has one body:");
      if (v.trim()) bodyText = v.trim();
      else {
        // The lines indented further than `body:` (blank ones inside it kept).
        const kept: string[] = [];
        let j = i + 1;
        for (; j < body.length && (!body[j]!.text.trim() || body[j]!.indent > indent); j++) kept.push(body[j]!.text);
        while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
        const cut = Math.min(...kept.filter((l) => l.trim()).map(indentOf));
        bodyText = kept.map((l) => l.slice(Number.isFinite(cut) ? cut : 0)).join("\n");
        i = j - 1;
      }
      if (bodyText !== undefined && bodyText.length > MAX_BODY_IN) err(line, `The body is larger than ${MAX_BODY_IN / 1000} kB`);
    }
  }
  if (!ref && !reqLines) {
    err(at, "A step needs a request: case: file.http#Name, or one written here (GET {{baseUrl}}/…)");
    return undefined;
  }
  if (ref) {
    if (bodyText !== undefined) err(at, "A case brings its own body: write the request here instead to change it");
    return { title, ask: { t: "case", ref }, expect, take, ...(until ? { until } : {}) };
  }
  // The written request as a .http block, so it reads the way a saved one does.
  const block = [...reqLines!, ...(bodyText !== undefined ? ["", bodyText.replace(/^###/gm, " ###")] : [])].join("\n");
  const parsed = parseHttp(block).reqs[0];
  if (!parsed) {
    err(reqLine, "That request can't be read");
    return undefined;
  }
  const req: Req = { name: one(title, MAX_NAME), method: parsed.method, url: parsed.url, headers: parsed.headers, query: parsed.query, mode: parsed.mode, body: parsed.body };
  // A JSON body written here without a Content-Type is sent as JSON (the header goes in, so it reads back the same).
  if (req.mode === "raw" && !req.headers.some(([k]) => k.toLowerCase() === "content-type") && /^\s*[[{]/.test(req.body) && isJson(req.body)) {
    req.headers = [...req.headers, ["Content-Type", "application/json"]];
    req.mode = "json";
  }
  const bad = refsError(req);
  if (bad) err(reqLine, bad);
  return { title, ask: { t: "req", req }, expect, take, ...(until ? { until } : {}) };
}

export function parseStory(input: string): StoryParse {
  const errors: StoryError[] = [];
  const story = emptyStory();
  if (input.length > MAX_STORY) return { story, errors: [{ line: 1, message: `A story is at most ${MAX_STORY / 1000} kB` }] };
  const all = input.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  let i = 0;
  // The header: # lines before anything else (blank lines between them allowed).
  for (; i < all.length; i++) {
    const t = all[i]!.trim();
    if (!t) continue;
    if (!t.startsWith("#")) break;
    const text = one(t.replace(/^#+\s?/, ""), 200);
    if (!story.title) story.title = text;
    else if (story.about.length < 20) story.about.push(text);
  }
  const steps = () => story.steps.length + story.always.length;
  for (; i < all.length; ) {
    const raw = all[i]!;
    const t = raw.trim();
    const line = i + 1;
    i++;
    if (!t || t.startsWith("#")) continue;
    if (indentOf(raw) > 0) {
      errors.push({ line, message: "This line is indented but isn't under a step: or always:" });
      continue;
    }
    const m = TOP.exec(t);
    if (!m) {
      errors.push({ line, message: `"${one(t, 60)}" isn't part of a story: given:, only:, step:, check: or always:` });
      continue;
    }
    const [, key, v = ""] = m as unknown as [string, string, string | undefined];
    if (key === "given") {
      story.given = givenList([...story.given, v].join(","));
      if (givenList(v).some((g) => !setupFile(g))) errors.push({ line, message: "given: a setup's name needs a letter or digit" });
    } else if (key === "only") {
      for (const e of v.split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!ENV_NAME.test(e)) errors.push({ line, message: `only: ${one(e, 60)} isn't an environment name` });
        else if (!story.only.includes(e) && story.only.length < 20) story.only.push(e);
      }
    } else if (key === "check") {
      const bad = checkError(v);
      if (bad) errors.push({ line, message: bad });
      else story.steps.push({ t: "check", text: v.trim() });
    } else {
      const body: Block = [];
      for (; i < all.length && (!all[i]!.trim() || indentOf(all[i]!) > 0); i++) body.push({ line: i + 1, text: all[i]!, indent: indentOf(all[i]!) });
      const send = parseSend(one(v, MAX_NAME), line, body, errors);
      if (!send) continue;
      if (steps() >= MAX_STEPS) errors.push({ line, message: `A story has at most ${MAX_STEPS} steps` });
      else if (key === "always") story.always.push(send);
      else {
        if (story.always.length) errors.push({ line, message: "Steps go before the always: ones" });
        story.steps.push({ t: "send", ...send });
      }
    }
  }
  if (!story.steps.length && !story.always.length && !errors.length) errors.push({ line: 1, message: "The story has no steps" });
  if (story.given.length > MAX_GIVEN) errors.push({ line: 1, message: `A story names at most ${MAX_GIVEN} setups` });
  return { story, errors };
}

const indent = (s: string, by = "  ") => s.split("\n").map((l) => (l ? by + l : l)).join("\n");

function serializeSend(key: "step" | "always", s: Send): string {
  const out = [`${key}: ${one(s.title, MAX_NAME)}`.trimEnd()];
  if (s.ask.t === "case") out.push(`  case: ${s.ask.ref.file}#${one(s.ask.ref.name, MAX_NAME)}`);
  else {
    // serializeReq's block without its ### line; the body goes under body:.
    const block = serializeReq({ ...s.ask.req, name: "", expect: undefined, given: undefined }).replace(/\n$/, "").split("\n").slice(1);
    const blank = block.indexOf("");
    const head = blank < 0 ? block : block.slice(0, blank);
    out.push(...head.map((l) => `  ${l}`));
    if (blank >= 0) {
      const body = block.slice(blank + 1).join("\n");
      out.push(!body.includes("\n") && body.trim() === body ? `  body: ${body}` : `  body:\n${indent(body, "    ")}`);
    }
  }
  for (const e of s.expect) out.push(`  expect: ${one(e, 300)}`);
  if (s.take.length) out.push(`  take: ${s.take.map((t) => `${t.name} = ${t.from}`).join(", ")}`);
  if (s.until) out.push(`  until: ${one(s.until.check, 300)}  every ${duration(s.until.everyMs)}  max ${duration(s.until.maxMs)}`);
  return out.join("\n");
}

/** A story as its file. Reading it back gives the same story (comments inside steps aside). */
export function serializeStory(s: Story): string {
  const parts: string[] = [];
  const head = [s.title, ...s.about].filter(Boolean).map((l) => `# ${one(l, 200)}`);
  const keys = [...(s.given.length ? [`given: ${givenList(s.given.join(",")).join(", ")}`] : []), ...(s.only.length ? [`only: ${s.only.join(", ")}`] : [])];
  if (head.length || keys.length) parts.push([...head, ...keys].join("\n"));
  for (const st of s.steps) parts.push(st.t === "check" ? `check: ${one(st.text, 300)}` : serializeSend("step", st));
  for (const a of s.always) parts.push(serializeSend("always", a));
  return parts.join("\n\n") + "\n";
}

// ── Running: values in and out ─────────────────────────────────────────────────────────────────

export type Values = Map<string, string>;

/** A value read from a response by a take's source (secrets in it are masked already). */
export function takeValue(from: string, resp: Resp): { value: string } | { error: string } {
  if (from === "status") return { value: String(resp.status) };
  const inner = from.startsWith("header ") ? `it.response.headers.${from.slice(7)}` : `it.response.body.${from}`;
  const got = resolveRef(inner, (n) => (n === "it" ? resp : undefined));
  if (!got || "later" in got) return { error: `${from} can't be read` };
  if ("error" in got) return { error: got.error.replace(/^it's response/, "The response") };
  if (got.value.includes("${")) return { error: "The response has ${ there, so it isn't reused" };
  return got;
}

/** The request with its `${name}` values in. Refused: an unknown name, or a value that could change what the request is. */
export function fillValues(req: Req, values: Values): { ok: true; req: Req } | { ok: false; error: string } {
  const bad = refsError(req);
  if (bad) return { ok: false, error: `${bad}: nothing was sent.` };
  let error: string | undefined;
  const put = (s: string, inBody = false) =>
    s.replace(VALUE_REF, (whole, name: string) => {
      const v = values.get(name);
      if (v === undefined) error ??= `No value ${name} yet: a step above takes it, or a setup does`;
      else if (v.includes("{{") || v.includes("${")) error ??= `${name} holds {{ or \${, so it isn't put in`;
      else if (v.includes("••••")) error ??= `${name} holds a masked secret, so it isn't put in`;
      else if (!inBody && /[\r\n\0]/.test(v)) error ??= `${name} has a line break in it, so it isn't put in`;
      else return v;
      return whole;
    });
  const out: Req = { ...req, url: put(req.url), query: req.query.map((q) => put(q)), headers: req.headers.map(([k, v]) => [k, put(v)] as [string, string]), body: put(req.body, true) };
  return error ? { ok: false, error: `${error}: nothing was sent.` } : { ok: true, req: out };
}

/** A `check:` step against the values taken so far. */
export function runValueCheck(text: string, values: Values): Outcome {
  const m = splitValueCheck(text);
  if (!m) return { text, ok: false, got: "can't be read" };
  const left = values.get(m.left);
  if (left === undefined) return { text, ok: false, got: `no value ${m.left}` };
  const right = /^"(.*)"$/.test(m.right) ? m.right.slice(1, -1) : (values.get(m.right) ?? m.right);
  const a = Number(left);
  const b = Number(right);
  const nums = left.trim() !== "" && right.trim() !== "" && Number.isFinite(a) && Number.isFinite(b);
  const ok = (() => {
    switch (m.op) {
      case "==":
        return nums ? a === b : left === right;
      case "!=":
        return nums ? a !== b : left !== right;
      case "contains":
        return left.includes(right);
      default:
        if (!nums) return false;
        return m.op === "<" ? a < b : m.op === "<=" ? a <= b : m.op === ">" ? a > b : a >= b;
    }
  })();
  return { text, ok, got: `${one(left, 80)} ${m.op} ${one(right, 80)}` };
}

// ── Planning: a story with its setups ──────────────────────────────────────────────────────────

/** A setup by its given name: the story, or why it can't be had (missing, has errors). */
export type LoadSetup = (name: string) => Story | { error: string };
/** `stepFrom`/`alwaysFrom`: the setup each step comes from, by index ("" for the story's own). */
export type Plan = { steps: Step[]; always: Send[]; setups: string[]; stepFrom: string[]; alwaysFrom: string[] };

/**
 * The steps a run takes in `env`: each setup's own setups first, each setup once, then the story.
 * `always` steps run the story's first, then its setups' in reverse (teardown unwinds). Refused: a
 * setup that's missing, names itself (round about), is pinned (`only:`) to other environments, or
 * a plan longer than MAX_STEPS.
 */
export function planStory(story: Story, env: string, load: LoadSetup): { ok: true; plan: Plan } | { ok: false; error: string } {
  if (story.only.length && !story.only.includes(env)) return { ok: false, error: `This story only runs in ${story.only.join(", ")}, not ${env || "no environment"}` };
  const done = new Set<string>();
  const order: { name: string; s: Story }[] = [];
  const visit = (name: string, path: string[]): string | undefined => {
    const key = setupFile(name);
    if (path.includes(key)) return `The setups go round: ${[...path, key].join(" → ")}`;
    if (done.has(key)) return undefined;
    if (path.length >= 5) return `The setups go more than 5 deep at ${name}`;
    const s = load(name);
    if ("error" in s) return `Setup ${name}: ${s.error}`;
    if (s.only.length && !s.only.includes(env)) return `Setup ${name} only runs in ${s.only.join(", ")}, not ${env || "no environment"}`;
    for (const g of s.given) {
      const e = visit(g, [...path, key]);
      if (e) return e;
    }
    done.add(key);
    order.push({ name, s });
    return undefined;
  };
  for (const g of story.given) {
    const e = visit(g, []);
    if (e) return { ok: false, error: e };
  }
  const steps = [...order.flatMap((o) => o.s.steps), ...story.steps];
  const always = [...story.always, ...order.toReversed().flatMap((o) => o.s.always)];
  if (steps.length + always.length > MAX_STEPS) return { ok: false, error: `With its setups the story has ${steps.length + always.length} steps, more than ${MAX_STEPS}` };
  const stepFrom = [...order.flatMap((o) => o.s.steps.map(() => o.name)), ...story.steps.map(() => "")];
  const alwaysFrom = [...story.always.map(() => ""), ...order.toReversed().flatMap((o) => o.s.always.map(() => o.name))];
  return { ok: true, plan: { steps, always, setups: order.map((o) => o.name), stepFrom, alwaysFrom } };
}

/** Setups read from a checkout's `.http/setups/` (the one place here that reads files); `onRead` hears each file and its hash. */
export const setupLoader =
  (root: string, onRead?: (file: string, hash: string) => void): LoadSetup =>
  (name) => {
    const file = `${setupFile(name)}.story`;
    try {
      const f = readStoryFile(root, "setups", file);
      onRead?.(file, f?.hash ?? "missing");
      if (!f) return { error: `there's no .http/setups/${file}` };
      const p = parseStory(f.text);
      return p.errors.length ? { error: `line ${p.errors[0]!.line}: ${p.errors[0]!.message}` } : p.story;
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
