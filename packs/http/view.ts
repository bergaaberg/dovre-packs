/**
 * HTTP client (`http`) views. Everything a response brings (status text, headers, body) is
 * hostile: it's only ever interpolated into html`…` (escaped), a body is text in a <pre> whatever
 * its type (an HTML page shows as its source), and links are built from paths through safeUrl.
 */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { type Child, Confirm, Empty, KeyValues, Notice, PageHeader, Panel, Pill, type Tone } from "dovre/ui/kit.ts";
import { type FileInfo, FILE_RE } from "./files.ts";
import { headersText, MAX_BODY_IN, MAX_HEADERS, MAX_NAME, MAX_URL, METHODS, MODES, type Req, type Secret } from "./model.ts";
import type { Sent } from "./send.ts";
import { compare } from "./compare.ts";
import { parse } from "../json/tools.ts";
import { changesList, tree } from "../json/view.ts";
import { type Imported, MAX_SPEC } from "./openapi.ts";
import { agentHref, debugPrompt, failing, writePrompt } from "./agent.ts";
import { MAX_CHECK, MAX_CHECKS } from "./checks.ts";
import { failedSteps, MAX_RUN, passed, type Run, type Step } from "./run.ts";

/** Where the editor's request is from: the environment, the repo and file it's saved to, and the file it was opened from (`opened`, its request `n`, the file's `hash` then). */
export type Where = { env: string; repo: string; file: string; opened: string; n: string; hash: string };
export const noWhere = (): Where => ({ env: "", repo: "", file: "", opened: "", n: "", hash: "" });

export const homeHref = (q: Partial<Where> & { saved?: string } = {}) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return safeUrl(`/http${p ? `?${p}` : ""}`);
};
export const runHref = (q: { repo: string; file: string; env?: string }) => safeUrl(`/http/run?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()}`);
export const runPageHref = (id: string) => safeUrl(`/http/run/${encodeURIComponent(id)}`);
export const sentHref = (id: string, view?: string) => safeUrl(`/http/r/${encodeURIComponent(id)}${view ? `?view=${encodeURIComponent(view)}` : ""}`);

const crumbs = [{ href: "/http", label: "HTTP" }];

export const statusTone = (status: number): Tone => (status >= 500 ? "bad" : status >= 400 ? "warn" : status >= 300 ? "neutral" : "ok");

const sizeText = (n: number) => (n < 1000 ? `${n} B` : n < 1_000_000 ? `${(n / 1000).toFixed(1)} kB` : `${(n / 1_000_000).toFixed(2)} MB`);

const options = (values: readonly string[], current: string, label: (v: string) => string = (v) => v) => values.map((v) => html`<option value="${v}"${v === current ? html` selected` : ""}>${label(v)}</option>`);

/** The editor's fields as hidden inputs (a Confirm's second click posts them again). */
export function formFields(r: Req, w: Where): Record<string, string> {
  return { name: r.name, method: r.method, url: r.url, headers: headersText(r.headers), query: r.query.join("\n"), mode: r.mode, body: r.body, expect: (r.expect ?? []).join("\n"), env: w.env, repo: w.repo, file: w.file, opened: w.opened, n: w.n, hash: w.hash };
}

export type EditorOpts = {
  req: Req;
  where: Where;
  envs: string[];
  repos: string[];
  /** Where it would go (resolved, masked), or why it can't: worked out without sending anything. */
  target?: { ok: boolean; text: string };
  secrets: Secret[];
};

export function editor(o: EditorOpts): Html {
  const r = o.req;
  const w = o.where;
  return Panel({
    title: "Request",
    meta: w.repo && w.opened ? html`<span class="t3">from ${w.repo}/.http/${w.opened}${w.n ? ` #${Number(w.n) + 1}` : ""}</span>` : "",
    children: html`<form method="post" action="/http/send" data-ctrl-enter>
<input type="hidden" name="opened" value="${w.opened}"><input type="hidden" name="n" value="${w.n}"><input type="hidden" name="hash" value="${w.hash}">
<div class="fields"><label class="field"><span class="label">Method</span><select name="method">${options(METHODS, r.method)}</select></label>
<label class="field"><span class="label">URL</span><input name="url" value="${r.url}" maxlength="${MAX_URL}" required spellcheck="false" autocomplete="off" class="mono" placeholder="{{baseUrl}}/api/items"></label></div>
${o.target ? html`<p class="notes">${o.target.ok ? html`Goes to <code>${o.target.text}</code>` : html`<span class="t3">${o.target.text}</span>`}</p>` : ""}
<div class="fields"><label class="field"><span class="label">Headers</span><textarea name="headers" rows="4" maxlength="${MAX_HEADERS}" spellcheck="false" class="mono" placeholder="Accept: application/json&#10;Authorization: Bearer {{API_TOKEN}}">${headersText(r.headers)}</textarea><span class="hint">One per line, Name: value.</span></label>
<label class="field"><span class="label">Query</span><textarea name="query" rows="4" maxlength="${MAX_URL}" spellcheck="false" class="mono" placeholder="page=1&#10;q={{term}}">${r.query.join("\n")}</textarea><span class="hint">One per line, key=value as it goes in the URL.</span></label></div>
<div class="fields"><label class="field"><span class="label">Body</span><select name="mode">${options(MODES, r.mode, (m) => ({ none: "None", raw: "Raw", json: "JSON", form: "Form (urlencoded)" })[m] ?? m)}</select></label>
<label class="field"><span class="label">Environment</span><select name="env"><option value="">None</option>${options(o.envs, w.env)}</select></label></div>
<label class="field"><textarea name="body" rows="8" maxlength="${MAX_BODY_IN}" spellcheck="false" class="mono" aria-label="Body" placeholder='{ "name": "{{name}}" }'>${r.body}</textarea><span class="hint">Form: one key=value per line, as it goes on the wire. {{name}} fills in from the environment; {{$guid}}, {{$timestamp}} and {{$isoTimestamp}} too.</span></label>
<label class="field"><span class="label">Checks</span><textarea name="expect" rows="2" maxlength="${MAX_CHECKS * (MAX_CHECK + 20)}" spellcheck="false" class="mono" placeholder="status 200&#10;json $.items[0].id exists">${(r.expect ?? []).join("\n")}</textarea><span class="hint">For running the file as a smoke test, one per line: status 2xx, time &lt; 800, header content-type contains json, body contains ok, json $.id == 3. Saved as # @expect lines. None: any status below 400 passes.</span></label>
<div class="buttons"><button type="submit" class="primary" data-busy="Sending">Send</button><button type="submit" formaction="/http/curl">Copy as curl</button></div>
<div class="fields"><label class="field"><span class="label">Save in repo</span><select name="repo"><option value="">Pick a repo</option>${options(o.repos, w.repo)}</select></label>
<label class="field"><span class="label">File</span><input name="file" value="${w.file}" maxlength="85" spellcheck="false" placeholder="api.http"></label>
<label class="field"><span class="label">Name</span><input name="name" value="${r.name}" maxlength="${MAX_NAME}" placeholder="List items"></label></div>
<div class="buttons"><button type="submit" formaction="/http/save">Save</button></div>
<p class="notes">Sending is one click: it goes out from this machine (it can reach localhost and your VPN), follows no redirects and gives up after 30 s. Saved to <code>.http/</code> in the repo, as written: {{placeholders}} stay, a secret's value is never saved.${o.secrets.length ? html` Secrets: ${o.secrets.map((s, i) => html`${i ? ", " : ""}<code>{{${s.name}}}</code> to ${s.hosts.join(", ")}${s.value ? "" : " (not set)"}`)}.` : ""}</p>
</form>`,
  });
}

function importPanel(curl = ""): Html {
  return Panel({
    title: "Import from curl",
    children: html`<form method="post" action="/http/import"><label class="field"><textarea name="curl" rows="3" maxlength="${MAX_BODY_IN}" spellcheck="false" class="mono" aria-label="curl command" placeholder="curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{&quot;a&quot;:1}'">${curl}</textarea><span class="hint">Read here, nothing is sent. A secret's value in it becomes its {{NAME}}.</span></label><div class="buttons"><button type="submit">Import</button></div></form>`,
  });
}

function openapiPanel(spec = ""): Html {
  return Panel({
    title: "Import a spec or collection",
    children: html`<form method="post" action="/http/openapi"><label class="field"><textarea name="spec" rows="3" maxlength="${MAX_SPEC}" spellcheck="false" class="mono" aria-label="OpenAPI spec or collection" placeholder="openapi: 3.0.3&#10;paths:&#10;  /items: …">${spec}</textarea><span class="hint">OpenAPI 3 or Swagger 2 (JSON or YAML), a Postman collection (exported JSON), or Bruno (.bru files pasted one after another, or its JSON export). Read here, nothing is fetched or sent; credential values become {{placeholders}}.</span></label><div class="buttons"><button type="submit">Preview</button></div></form>`,
  });
}

/** An imported spec's requests: open one in the editor, or save them all to a repo's .http file. */
export function openapiPage(o: { got: Extract<Imported, { ok: true }>; spec: string; repos: string[]; repo: string; file: string; problem?: string }): Html {
  const g = o.got;
  return html`${PageHeader({ title: g.title, sub: `${g.reqs.length} request${g.reqs.length === 1 ? "" : "s"} from ${g.from}, nothing sent`, crumbs })}
${o.problem ? Notice({ tone: "warn", children: o.problem }) : ""}
${Notice({
  tone: "neutral",
  children:
    g.from === "an OpenAPI spec"
      ? html`Each URL starts with <code>{{baseUrl}}</code>: set it in an environment${g.server ? html` (the spec's server is <code>${g.server}</code>)` : ""}. {{Placeholders}} for parameters and auth stay to fill in.${g.notes.length ? ` ${g.notes.join(" ")}` : ""}`
      : html`{{Variables}} stay as written: set them in an environment${g.vars?.length ? html` (the collection's own ${g.vars.length} go at the top of a new file)` : ""}.${g.notes.length ? ` ${g.notes.join(" ")}` : ""}`,
})}
${Panel({
  title: "Save them all",
  children: html`<form method="post" action="/http/openapi/save"><input type="hidden" name="spec" value="${o.spec}"><div class="fields"><label class="field"><span class="label">Repo</span><select name="repo"><option value="">Pick a repo</option>${options(o.repos, o.repo)}</select></label>
<label class="field"><span class="label">File</span><input name="file" value="${o.file}" maxlength="85" spellcheck="false" placeholder="api.http"></label></div>
<div class="buttons"><button type="submit" class="primary">Save</button></div><p class="notes">A new file in <code>.http/</code>, or added to the end of one that's there (nothing in it changes).</p></form>`,
})}
${Panel({
  title: "Requests",
  children: html`<ul class="list">${g.reqs.map(
    (r) =>
      html`<li class="item"><form method="post" action="/http/open" class="inline">${Object.entries(formFields(r, noWhere())).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit">Open</button></form> <strong>${r.method}</strong> ${r.name} <span class="t3 mono">${r.url}</span></li>`,
  )}</ul>`,
})}`;
}

function savedPanel(o: { repos: string[]; repo: string; files: FileInfo[] | undefined; env: string }): Html {
  const pick = html`<form method="get" action="/http" class="fields"><label class="field"><span class="label">Repo</span><select name="repo">${o.repos.length ? "" : html`<option value="">No checkouts under CODE_DIR</option>`}${options(o.repos, o.repo)}</select></label>${o.env ? html`<input type="hidden" name="env" value="${o.env}">` : ""}<div class="buttons"><button type="submit">Open</button></div></form>`;
  const list = !o.repo
    ? ""
    : !o.files?.length
      ? Empty({ title: "No .http files yet", children: html`<p>Save a request to start <code>${o.repo}/.http/</code>.</p>` })
      : html`${o.files.map(
          (f) =>
            html`<h3 class="sub-h">${f.name}${f.reqs.length && !f.error ? html` <a class="btn sm ghost" href="${runHref({ repo: o.repo, file: f.name, env: o.env })}" title="Send its requests one after the other and check each response">Run</a>` : ""}</h3>${f.error ? Notice({ tone: "warn", children: f.error }) : ""}<ul class="list">${f.reqs.map(
              (q, i) =>
                html`<li class="item"><a href="${homeHref({ repo: o.repo, file: f.name, n: String(i), env: o.env })}"><strong>${q.method}</strong> ${q.name || q.url}</a>${q.name ? html` <span class="t3 mono">${q.url}</span>` : ""}</li>`,
            )}</ul>`,
        )}`;
  const agent = o.repo ? html`<div class="buttons"><a class="btn sm ghost" href="${agentHref(o.repo, writePrompt())}" title="Start an agent session that writes this repo's endpoints as .http requests">Write requests with an agent</a></div>` : "";
  return Panel({ title: "Saved in repos", children: html`${pick}${list}${agent}` });
}

function historyPanel(list: Sent[]): Html {
  return Panel({
    title: "History",
    meta: html`<span class="t3">this session, in memory</span>`,
    children: list.length
      ? html`<ul class="list">${list.map(
          (s) =>
            html`<li class="item"><a href="${sentHref(s.id)}">${s.state === "done" && s.resp ? Pill({ tone: statusTone(s.resp.status), children: String(s.resp.status) }) : Pill({ tone: s.state === "failed" ? "bad" : "neutral", children: s.state === "failed" ? "failed" : "…" })} <strong>${s.out.method}</strong> <span class="mono">${s.out.url}</span>${s.by === "agent" ? html` <span class="t3">by an agent</span>` : ""}</a></li>`,
        )}</ul>`
      : Empty({ title: "Nothing sent yet" }),
  });
}

export type HomeOpts = EditorOpts & { files?: FileInfo[]; history: Sent[]; flash?: { tone: Tone; text: Child }; curl?: string; curlOut?: string; spec?: string };

export function homePage(o: HomeOpts): Html {
  return html`${PageHeader({ title: "HTTP client", sub: "Requests from this machine, saved as .http files in your repos", crumbs })}
${o.flash ? Notice({ tone: o.flash.tone, children: o.flash.text }) : ""}
${o.curlOut !== undefined ? Panel({ title: "As curl", children: html`<pre class="output" data-copy>${o.curlOut}</pre><p class="notes">Secrets stay shell variables ($NAME): set them in your shell to run it.</p>` }) : ""}
${editor(o)}
<div class="grid-2">${savedPanel({ repos: o.repos, repo: o.where.repo, files: o.files, env: o.where.env })}${historyPanel(o.history)}</div>
<div class="grid-2">${importPanel(o.curl)}${openapiPanel(o.spec)}</div>`;
}

/** A body for reading: JSON pretty-printed (unless asked raw), anything else as the text it is. */
export function bodyText(body: string, ct: string, view: string): { text: string; json: boolean } {
  if (view !== "raw" && (/json/i.test(ct) || /^\s*[[{]/.test(body))) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2).slice(0, 2_000_000), json: true };
    } catch {
      // Not JSON after all: shown as it came.
    }
  }
  return { text: body, json: false };
}

/** The response, pretty / as a tree / raw, and a link to compare it with the send before (`prev`). */
export function responseRegion(s: Sent, view: string, prev?: Sent): Html {
  const debug = failing(s) ? html`<div class="buttons"><a class="btn sm ghost" href="${agentHref(s.from.repo, debugPrompt(s))}" title="Start an agent session with this request and its answer: you read the prompt first">Debug with an agent</a></div>` : "";
  const inner = (): Child => {
    if (s.state === "sending") return html`<p class="notes" data-pending><span class="spinner"></span> Sending ${s.out.method} <code>${s.out.url}</code>…</p>`;
    if (s.state === "failed" || !s.resp) return html`${Notice({ tone: "bad", children: html`Nothing came back from <code>${s.out.url}</code>: ${s.error ?? "it failed"}.` })}${debug}`;
    const r = s.resp;
    const ct = r.headers.find(([k]) => k === "content-type")?.[1] ?? "";
    const b = bodyText(r.body, ct, view);
    const parsed = view === "tree" && b.json && !r.truncated ? parse(r.body) : undefined;
    const views = (cur: string) =>
      html` <span class="t3">${b.json || view === "tree" ? "JSON, " : ""}${[
        ["pretty", "pretty"],
        ...(b.json || view === "tree" ? [["tree", "tree"]] : []),
        ["raw", "raw"],
      ].map(([v, l], i) => html`${i ? " · " : ""}${v === cur ? html`<strong>${l}</strong>` : html`<a href="${sentHref(s.id, v === "pretty" ? undefined : v)}">${l}</a>`}`)}</span>`;
    const location = r.headers.find(([k]) => k === "location")?.[1];
    return html`${KeyValues([
      ["Status", html`${Pill({ tone: statusTone(r.status), children: String(r.status) })} ${r.statusText}`],
      ["Time", `${r.ms} ms`],
      ["Size", `${sizeText(r.size)}${r.truncated ? " (cut off: only the first part was read)" : ""}`],
      ...(location ? ([["Redirects to", html`<code>${location}</code> <span class="t3">(not followed)</span>`]] as [Child, Child][]) : []),
    ])}
${debug}
${prev?.resp ? html`<p class="notes">Sent before at ${clock(prev.at)}${prev.resp.status !== r.status ? html` (then ${prev.resp.status})` : ""}: <a href="${sentHref(s.id, "diff")}">compare with it</a></p>` : ""}
<h3 class="sub-h">Body${r.binary || !r.body ? "" : views(parsed?.ok ? "tree" : view === "raw" ? "raw" : "pretty")}</h3>
${r.binary ? html`<p class="notes">${sizeText(r.size)} of ${ct || "binary data"}: not shown.</p>` : !r.body ? html`<p class="notes">No body.</p>` : parsed?.ok ? tree(parsed.value) : html`<pre class="output" data-copy>${b.text}</pre>`}
<h3 class="sub-h">Headers</h3>
${r.headers.length ? html`<div class="sheet"><table class="data"><tbody>${r.headers.map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td class="mono">${v}</td></tr>`)}</tbody></table></div>` : html`<p class="notes">None.</p>`}`;
  };
  return html`<div data-live id="http-sent-${s.id}">${Panel({
    title: "Response",
    meta: html`<span class="t3"><strong>${s.out.method}</strong> <span class="mono">${s.out.url}</span></span>`,
    children: inner(),
  })}</div>`;
}

const HTONE = { added: "ok", removed: "bad", changed: "warn" } as const;

/** This response against the send before it: what changed in the status, the headers and the body. */
export function comparePanel(s: Sent, prev: Sent | undefined): Html {
  if (!s.resp || !prev?.resp)
    return Panel({ title: "Compared with the send before", children: html`<p class="notes">No earlier send of ${s.out.method} <code>${s.out.url}</code> came back in this session's history.</p>` });
  const c = compare(prev.resp, s.resp);
  const body =
    c.body.kind === "json"
      ? changesList(c.body.changes, c.body.more)
      : c.body.kind === "binary"
        ? html`<p class="notes">${c.body.same ? "The same bytes." : "Different bytes (binary: not compared further)."}</p>`
        : html`<p class="notes">${c.body.same ? "The same text." : `Different text: ${sizeText(c.body.before)} before, ${sizeText(c.body.after)} now.`}${c.body.same ? "" : " Only JSON bodies are compared key by key."}</p>`;
  return Panel({
    title: "Compared with the send before",
    meta: html`<span class="t3">${clock(prev.at)} → ${clock(s.at)} · <a href="${sentHref(prev.id)}">that response</a></span>`,
    children: html`${KeyValues([
      ["Status", c.status ? html`${Pill({ tone: statusTone(c.status.before), children: String(c.status.before) })} → ${Pill({ tone: statusTone(c.status.after), children: String(c.status.after) })}` : html`<span class="t3">the same (${s.resp.status})</span>`],
      ["Time", `${prev.resp.ms} ms → ${s.resp.ms} ms`],
    ])}
<h3 class="sub-h">Headers</h3>
${c.headers.length ? html`<div class="sheet"><table class="data"><tbody>${c.headers.map(
      (h) => html`<tr><th scope="row" class="mono">${h.name}</th><td>${Pill({ tone: HTONE[h.kind], children: h.kind })}</td><td class="mono">${h.kind === "added" ? "" : h.before}</td><td class="mono">${h.kind === "removed" ? "" : h.after}</td></tr>`,
    )}</tbody></table></div>` : html`<p class="notes">The same headers.</p>`}
<h3 class="sub-h">Body</h3>
${body}`,
  });
}

const clock = (at: number) => `${new Date(at).toISOString().slice(11, 19)} UTC`;

export function sentPage(o: HomeOpts & { sent: Sent; view: string; prev?: Sent }): Html {
  return html`${PageHeader({ title: o.sent.req.name || `${o.sent.out.method} request`, sub: html`<span class="mono">${o.sent.out.url}</span>`, crumbs })}
${o.view === "diff" ? comparePanel(o.sent, o.prev) : ""}
${responseRegion(o.sent, o.view === "diff" ? "pretty" : o.view, o.prev)}
${Panel({ title: "Sent", children: o.sent.out.headers.length ? html`<div class="sheet"><table class="data"><tbody>${o.sent.out.headers.map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td class="mono">${v}</td></tr>`)}</tbody></table></div>` : html`<p class="notes">No headers of its own.</p>` })}
${editor(o)}`;
}

/** Saving over what's in a file: what will change, and the second click. */
export function confirmSavePage(o: { req: Req; where: Where; replacing?: string; problem?: string }): Html {
  const w = o.where;
  return html`${PageHeader({ title: "Save the request", crumbs })}
${o.problem ? Notice({ tone: "warn", children: o.problem }) : ""}
${Panel({
  title: html`${w.repo}/.http/${w.file}`,
  children: html`<p>${o.replacing ? html`This replaces <strong>${o.replacing}</strong> in <code>${w.file}</code> with the request below.` : html`This adds the request below to <code>${w.file}</code>.`} It's checked again before it's written: if the file changed meanwhile, nothing is.</p>
${Confirm({ kind: "http.replace", action: "/http/save", fields: { ...formFields(o.req, w), confirm: "1" }, label: "Save", question: html`Write <code>${w.repo}/.http/${w.file}</code>?` })}
<p><a href="${homeHref({ repo: w.repo, file: w.opened, n: w.n, env: w.env })}">Back without saving</a></p>`,
})}`;
}

export const fileOk = (f: string) => FILE_RE.test(f) && !f.includes("..");

type Html = ReturnType<typeof html>;

// ── Runs ────────────────────────────────────────────────────────────────────────────────────

export type PlanItem = { method: string; name: string; target: { ok: boolean; text: string }; checks: { text: string; error?: string }[] };

/** What a run of the file will send, before anything is: the second step is one click. */
export function runPlanPage(o: { repo: string; file: string; env: string; envs: string[]; hash: string; items: PlanItem[]; more: number; problem?: string }): Html {
  const unsure = o.items.flatMap((x) => x.checks.filter((c) => c.error));
  const writes = o.items.filter((x) => !["GET", "HEAD", "OPTIONS"].includes(x.method)).length;
  return html`${PageHeader({ title: html`Run ${o.file}`, sub: html`<span class="mono">${o.repo}/.http/${o.file}</span>: ${o.items.length} request${o.items.length === 1 ? "" : "s"}, one after the other`, crumbs })}
${o.problem ? Notice({ tone: "warn", children: o.problem }) : ""}
${o.more ? Notice({ tone: "warn", children: `Only the first ${MAX_RUN} requests run: ${o.more} more are left out.` }) : ""}
${unsure.length ? Notice({ tone: "warn", children: `${unsure.length} check${unsure.length === 1 ? "" : "s"} can't be read and will fail: fix ${unsure.length === 1 ? "it" : "them"} in the file.` }) : ""}
${Panel({
  title: "Run",
  children: html`<form method="get" action="/http/run" class="fields"><input type="hidden" name="repo" value="${o.repo}"><input type="hidden" name="file" value="${o.file}"><label class="field"><span class="label">Environment</span><select name="env"><option value="">None</option>${options(o.envs, o.env)}</select></label><div class="buttons"><button type="submit">Show it with this</button></div></form>
<form method="post" action="/http/run"><input type="hidden" name="repo" value="${o.repo}"><input type="hidden" name="file" value="${o.file}"><input type="hidden" name="env" value="${o.env}"><input type="hidden" name="hash" value="${o.hash}">
<div class="buttons"><button type="submit" class="primary" data-busy="Running">Run ${o.items.length} request${o.items.length === 1 ? "" : "s"}</button></div></form>
<p class="notes">Each goes out from this machine as a send does (no redirects followed, 30 s at most), shows in history and is logged.${writes ? html` <strong>${writes} of them ${writes === 1 ? "isn't a read" : "aren't reads"}</strong> (POST, PUT, PATCH or DELETE): they change things wherever they go.` : ""} A request that can't go (a missing variable, a secret's wrong host) fails without being sent; the rest still run.</p>`,
})}
${Panel({
  title: "Requests",
  children: html`<ol class="list">${o.items.map(
    (x) =>
      html`<li class="item"><strong>${x.method}</strong> ${x.name} ${x.target.ok ? html`<span class="t3 mono">${x.target.text}</span>` : html`<span class="t3">${x.target.text}</span>`}${x.checks.length ? html`<ul class="list">${x.checks.map((c) => html`<li class="item mono">${c.text}${c.error ? html` <span class="t3">(${c.error})</span>` : ""}</li>`)}</ul>` : html` <span class="t3">· any status below 400</span>`}</li>`,
  )}</ol>`,
})}
<p><a href="${homeHref({ repo: o.repo, env: o.env })}">Back</a></p>`;
}

const stepPill = (s: Step) =>
  s.state === "passed" ? Pill({ tone: "ok", children: "passed" }) : s.state === "failed" ? Pill({ tone: "bad", children: "failed" }) : Pill({ tone: "neutral", children: s.state === "sending" ? "sending" : "waiting" });

/** A run's results, swapped in place as each request comes back. */
export function runRegion(r: Run, hasSent: (id: string) => boolean): Html {
  const ok = passed(r);
  const bad = failedSteps(r);
  const summary =
    r.state === "running"
      ? html`<p class="notes" data-pending><span class="spinner"></span> Running: ${ok + bad} of ${r.steps.length} done${bad ? `, ${bad} failed` : ""}…</p>`
      : Notice({ tone: bad ? "bad" : "ok", children: bad ? `${bad} of ${r.steps.length} failed.` : `All ${r.steps.length} passed.` });
  return html`<div data-live id="http-run-${r.id}">${summary}${Panel({
    title: "Requests",
    meta: html`<span class="t3">${r.env ? `environment ${r.env}` : "no environment"}</span>`,
    children: html`<ol class="list">${r.steps.map(
      (s) =>
        html`<li class="item">${stepPill(s)} <strong>${s.method}</strong> ${s.sentId && hasSent(s.sentId) ? html`<a href="${sentHref(s.sentId)}">${s.name || s.url}</a>` : s.name || s.url}${s.name ? html` <span class="t3 mono">${s.url}</span>` : ""}${s.status !== undefined ? html` <span class="t3">· ${s.status} · ${s.ms} ms</span>` : ""}
${s.error ? html`<p class="notes">${s.error}</p>` : ""}${s.checks.length ? html`<ul class="list">${s.checks.map((c) => html`<li class="item">${Pill({ tone: c.ok ? "ok" : "bad", children: c.ok ? "ok" : "no" })} <span class="mono">${c.text}</span>${c.got !== undefined ? html` <span class="t3">got ${c.got}</span>` : ""}</li>`)}</ul>` : ""}</li>`,
    )}</ol>`,
  })}</div>`;
}

export function runPage(r: Run, hasSent: (id: string) => boolean): Html {
  return html`${PageHeader({ title: html`Run ${r.file}`, sub: html`<span class="mono">${r.repo}/.http/${r.file}</span> · ${clock(r.at)}`, crumbs })}
${runRegion(r, hasSent)}
<div class="buttons"><a class="btn sm" href="${runHref({ repo: r.repo, file: r.file, env: r.env })}">Run it again</a> <a class="btn sm ghost" href="${homeHref({ repo: r.repo, env: r.env })}">Back to the client</a></div>`;
}

