/**
 * JSON tools (`json`) views. Everything pasted is hostile: it goes through `html` escaping only
 * (never raw()), and no tool renders a link from it.
 */
import { html } from "hono/html";
import { Empty, KeyValues, Notice, PageHeader, Panel, Pill, Tabs, type Html } from "dovre/ui/kit.ts";
import {
  type Change,
  type Json,
  type Match,
  type Parsed,
  MAX_NODES,
  excerpt,
  indexStep,
  keyStep,
  kindOf,
  relative,
} from "./tools.ts";

export type Tool = "format" | "query" | "jq" | "diff" | "convert" | "decode";

const TOOLS: { id: Tool; label: string }[] = [
  { id: "format", label: "Format & tree" },
  { id: "query", label: "Query" },
  { id: "jq", label: "jq" },
  { id: "diff", label: "Diff" },
  { id: "convert", label: "Convert" },
  { id: "decode", label: "Decode" },
];

export const toolHref = (t: Tool) => (t === "format" ? "/json" : `/json/${t}`);

function header(current: Tool, sub: string) {
  return PageHeader({
    title: "JSON",
    sub,
    tabs: Tabs({ label: "JSON tools", items: TOOLS.map((t) => ({ href: toolHref(t.id), label: t.label, current: t.id === current })) }),
  });
}

const PRIVATE = html`<p class="t3 sm">Runs on this Dovre's server, in the request: nothing is sent elsewhere, logged or kept.</p>`;

const rows = (text: string, min = 8, max = 24) => Math.min(max, Math.max(min, text.split("\n").length + 1));

function textarea(name: string, label: string, value: string, opts: { placeholder?: string; min?: number } = {}) {
  return html`<label class="field"><span class="label">${label}</span><textarea name="${name}" rows="${rows(value, opts.min)}" spellcheck="false" autocomplete="off" placeholder="${opts.placeholder ?? ""}">${value}</textarea></label>`;
}

/** A short preview of a value on one line. */
function preview(v: Json, max = 120): string {
  const s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** The text a copy button copies: the value as JSON (a string as it is), cut off when it's huge. */
function copyText(v: Json): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > 200_000 ? "" : s;
}

export function parseError(text: string, r: Extract<Parsed, { ok: false }>, what = "Input") {
  return html`${Notice({ tone: "bad", children: html`<strong>${what} isn't valid JSON</strong>: ${r.error} — line ${r.line}, column ${r.column}.` })}<pre class="code">${excerpt(text, r.line, r.column)}</pre>`;
}

// ── Tree ─────────────────────────────────────────────────────────────────────

/** A document as a tree: each node's JSONPath and value copyable, MAX_NODES drawn at most. */
export function tree(root: Json): Html {
  let drawn = 0;
  const node = (key: string | undefined, v: Json, path: string, depth: number): Html => {
    drawn++;
    const k = kindOf(v);
    const name = key === undefined ? html`<span class="json-key">$</span>` : html`<span class="json-key">${key}</span>`;
    const pathCode = html`<code class="json-path" data-copy="${path}" title="JSON path">${path}</code>`;
    if (k !== "object" && k !== "array") {
      const val = copyText(v);
      return html`<li class="json-node">${name}<span class="json-val json-${k}"${val ? html` data-copy="${val}"` : ""}>${preview(v, 400)}</span>${pathCode}</li>`;
    }
    const entries: [string, Json, string][] = Array.isArray(v)
      ? v.map((x, i) => [String(i), x, path + indexStep(i)])
      : Object.keys(v as object).map((x) => [x, (v as Record<string, Json>)[x]!, path + keyStep(x)]);
    const kids: Html[] = [];
    for (const [ck, cv, cp] of entries) {
      if (drawn >= MAX_NODES) {
        kids.push(html`<li class="json-node t3">… ${entries.length - kids.length} more not drawn (the tree stops at ${MAX_NODES} nodes)</li>`);
        break;
      }
      kids.push(node(ck, cv, cp, depth + 1));
    }
    const count = Array.isArray(v) ? `[${v.length}]` : `{${entries.length}}`;
    const val = copyText(v);
    return html`<li class="json-node"><details${depth < 2 ? " open" : ""}><summary>${name}<span class="json-kind t3"${val ? html` data-copy="${val}"` : ""}>${k} ${count}</span>${pathCode}</summary>${
      kids.length ? html`<ul class="json-tree">${kids}</ul>` : ""
    }</details></li>`;
  };
  return html`<ul class="json-tree json-root">${node(undefined, root, "$", 0)}</ul>`;
}

// ── Format ───────────────────────────────────────────────────────────────────

export type FormatState = { input: string; op?: "format" | "minify" | "tree"; indent?: string; sort?: boolean; result?: { parsed: Parsed; out?: string; value?: Json } };

export function formatPage(s: FormatState): Html {
  const r = s.result;
  const ind = s.indent ?? "2";
  const form = html`<form method="post" action="/json" class="query" data-ctrl-enter>
${textarea("input", "JSON", s.input, { placeholder: '{"paste": "your JSON here"}', min: 10 })}
<div class="fields"><label class="field"><span class="label">Indent</span><select name="indent">${[
    ["2", "2 spaces"],
    ["4", "4 spaces"],
    ["tab", "Tab"],
  ].map(([v, l]) => html`<option value="${v}"${v === ind ? " selected" : ""}>${l}</option>`)}</select></label>
<div class="field"><label class="check"><input type="checkbox" name="sort" value="1"${s.sort ? " checked" : ""}> Sort keys</label></div></div>
<div class="buttons"><button type="submit" name="op" value="format" class="primary">Format</button><button type="submit" name="op" value="minify">Minify</button><button type="submit" name="op" value="tree">Tree</button></div>
${PRIVATE}</form>`;
  let out: Html | "" = "";
  if (r && !r.parsed.ok) out = Panel({ title: "Result", children: parseError(s.input, r.parsed) });
  else if (r && r.parsed.ok) {
    const v = r.parsed.value;
    const facts = html`<p class="t2">${Pill({ tone: "ok", children: "Valid JSON" })} ${kindOf(v)} · ${s.input.length} characters in${r.out !== undefined ? ` · ${r.out.length} out` : ""}</p>`;
    out =
      s.op === "tree" && r.value !== undefined
        ? Panel({ title: "Tree", meta: "Click a path or value's Copy", children: html`${facts}${tree(r.value)}` })
        : Panel({ title: s.op === "minify" ? "Minified" : "Formatted", children: html`${facts}<pre class="code" data-copy>${r.out ?? ""}</pre>` });
  }
  return html`${header("format", "Format, minify, validate and browse JSON.")}${Panel({ children: form })}${out}`;
}

// ── Query ────────────────────────────────────────────────────────────────────

export type QueryState = { input: string; path: string; result?: { parsed: Parsed; matches?: Match[]; more?: boolean; error?: string } };

export function queryPage(s: QueryState): Html {
  const form = html`<form method="post" action="/json/query" class="query" data-ctrl-enter>
<label class="field"><span class="label">JSONPath</span><input type="text" name="path" value="${s.path}" placeholder="$.items[*].id" spellcheck="false" autocomplete="off"><span class="hint">A subset of JSONPath: <code>$</code>, <code>.key</code>, <code>['odd key']</code>, <code>[0]</code>, <code>[-1]</code>, <code>[1:3]</code>, <code>[*]</code>, <code>..key</code> (anywhere below), and filters like <code>[?(@.price &gt; 10)]</code> or <code>[?(@.id)]</code>.</span></label>
${textarea("input", "JSON", s.input, { min: 10 })}
<div class="buttons"><button type="submit" class="primary">Run</button></div>${PRIVATE}</form>`;
  const r = s.result;
  let out: Html | "" = "";
  if (r && !r.parsed.ok) out = Panel({ title: "Result", children: parseError(s.input, r.parsed) });
  else if (r?.error) out = Panel({ title: "Result", children: Notice({ tone: "bad", children: html`<strong>Can't read that path</strong>: ${r.error}` }) });
  else if (r?.matches) {
    out = Panel({
      title: "Matches",
      meta: `${r.matches.length}${r.more ? "+" : ""}`,
      children: r.matches.length
        ? html`<ul class="json-tree json-matches">${r.matches.map(
            (m) => html`<li class="json-node"><code class="json-path" data-copy="${m.path}">${m.path}</code><pre class="code" data-copy>${JSON.stringify(m.value, null, 2)}</pre></li>`,
          )}</ul>${r.more ? html`<p class="t3">Only the first ${r.matches.length} are shown.</p>` : ""}${
            r.matches.length > 1 ? html`<p class="sub-h">All matches as an array</p><pre class="code" data-copy>${JSON.stringify(r.matches.map((m) => m.value), null, 2)}</pre>` : ""
          }`
        : Empty({ title: "No matches", children: html`<p class="t3">The path is fine; nothing in this document is at it.</p>` }),
    });
  }
  return html`${header("query", "Pick values out of a document with a JSONPath.")}${Panel({ children: form })}${out}`;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export type DiffState = { a: string; b: string; result?: { pa: Parsed; pb: Parsed; changes?: Change[]; more?: boolean } };

const TONE = { added: "ok", removed: "bad", changed: "warn" } as const;

/** A structural diff's changes, each with its path and the value before and after. */
export function changesList(changes: Change[], more: boolean): Html {
  return changes.length
    ? html`<ul class="json-tree json-matches">${changes.map(
        (c) => html`<li class="json-node json-change">${Pill({ tone: TONE[c.kind], children: c.kind })} <code class="json-path" data-copy="${c.path}">${c.path}</code>${
          c.kind !== "added" ? html`<div class="json-side"><span class="t3">before</span> <code>${preview(c.before!, 300)}</code></div>` : ""
        }${c.kind !== "removed" ? html`<div class="json-side"><span class="t3">after</span> <code>${preview(c.after!, 300)}</code></div>` : ""}</li>`,
      )}</ul>${more ? html`<p class="t3">Only the first ${changes.length} are shown.</p>` : ""}`
    : Empty({ title: "The same", children: html`<p class="t3">Both documents hold the same data (key order aside).</p>` });
}

export function diffPage(s: DiffState): Html {
  const form = html`<form method="post" action="/json/diff" class="query" data-ctrl-enter>
<div class="grid-2">${textarea("a", "Before", s.a, { min: 10 })}${textarea("b", "After", s.b, { min: 10 })}</div>
<div class="buttons"><button type="submit" class="primary">Compare</button></div>
<p class="t3 sm">Structural: key order is ignored, arrays are compared by position.</p>${PRIVATE}</form>`;
  const r = s.result;
  let out: Html | "" = "";
  if (r && (!r.pa.ok || !r.pb.ok))
    out = Panel({ title: "Result", children: html`${!r.pa.ok ? parseError(s.a, r.pa, "Before") : ""}${!r.pb.ok ? parseError(s.b, r.pb, "After") : ""}` });
  else if (r?.changes) {
    out = Panel({
      title: "Differences",
      meta: `${r.changes.length}${r.more ? "+" : ""}`,
      children: changesList(r.changes, !!r.more),
    });
  }
  return html`${header("diff", "Compare two documents, key order ignored.")}${Panel({ children: form })}${out}`;
}

// ── Convert ──────────────────────────────────────────────────────────────────

export type ConvertOp = "yaml" | "json" | "toml" | "fromtoml" | "ts" | "schema";
export const CONVERT_OPS: [ConvertOp, string][] = [
  ["yaml", "JSON → YAML"],
  ["json", "YAML → JSON"],
  ["toml", "JSON → TOML"],
  ["fromtoml", "TOML → JSON"],
  ["ts", "JSON → TypeScript"],
  ["schema", "JSON → JSON Schema"],
];

export type ConvertState = {
  input: string;
  op?: ConvertOp;
  root?: string;
  result?: { out: string } | { json: Extract<Parsed, { ok: false }> } | { yaml: { error: string; line: number; column: number } } | { toml: { error: string; line: number; column: number } } | { error: string };
};

export function convertPage(s: ConvertState): Html {
  const op = s.op ?? "yaml";
  const form = html`<form method="post" action="/json/convert" class="query" data-ctrl-enter>
${textarea("input", "JSON, YAML or TOML", s.input, { placeholder: '{"paste": "your JSON here"}  or  paste: your YAML here  or  paste = "your TOML here"', min: 10 })}
<div class="fields"><label class="field"><span class="label">Root type name</span><input type="text" name="root" value="${s.root ?? "Root"}" maxlength="60" spellcheck="false" autocomplete="off"><span class="hint">For TypeScript.</span></label></div>
<div class="buttons">${CONVERT_OPS.map(([v, l]) => html`<button type="submit" name="op" value="${v}"${v === op ? ' class="primary"' : ""}>${l}</button>`)}</div>
<p class="t3 sm">Types and schemas are guessed from this one sample: a key missing from some items is optional, and items of one array are merged.</p>${PRIVATE}</form>`;
  const r = s.result;
  const label = CONVERT_OPS.find(([v]) => v === op)?.[1] ?? "Result";
  let out: Html | "" = "";
  if (r && "out" in r) out = Panel({ title: label, children: html`<pre class="code" data-copy>${r.out}</pre>` });
  else if (r && "json" in r) out = Panel({ title: label, children: parseError(s.input, r.json) });
  else if (r && ("yaml" in r || "toml" in r)) {
    const [what, e] = "yaml" in r ? ["YAML", r.yaml] : ["TOML", r.toml];
    out = Panel({
      title: label,
      children: html`${Notice({ tone: "bad", children: html`<strong>Input isn't valid ${what}</strong>: ${e.error} — line ${e.line}, column ${e.column}.` })}<pre class="code">${excerpt(s.input, e.line, e.column)}</pre>`,
    });
  } else if (r && "error" in r) out = Panel({ title: label, children: Notice({ tone: "bad", children: r.error }) });
  return html`${header("convert", "JSON to YAML or TOML and back; types and a schema from a sample.")}${Panel({ children: form })}${out}`;
}

// ── Decode ───────────────────────────────────────────────────────────────────

export type DecodeOp = "jwt" | "b64d" | "b64e" | "b64ue" | "urld" | "urle" | "epoch";
export const DECODE_OPS: [DecodeOp, string][] = [
  ["jwt", "Decode JWT"],
  ["b64d", "Base64 decode"],
  ["b64e", "Base64 encode"],
  ["b64ue", "Base64url encode"],
  ["urld", "URL decode"],
  ["urle", "URL encode"],
  ["epoch", "Epoch ↔ date"],
];

export type DecodeResult =
  | { op: "jwt"; header: Json; payload: Json; signed: boolean; times: { claim: string; at: number; iso: string }[]; expired?: boolean; notYet?: boolean }
  | { op: "text"; text: string; binary?: boolean; json?: Json }
  | { op: "epoch"; ms: number; seconds: number; iso: string; unit: "s" | "ms" | "date" }
  | { op: "error"; error: string };

export type DecodeState = { input: string; op?: DecodeOp; now: number; result?: DecodeResult };

const CLAIM: Record<string, string> = { iat: "Issued", nbf: "Not before", exp: "Expires", auth_time: "Signed in" };

function decoded(r: DecodeResult, now: number): Html {
  if (r.op === "error") return Notice({ tone: "bad", children: r.error });
  if (r.op === "epoch")
    return KeyValues([
      ["Read as", r.unit === "s" ? "Unix seconds" : r.unit === "ms" ? "Unix milliseconds" : "a date"],
      ["UTC", html`<code data-copy>${r.iso}</code>`],
      ["Unix seconds", html`<code data-copy>${String(r.seconds)}</code>`],
      ["Unix ms", html`<code data-copy>${String(r.ms)}</code>`],
      ["From now", relative(r.ms, now)],
    ]);
  if (r.op === "text")
    return html`${r.binary ? Notice({ children: "Not UTF-8 text: the bytes, in hex." }) : ""}<pre class="code" data-copy>${r.text}</pre>${
      r.json !== undefined ? html`<p class="sub-h">As JSON</p><pre class="code" data-copy>${JSON.stringify(r.json, null, 2)}</pre>` : ""
    }`;
  const status =
    r.expired === true
      ? Pill({ tone: "bad", children: "Expired" })
      : r.notYet
        ? Pill({ tone: "warn", children: "Not valid yet" })
        : r.expired === false
          ? Pill({ tone: "ok", children: "Not expired" })
          : Pill({ children: "No expiry" });
  return html`${Notice({ tone: "warn", children: html`Decoded, <strong>not verified</strong>: anyone can make a token that decodes like this. ${r.signed ? "" : "This one has no signature at all."}` })}
<p>${status}</p>
${r.times.length ? KeyValues(r.times.map((t) => [CLAIM[t.claim] ?? t.claim, html`<code>${t.iso}</code> <span class="t3">${relative(t.at, now)}</span>`])) : ""}
<p class="sub-h">Header</p><pre class="code" data-copy>${JSON.stringify(r.header, null, 2)}</pre>
<p class="sub-h">Payload</p><pre class="code" data-copy>${JSON.stringify(r.payload, null, 2)}</pre>`;
}

export function decodePage(s: DecodeState): Html {
  const op = s.op ?? "jwt";
  const form = html`<form method="post" action="/json/decode" class="query" data-ctrl-enter>
${textarea("input", "Input", s.input, { placeholder: "A JWT, base64, a %-encoded string, a Unix time or a date", min: 5 })}
<div class="buttons">${DECODE_OPS.map(([v, l]) => html`<button type="submit" name="op" value="${v}"${v === op ? ' class="primary"' : ""}>${l}</button>`)}</div>
${PRIVATE}</form>`;
  const label = DECODE_OPS.find(([v]) => v === op)?.[1] ?? "Result";
  return html`${header("decode", "JWTs, base64, URL-encoding and Unix times.")}${Panel({ children: form })}${s.result ? Panel({ title: label, children: decoded(s.result, s.now) }) : ""}`;
}

export const styles = `
.jq-filter { font-family: var(--mono); width: 100%; }
.jq-err pre.jq-stderr { margin: 0; white-space: pre-wrap; background: transparent; border: 0; padding: 0; }
.jq-err { margin-bottom: 8px; }
.json-dock textarea { width: 100%; font: var(--fs-xs)/1.5 var(--mono); resize: vertical; }
.json-dock .buttons { flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.json-dock .buttons button { font-size: var(--fs-xs); padding: 3px 8px; }
pre.json-dock-out { max-height: 50vh; overflow: auto; font-size: var(--fs-xs); }
.json-tree { list-style: none; margin: 0; padding: 0 0 0 1.1rem; font: var(--fs-xs)/1.6 var(--mono); }
.json-tree.json-root, .json-tree.json-matches { padding-left: 0; }
.json-node { margin: 0; padding: 1px 0; overflow-wrap: anywhere; }
.json-node > details > summary { list-style-position: outside; }
.json-key { font-weight: 600; color: var(--ink); margin-right: .5rem; }
.json-kind { margin-right: .5rem; }
.json-val { color: var(--ink-2); margin-right: .5rem; white-space: pre-wrap; }
.json-string { color: var(--accent); }
.json-number { color: var(--ink); }
.json-null, .json-boolean { font-style: italic; }
.json-path { color: var(--ink-3); font-size: .92em; margin-right: .3rem; }
.json-change { padding: .35rem 0; border-top: 1px solid var(--line); }
.json-matches > .json-node { padding: .35rem 0; border-top: 1px solid var(--line); }
.json-side { padding-left: .5rem; }
.json-node > pre.code { margin: .3rem 0 0; }
`;

// ── jq ───────────────────────────────────────────────────────────────────────

export const JQ_FLAGS: [string, string][] = [
  ["c", "Compact (-c)"],
  ["r", "Raw strings (-r)"],
  ["s", "Slurp (-s)"],
  ["S", "Sort keys (-S)"],
  ["n", "Null input (-n)"],
];

/** Where the page's script finds jq: the worker, jq's runtime and its WebAssembly (hashed paths). */
export type JqAt = { worker: string; core?: string; wasm?: string };

/**
 * jq runs in the browser (the pack's script, in a Web Worker it stops after 5 s): what's pasted
 * never reaches the server for it. Without the script, posting says so instead of running anything.
 */
export function jqPage(s: { input: string; filter: string; at: JqAt; posted?: boolean }): Html {
  const ready = !!(s.at.core && s.at.wasm);
  const form = html`<form method="post" action="/json/jq" class="query" data-ctrl-enter${ready ? html` data-jq data-worker="${s.at.worker}" data-core="${s.at.core}" data-wasm="${s.at.wasm}"` : ""}>
${textarea("input", "JSON", s.input, { placeholder: '{"paste": "your JSON here"}', min: 10 })}
<label class="field"><span class="label">Filter</span><input type="text" name="filter" value="${s.filter}" maxlength="4000" spellcheck="false" autocomplete="off" class="jq-filter" placeholder=".items[] | select(.ok) | .name"></label>
<div class="fields">${JQ_FLAGS.map(([f, l]) => html`<label class="check"><input type="checkbox" name="f-${f}" value="1"> ${l}</label>`)}</div>
<div class="buttons"><button type="submit" class="primary">Run</button></div>
<p class="t3 sm">Real jq (1.8), as WebAssembly in this browser: what's pasted doesn't leave it. A filter still running after 5 seconds is stopped.</p></form>`;
  const out = html`<div data-jq-out hidden>${Panel({
    title: "Output",
    meta: html`<span data-jq-meta></span>`,
    children: html`<div class="jq-err" data-jq-err hidden>${Notice({ tone: "bad", children: html`<pre class="code jq-stderr" data-jq-stderr></pre>` })}</div><pre class="code" data-copy data-jq-stdout></pre>`,
  })}</div>`;
  const note = !ready
    ? Notice({ tone: "warn", children: "jq isn't served here (its files didn't load); the JSONPath query works on the Query tab." })
    : s.posted
      ? Notice({ tone: "warn", children: "jq runs in your browser, and this page's script didn't run: nothing was sent to jq. Turn on scripts, or use the JSONPath query on the Query tab." })
      : "";
  return html`${header("jq", "Filter and reshape JSON with jq.")}${note}${Panel({ children: form })}${out}`;
}

// ── Dock ─────────────────────────────────────────────────────────────────────

export type DockOp = "format" | "minify" | "jwt" | "b64d" | "epoch";
export const DOCK_OPS: [DockOp, string][] = [
  ["format", "Format"],
  ["minify", "Minify"],
  ["jwt", "JWT"],
  ["b64d", "Base64"],
  ["epoch", "Epoch"],
];

/** The dock beside Bino's: paste, one click, the answer below. The full tools are a link away. */
export function dockView(s: { input: string; op?: DockOp; out?: string; error?: string }): Html {
  const form = html`<form method="post" action="/json/dock" class="json-dock" data-ctrl-enter>
<textarea name="input" rows="7" spellcheck="false" autocomplete="off" aria-label="JSON, a JWT, base64 or a Unix time" placeholder="Paste JSON, a JWT, base64 or a Unix time">${s.input}</textarea>
<div class="buttons">${DOCK_OPS.map(([v, l]) => html`<button type="submit" name="op" value="${v}"${v === (s.op ?? "format") ? ' class="primary"' : ""}>${l}</button>`)}</div></form>`;
  const out = s.error ? Notice({ tone: "bad", children: s.error }) : s.out !== undefined ? html`<pre class="code json-dock-out" data-copy>${s.out}</pre>` : "";
  return html`${form}${out}<p class="t3 sm"><a href="/json" target="_top">All JSON tools</a> · nothing pasted is kept or sent.</p>`;
}
