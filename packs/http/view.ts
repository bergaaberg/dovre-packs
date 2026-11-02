/**
 * HTTP client (`http`) views. Everything a response brings (status text, headers, body) is
 * hostile: it's only ever interpolated into html`…` (escaped), a body is text in a <pre> whatever
 * its type (an HTML page shows as its source), and links are built from paths through safeUrl.
 */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { type Child, Confirm, KeyValues, Notice, PageHeader, Panel, Pill, type Tone } from "dovre/ui/kit.ts";
import { FILE_RE } from "./files.ts";
import { headersText, MAX_BODY_IN, type Req } from "./model.ts";
import type { Sent } from "./send.ts";
import { compare } from "./compare.ts";
import { parse } from "../json/tools.ts";
import { changesList, tree } from "../json/view.ts";
import { type Imported, MAX_SPEC } from "./openapi.ts";
import { agentHref, debugPrompt, failing } from "./agent.ts";

/** Where the editor's request is from: the environment, the repo and file it's saved to, and the file it was opened from (`opened`, its request `n`, the file's `hash` then). */
export type Where = { env: string; repo: string; file: string; opened: string; n: string; hash: string };
export const noWhere = (): Where => ({ env: "", repo: "", file: "", opened: "", n: "", hash: "" });

export const homeHref = (q: Partial<Where> & { saved?: string } = {}) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return safeUrl(`/http${p ? `?${p}` : ""}`);
};
export const sentHref = (id: string, view?: string) => safeUrl(`/http/r/${encodeURIComponent(id)}${view ? `?view=${encodeURIComponent(view)}` : ""}`);

const crumbs = [{ href: "/http", label: "HTTP" }];

export const statusTone = (status: number): Tone => (status >= 500 ? "bad" : status >= 400 ? "warn" : status >= 300 ? "neutral" : "ok");

const sizeText = (n: number) => (n < 1000 ? `${n} B` : n < 1_000_000 ? `${(n / 1000).toFixed(1)} kB` : `${(n / 1_000_000).toFixed(2)} MB`);

const options = (values: readonly string[], current: string, label: (v: string) => string = (v) => v) => values.map((v) => html`<option value="${v}"${v === current ? html` selected` : ""}>${label(v)}</option>`);

/** A request's fields as hidden inputs (a Confirm's second click posts them again; Open posts them to the Quick view). */
export function formFields(r: Req, w: Where): Record<string, string> {
  return { name: r.name, method: r.method, url: r.url, headers: headersText(r.headers), query: r.query.join("\n"), mode: r.mode, body: r.body, expect: (r.expect ?? []).join("\n"), env: w.env, repo: w.repo, file: w.file, opened: w.opened, n: w.n, hash: w.hash };
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

/** Pasted text into requests: a curl command, or a spec or collection. Nothing is sent or fetched. */
export function importPage(o: { flash?: { tone: Tone; text: Child }; curl?: string; spec?: string }): Html {
  return html`${PageHeader({ title: "Import requests", sub: "Read here: nothing is sent or fetched", crumbs })}
${o.flash ? Notice({ tone: o.flash.tone, children: o.flash.text }) : ""}
<div class="grid-2">${importPanel(o.curl)}${openapiPanel(o.spec)}</div>
<p><a href="/http">Back to the client</a></p>`;
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

/** Back to the Quick view with this request: its case when it came from a file, else the request as it was sent (secrets as placeholders). */
function openAgain(s: Sent): Html {
  if (s.from.repo && s.from.file) return html`<p><a href="${homeHref({ repo: s.from.repo, env: s.from.env, file: s.from.file, n: s.from.n })}">Open it in the client</a> to change it or send it again.</p>`;
  return html`<form method="post" action="/http/open" class="inline">${Object.entries(formFields(s.req, { ...noWhere(), env: s.from.env, repo: s.from.repo })).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit">Open in the client</button></form>`;
}

export function sentPage(o: { sent: Sent; view: string; prev?: Sent }): Html {
  return html`${PageHeader({ title: o.sent.req.name || `${o.sent.out.method} request`, sub: html`<span class="mono">${o.sent.out.url}</span>`, crumbs })}
${o.view === "diff" ? comparePanel(o.sent, o.prev) : ""}
${responseRegion(o.sent, o.view === "diff" ? "pretty" : o.view, o.prev)}
${Panel({ title: "Sent", children: o.sent.out.headers.length ? html`<div class="sheet"><table class="data"><tbody>${o.sent.out.headers.map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td class="mono">${v}</td></tr>`)}</tbody></table></div>` : html`<p class="notes">No headers of its own.</p>` })}
${openAgain(o.sent)}`;
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
