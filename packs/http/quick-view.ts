/**
 * HTTP client (`http`): the Quick view (`/http`, dovre-packs#65 H-02 and H-03). An endpoint sidebar
 * from the repo's catalog; the picked endpoint's form asks only for its blanks (the whole request is
 * one click away), its cases with ticks and crosses, this session's sends as cards, and its reference
 * from the spec. Everything a response or a repo file brings is hostile: it's only ever interpolated
 * into html`…` (escaped), and links are built through safeUrl.
 */
import { html } from "hono/html";
import { type Child, Dot, Empty, Notice, PageHeader, Panel, Pill, safeUrl, type Tone } from "dovre/pack.ts";
import { agentHref, casesPrompt, debugPrompt, failing, writePrompt } from "./agent.ts";
import { type Case, type CaseResult, expectsText } from "./cases.ts";
import { type Catalog, type Endpoint, endpointKey } from "./catalog.ts";
import { MAX_CHECK, MAX_CHECKS } from "./checks.ts";
import type { FileInfo } from "./files.ts";
import { headersText, MAX_BODY_IN, MAX_HEADERS, MAX_NAME, MAX_URL, METHODS, MODES, type Req, type Secret } from "./model.ts";
import type { SpecDoc } from "./openapi.ts";
import { type Blank, MAX_BLANK } from "./quick.ts";
import type { Sent } from "./send.ts";
import { bodyText, sentHref, statusTone, type Where } from "./view.ts";

type Html = ReturnType<typeof html>;

export type QuickQuery = { repo?: string; env?: string; ep?: string; q?: string; file?: string; n?: string; saved?: string };

/** The Quick view's address: `/http?repo=…&env=…&ep=GET%20%2Forders`. */
export const quickHref = (q: QuickQuery = {}) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return safeUrl(`/http${p ? `?${p}` : ""}`);
};

const crumbs = [{ href: "/http", label: "HTTP" }];
const options = (values: readonly string[], current: string, label: (v: string) => string = (v) => v) => values.map((v) => html`<option value="${v}"${v === current ? html` selected` : ""}>${label(v)}</option>`);
const hidden = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
const clock = (at: number) => `${new Date(at).toISOString().slice(11, 19)} UTC`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type CaseRow = { c: Case; hash: string; result?: CaseResult; open: boolean; sent?: Sent };

export type QuickOpts = {
  repos: string[];
  where: Where;
  envs: string[];
  /** The sidebar's filter. */
  q: string;
  catalog?: Catalog;
  specName?: string;
  files?: FileInfo[];
  /** The last status per endpoint (`endpointKey`), from this session's sends and case runs. */
  dots: Map<string, Tone>;
  ep?: Endpoint;
  doc?: SpecDoc;
  cases: CaseRow[];
  /** The request in the form ({{placeholders}} as written) and its blanks, with the values last typed. */
  req: Req;
  blanks: (Blank & { value: string })[];
  target?: { ok: boolean; text: string };
  secrets: Secret[];
  cards: Sent[];
  prevOf: (s: Sent) => Sent | undefined;
  /** Where Keep as case writes: the endpoint's file, else one named after its group. */
  keepFile: string;
  flash?: { tone: Tone; text: Child };
  line?: string;
  curlOut?: string;
};

/** The fields every form on the page carries back, so a post lands on the same view. */
const back = (o: QuickOpts) => ({ repo: o.where.repo, env: o.where.env, ep: o.ep ? endpointKey(o.ep) : "" });

function picker(o: QuickOpts): Html {
  return html`<form method="get" action="/http" class="fields"><label class="field"><span class="label">Repo</span><select name="repo"><option value="">${o.repos.length ? "Pick a repo" : "No checkouts under CODE_DIR"}</option>${options(o.repos, o.where.repo)}</select></label>
<label class="field"><span class="label">Environment</span><select name="env"><option value="">None</option>${options(o.envs, o.where.env)}</select></label>${o.ep ? hidden({ ep: endpointKey(o.ep) }) : ""}<div class="buttons"><button type="submit">Open</button></div></form>`;
}

function commandLine(o: QuickOpts): Html {
  return html`<form method="post" action="/http/line" class="http-line">${hidden(back(o))}<label class="field"><span class="label">Request, curl or a question</span><input name="line" value="${o.line ?? ""}" maxlength="${MAX_BODY_IN}" spellcheck="false" autocomplete="off" class="mono" placeholder="POST :3000/api/orders customer=cus_19 limit==20 X-Trace:1"></label>
<div class="buttons"><button type="submit">Fill in</button><button type="submit" name="go" value="1" class="primary" data-busy="Sending">Send</button></div>
<p class="hint">Shorthand as httpie writes it: <code>name=value</code> a JSON field, <code>name:=json</code> a raw one, <code>name==value</code> the query, <code>Header:value</code>. <code>/path</code> goes after <code>{{baseUrl}}</code>, <code>:3000/path</code> to localhost. A pasted curl is read, not run. Anything else is a question for an agent, who drafts the request in the repo: you send it.</p></form>`;
}

function filterHit(e: Endpoint, q: string): boolean {
  const hay = `${e.method} ${e.path} ${e.group} ${e.summary}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function sidebar(o: QuickOpts): Html {
  const repo = o.where.repo;
  if (!repo) return html`<nav class="http-side" aria-label="Endpoints">${Empty({ title: "Pick a repo", children: html`<p>Its endpoints come from its OpenAPI spec and the requests saved in <code>.http/</code>.</p>` })}<p><a href="/http/import">Import a spec, collection or curl</a></p></nav>`;
  const eps = (o.catalog?.endpoints ?? []).filter((e) => filterHit(e, o.q));
  const groups = new Map<string, Endpoint[]>();
  for (const e of eps) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  const all = o.catalog?.endpoints ?? [];
  const fromSpec = all.filter((e) => e.fromSpec).length;
  return html`<nav class="http-side" aria-label="Endpoints">
<p class="t3">${plural(all.length, "endpoint")}${o.specName ? html`: ${fromSpec} from <code>${o.specName}</code>, ${all.length - fromSpec} more from <code>.http/</code>` : ""}</p>
<form method="get" action="/http" class="http-filter">${hidden({ repo, env: o.where.env })}<label class="field"><span class="label">Filter</span><input type="search" name="q" value="${o.q}" maxlength="100" placeholder="orders, POST" autocomplete="off"></label></form>
${o.catalog?.notes.map((n) => html`<p class="hint">${n}</p>`)}
${
  !all.length
    ? Empty({ title: "No endpoints yet", children: html`<p>Add an <code>openapi.yaml</code>, or send a request and keep it as a case.</p>` })
    : !eps.length
      ? html`<p class="t3">Nothing matches.</p>`
      : [...groups].map(
          ([g, list]) => html`<h3 class="sub-h">${g}</h3><ul class="http-eps">${list.map((e) => {
            const on = o.ep && endpointKey(o.ep) === endpointKey(e);
            const tone = o.dots.get(endpointKey(e));
            return html`<li><a class="http-ep${on ? " on" : ""}" href="${quickHref({ repo, env: o.where.env, ep: endpointKey(e), q: o.q })}"${on ? html` aria-current="page"` : ""}>${Dot({ tone: tone ?? "neutral", label: tone ? `last ${tone === "ok" ? "passed" : tone === "bad" ? "failed" : "answered"}` : undefined })}<span class="http-m">${e.method}</span><span class="http-p">${e.path}</span>${e.cases.length ? html`<span class="t3">${e.cases.length}</span>` : ""}</a></li>`;
          })}</ul>`,
        )
}
${o.files?.length ? html`<h3 class="sub-h">Files</h3><ul class="http-eps">${o.files.map((f) => html`<li class="http-file"><span class="mono">${f.name}</span>${f.error ? html` <span class="t3">${f.error}</span>` : ""}</li>`)}</ul>` : ""}
<p><a href="${safeUrl(`/http/stories?${new URLSearchParams({ repo, ...(o.where.env ? { env: o.where.env } : {}) })}`)}">Stories</a>: chains of requests, run step by step</p>
<div class="buttons"><a class="btn sm ghost" href="${agentHref(repo, writePrompt())}" title="Start an agent session that writes this repo's endpoints as .http requests">Write requests with an agent</a></div>
<p><a href="/http/import">Import a spec, collection or curl</a></p>
</nav>`;
}

function requestForm(o: QuickOpts): Html {
  const r = o.req;
  const w = o.where;
  const showBody = r.mode !== "none";
  const body = html`<label class="field"><span class="label">Body${r.mode === "json" ? " (JSON)" : r.mode === "form" ? " (form)" : ""}</span><textarea name="body" rows="${Math.min(14, Math.max(4, r.body.split("\n").length + 1))}" maxlength="${MAX_BODY_IN}" spellcheck="false" class="mono" placeholder='{ "name": "{{name}}" }'>${r.body}</textarea></label>`;
  const title = o.ep
    ? html`<span class="http-m">${o.ep.method}</span> ${o.ep.path}`
    : r.url
      ? html`<span class="http-m">${r.method}</span> ${r.name || "Request"}`
      : "Request";
  const caseOpen = o.cases.find((x) => x.open);
  return Panel({
    title,
    meta: caseOpen ? html`<span class="t3">case ${caseOpen.c.req.name || `#${caseOpen.c.n + 1}`} from ${w.opened}</span>` : o.ep?.summary ? html`<span class="t3">${o.ep.summary}</span>` : "",
    children: html`<form method="post" action="/http/send" data-ctrl-enter>${hidden({ back: "quick", ep: o.ep ? endpointKey(o.ep) : "", repo: w.repo, opened: w.opened, n: w.n, hash: w.hash })}
${o.blanks.length ? html`<div class="http-blanks">${o.blanks.map((b) => html`<label class="field"><span class="label">${b.name} <span class="t3">${b.where}</span></span><input name="blank.${b.name}" value="${b.value}" maxlength="${MAX_BLANK}" spellcheck="false" autocomplete="off" class="mono"></label>`)}</div>` : r.url ? html`<p class="hint">No blanks: everything it needs comes from the environment.</p>` : ""}
${showBody ? body : ""}
${o.target ? html`<p class="notes">${o.target.ok ? html`Goes to <code>${o.target.text}</code>` : html`<span class="t3">${o.target.text}</span>`}</p>` : ""}
<div class="buttons"><button type="submit" class="primary" data-busy="Sending">Send</button><button type="submit" formaction="/http/curl">Copy as curl</button></div>
<details${r.url ? "" : html` open`}><summary>The whole request</summary>
<div class="fields"><label class="field"><span class="label">Method</span><select name="method">${options(METHODS, r.method)}</select></label>
<label class="field"><span class="label">URL</span><input name="url" value="${r.url}" maxlength="${MAX_URL}" spellcheck="false" autocomplete="off" class="mono" placeholder="{{baseUrl}}/api/items"></label></div>
<div class="fields"><label class="field"><span class="label">Headers</span><textarea name="headers" rows="3" maxlength="${MAX_HEADERS}" spellcheck="false" class="mono" placeholder="Accept: application/json&#10;Authorization: Bearer {{API_TOKEN}}">${headersText(r.headers)}</textarea><span class="hint">One per line, Name: value.</span></label>
<label class="field"><span class="label">Query</span><textarea name="query" rows="3" maxlength="${MAX_URL}" spellcheck="false" class="mono" placeholder="page=1&#10;q={{term}}">${r.query.join("\n")}</textarea><span class="hint">One per line, key=value as it goes in the URL.</span></label></div>
<div class="fields"><label class="field"><span class="label">Body</span><select name="mode">${options(MODES, r.mode, (m) => ({ none: "None", raw: "Raw", json: "JSON", form: "Form (urlencoded)" })[m] ?? m)}</select></label>
<label class="field"><span class="label">Environment</span><select name="env"><option value="">None</option>${options(o.envs, w.env)}</select></label></div>
${showBody ? "" : body}
<label class="field"><span class="label">Checks</span><textarea name="expect" rows="2" maxlength="${MAX_CHECKS * (MAX_CHECK + 20)}" spellcheck="false" class="mono" placeholder="status 200&#10;json $.items[0].id exists">${(r.expect ?? []).join("\n")}</textarea><span class="hint">One per line: status 2xx, time &lt; 800, header content-type contains json, body contains ok, json $.id == 3. None: any status below 400 passes.</span></label>
<div class="fields"><label class="field"><span class="label">Case name</span><input name="name" value="${r.name}" maxlength="${MAX_NAME}" placeholder="Happy path"></label>
<label class="field"><span class="label">In file</span><input name="file" value="${w.file || o.keepFile}" maxlength="85" spellcheck="false" placeholder="api.http"></label></div>
<div class="buttons"><button type="submit" formaction="/http/save"${w.repo ? "" : html` disabled title="Pick a repo first"`}>${w.opened && w.n !== "" && (w.file || o.keepFile) === w.opened ? "Save the case" : "Save as a case"}</button></div>
<p class="notes">Saved to <code>${w.repo || "the repo"}/.http/</code> as written: {{placeholders}} stay, the blanks go in as typed, a secret's value is never saved.${o.secrets.length ? html` Secrets: ${o.secrets.map((s, i) => html`${i ? ", " : ""}<code>{{${s.name}}}</code> to ${s.hosts.join(", ")}${s.value ? "" : " (not set)"}`)}.` : ""}</p>
</details>
<p class="hint">Sending is one click (⌘↵): it goes out from this machine (localhost and your VPN), follows no redirects and gives up after 30 s.</p>
</form>`,
  });
}

function resultLine(r: CaseResult | undefined): Child {
  if (!r) return html`<span class="t3">not run this session</span>`;
  if (r.state === "running") return html`<span class="t3" data-pending><span class="spinner"></span> running…</span>`;
  return html`<span class="t3">${r.state} ${clock(r.at)}${r.env ? `, ${r.env}` : ""}${r.status !== undefined ? ` · ${r.status} · ${r.ms} ms` : ""}</span>`;
}

const caseTone = (r: CaseResult | undefined): Tone => (!r || r.state === "running" ? "neutral" : r.state === "passed" ? "ok" : "bad");

function casesPanel(o: QuickOpts): Html {
  const ep = o.ep!;
  const repo = o.where.repo;
  const hashes = [...new Map(o.cases.map((x) => [x.c.file, x.hash]))].map(([f, h]) => `${f}:${h}`).join("\n");
  const runAll = o.cases.length
    ? html`<form method="post" action="/http/cases/run" class="inline">${hidden({ ...back(o), hashes })}<button type="submit" class="btn sm" data-busy="Running">Run all ${o.cases.length}</button></form>`
    : "";
  const rows = o.cases.map(({ c, hash, result, open, sent }) => {
    const label = c.req.name || `${c.req.method} ${c.req.url}`;
    const debug = result?.state === "failed" && sent && failing(sent) ? html` <a class="btn sm ghost" href="${agentHref(repo, debugPrompt(sent))}" title="Start an agent session with this request and its answer: you read the prompt first">Debug with an agent</a>` : "";
    return html`<li class="item http-case${open ? " on" : ""}">${Dot({ tone: caseTone(result), label: result && result.state !== "running" ? result.state : undefined })} <a href="${quickHref({ repo, env: o.where.env, ep: endpointKey(ep), file: c.file, n: String(c.n) })}"${open ? html` aria-current="true"` : ""}>${label}</a> <span class="t3 mono">${expectsText(c.req)}</span> ${resultLine(result)}
<form method="post" action="/http/case/run" class="inline">${hidden({ ...back(o), file: c.file, n: String(c.n), hash })}<button type="submit" class="btn sm ghost" data-busy="Running">Run</button></form>${debug}
${c.req.given?.length ? html`<p class="hint">Given: ${c.req.given.join(", ")} (setups run in a story; here it runs as it is)</p>` : ""}
${result?.error ? html`<p class="notes">${result.error}</p>` : ""}
${result?.checks.length ? html`<ul class="list">${result.checks.map((x) => html`<li class="item">${Pill({ tone: x.ok ? "ok" : "bad", children: x.ok ? "ok" : "no" })} <span class="mono">${x.text}</span>${x.got !== undefined ? html` <span class="t3">got ${x.got}</span>` : ""}</li>`)}</ul>` : ""}
${result?.sentId && sent ? html`<p class="hint"><a href="${sentHref(result.sentId)}">Its response</a> · <span class="mono">${c.file}</span></p>` : html`<p class="hint mono">${c.file}</p>`}</li>`;
  });
  return html`<div data-live id="http-cases">${Panel({
    title: "Cases",
    meta: html`<span class="t3">${plural(o.cases.length, "case")} of ${ep.method} ${ep.path}</span>`,
    actions: runAll,
    children: o.cases.length
      ? html`<ul class="list">${rows}</ul><p class="hint">Running a case sends it as it's saved (one click, logged), and holds the answer to its checks.</p>`
      : html`${Empty({ title: "No cases yet", children: html`<p>Send it, then <strong>Keep as case</strong> on its card: it's saved to <code>.http/${o.keepFile}</code>.</p>` })}<div class="buttons"><a class="btn sm ghost" href="${agentHref(repo, casesPrompt(ep, o.keepFile))}" title="Start an agent session that writes cases for this endpoint: you read the prompt first">Draft cases with an agent</a></div>`,
  })}</div>`;
}

function card(s: Sent, o: QuickOpts, expanded: boolean): Html {
  const prev = o.prevOf(s);
  const r = s.resp;
  const status =
    s.state === "done" && r
      ? Pill({ tone: statusTone(r.status), children: String(r.status) })
      : s.state === "failed"
        ? Pill({ tone: "bad", children: "failed" })
        : html`<span class="t3" data-pending><span class="spinner"></span></span>`;
  const was = prev?.resp && r && prev.resp.status !== r.status ? html` <span class="t3">was ${prev.resp.status}</span>` : "";
  const ct = r?.headers.find(([k]) => k === "content-type")?.[1] ?? "";
  const shown = r && !r.binary && r.body ? bodyText(r.body.slice(0, 200_000), ct, "pretty").text : "";
  const excerpt = shown.length > 4_000 ? `${shown.slice(0, 4_000)}\n…` : shown;
  const keep =
    o.where.repo && s.state === "done"
      ? html`<form method="post" action="/http/keep" class="http-keep">${hidden({ ...back(o), id: s.id })}<label class="field"><span class="label">Case name</span><input name="name" value="${s.req.name}" maxlength="${MAX_NAME}" placeholder="Happy path"></label><label class="field"><span class="label">In file</span><input name="file" value="${o.keepFile}" maxlength="85" spellcheck="false"></label><div class="buttons"><button type="submit">Keep as case</button></div></form>`
      : "";
  return html`<li class="http-card">
<div class="http-card-head">${status}${was} <strong>${s.out.method}</strong> <span class="mono http-p">${s.out.url}</span> <span class="t3">${clock(s.at)}${r ? ` · ${r.ms} ms` : ""}${s.by === "agent" ? " · by an agent" : ""}</span></div>
${s.state === "failed" ? html`<p class="notes">${s.error ?? "It failed."}</p>` : ""}
${expanded && excerpt ? html`<pre class="output" data-copy>${excerpt}</pre>` : expanded && r && !r.body ? html`<p class="hint">No body.</p>` : ""}
<div class="buttons"><a class="btn sm ghost" href="${sentHref(s.id)}">Response</a>${prev?.resp && r ? html`<a class="btn sm ghost" href="${sentHref(s.id, "diff")}">Compare with ${clock(prev.at)}</a>` : ""}<form method="post" action="/http/resend" class="inline">${hidden({ ...back(o), id: s.id })}<button type="submit" class="btn sm ghost" data-busy="Sending">Send again</button></form>${failing(s) ? html`<a class="btn sm ghost" href="${agentHref(s.from.repo, debugPrompt(s))}" title="Start an agent session with this request and its answer: you read the prompt first">Debug with an agent</a>` : ""}</div>
${keep}
</li>`;
}

function cardsRegion(o: QuickOpts): Html {
  return html`<div data-live id="http-cards">${Panel({
    title: "This session",
    meta: html`<span class="t3">${o.ep ? `sends of ${o.ep.method} ${o.ep.path}` : "every send"}, in memory</span>`,
    children: o.cards.length ? html`<ul class="http-cards">${o.cards.map((s, i) => card(s, o, i === 0))}</ul>` : Empty({ title: "Nothing sent yet" }),
  })}</div>`;
}

function reference(doc: SpecDoc, specName: string | undefined): Html {
  const rows = (head: string[], list: Child[][]) =>
    html`<div class="sheet"><table class="data"><thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${list.map((r) => html`<tr>${r.map((c, i) => (i ? html`<td>${c}</td>` : html`<th scope="row" class="mono">${c}</th>`))}</tr>`)}</tbody></table></div>`;
  const respTone = (code: string): Tone => (/^2/.test(code) ? "ok" : /^[45]/.test(code) ? "warn" : "neutral");
  return Panel({
    title: "Reference",
    meta: specName ? html`<span class="t3">from <code>${specName}</code></span>` : "",
    children: html`${doc.summary ? html`<p><strong>${doc.summary}</strong></p>` : ""}${doc.about ? html`<p class="notes">${doc.about}</p>` : ""}
${doc.params.length ? html`<h3 class="sub-h">Parameters</h3>${rows(["name", "in", "type", "about"], doc.params.map((p) => [html`${p.name}${p.required ? html` <span class="t3">required</span>` : ""}`, p.in, html`<span class="mono">${p.type}</span>`, p.about]))}` : ""}
${doc.fields.length ? html`<h3 class="sub-h">Body</h3>${rows(["field", "type", "about"], doc.fields.map((f) => [html`${f.name}${f.required ? html` <span class="t3">required</span>` : ""}`, html`<span class="mono">${f.type}</span>`, f.about]))}` : ""}
${doc.responses.length ? html`<h3 class="sub-h">Responses</h3><ul class="list">${doc.responses.map((r) => html`<li class="item">${Pill({ tone: respTone(r.code), children: r.code })} ${r.about}</li>`)}</ul>` : ""}`,
  });
}

export function quickPage(o: QuickOpts): Html {
  const c = o.catalog;
  const sub = o.where.repo ? html`${c?.title || o.where.repo}${o.where.env ? html` · ${o.where.env}` : ""}` : "Requests from this machine, saved as .http files in your repos";
  return html`${PageHeader({ title: "HTTP client", sub, crumbs })}
${o.flash ? Notice({ tone: o.flash.tone, children: o.flash.text }) : ""}
${picker(o)}
${commandLine(o)}
${o.curlOut !== undefined ? Panel({ title: "As curl", children: html`<pre class="output" data-copy>${o.curlOut}</pre><p class="notes">Secrets stay shell variables ($NAME): set them in your shell to run it.</p>` }) : ""}
<div class="http-quick">
${sidebar(o)}
<div class="http-main">
${requestForm(o)}
${o.ep && o.where.repo ? casesPanel(o) : ""}
${cardsRegion(o)}
${o.doc ? reference(o.doc, o.specName) : ""}
</div>
</div>`;
}

export const quickStyles = `
.http-quick { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: 1rem; align-items: start; }
.http-side { display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
.http-main { display: flex; flex-direction: column; gap: .75rem; min-width: 0; }
.http-eps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.http-ep { display: flex; gap: .5rem; align-items: center; padding: 6px 8px; border-radius: var(--r-s); color: var(--text-2); text-decoration: none; font: var(--fs-xs)/1.4 var(--mono); min-height: 32px; }
.http-ep:hover { background: var(--hover); color: var(--text); }
.http-ep.on { background: var(--accent-soft); color: var(--accent-ink); }
.http-m { flex: none; min-width: 3.4em; color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); }
.http-ep .http-p { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.http-file { display: flex; gap: .5rem; align-items: center; justify-content: space-between; font-size: var(--fs-xs); padding: 2px 8px; }
.http-blanks { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: .5rem .75rem; }
.http-case.on { background: var(--accent-soft); border-radius: var(--r-s); }
.http-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .75rem; }
.http-card { border-top: 1px solid var(--line); padding-top: .75rem; display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
.http-card:first-child { border-top: 0; padding-top: 0; }
.http-card-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; min-width: 0; }
.http-card-head .http-p { overflow-wrap: anywhere; }
.http-keep { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; }
.http-line .mono, .http-filter input { width: 100%; }
@media (max-width: 760px) { .http-quick { grid-template-columns: 1fr; } }
`;
