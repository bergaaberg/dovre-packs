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

/** The editor's fields as hidden inputs (a Confirm's second click posts them again). */
export function formFields(r: Req, w: Where): Record<string, string> {
  return { name: r.name, method: r.method, url: r.url, headers: headersText(r.headers), query: r.query.join("\n"), mode: r.mode, body: r.body, env: w.env, repo: w.repo, file: w.file, opened: w.opened, n: w.n, hash: w.hash };
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

function savedPanel(o: { repos: string[]; repo: string; files: FileInfo[] | undefined; env: string }): Html {
  const pick = html`<form method="get" action="/http" class="fields"><label class="field"><span class="label">Repo</span><select name="repo">${o.repos.length ? "" : html`<option value="">No checkouts under CODE_DIR</option>`}${options(o.repos, o.repo)}</select></label>${o.env ? html`<input type="hidden" name="env" value="${o.env}">` : ""}<div class="buttons"><button type="submit">Open</button></div></form>`;
  const list = !o.repo
    ? ""
    : !o.files?.length
      ? Empty({ title: "No .http files yet", children: html`<p>Save a request to start <code>${o.repo}/.http/</code>.</p>` })
      : html`${o.files.map(
          (f) =>
            html`<h3 class="sub-h">${f.name}</h3>${f.error ? Notice({ tone: "warn", children: f.error }) : ""}<ul class="list">${f.reqs.map(
              (q, i) =>
                html`<li class="item"><a href="${homeHref({ repo: o.repo, file: f.name, n: String(i), env: o.env })}"><strong>${q.method}</strong> ${q.name || q.url}</a>${q.name ? html` <span class="t3 mono">${q.url}</span>` : ""}</li>`,
            )}</ul>`,
        )}`;
  return Panel({ title: "Saved in repos", children: html`${pick}${list}` });
}

function historyPanel(list: Sent[]): Html {
  return Panel({
    title: "History",
    meta: html`<span class="t3">this session, in memory</span>`,
    children: list.length
      ? html`<ul class="list">${list.map(
          (s) =>
            html`<li class="item"><a href="${sentHref(s.id)}">${s.state === "done" && s.resp ? Pill({ tone: statusTone(s.resp.status), children: String(s.resp.status) }) : Pill({ tone: s.state === "failed" ? "bad" : "neutral", children: s.state === "failed" ? "failed" : "…" })} <strong>${s.out.method}</strong> <span class="mono">${s.out.url}</span></a></li>`,
        )}</ul>`
      : Empty({ title: "Nothing sent yet" }),
  });
}

export type HomeOpts = EditorOpts & { files?: FileInfo[]; history: Sent[]; flash?: { tone: Tone; text: Child }; curl?: string; curlOut?: string };

export function homePage(o: HomeOpts): Html {
  return html`${PageHeader({ title: "HTTP client", sub: "Requests from this machine, saved as .http files in your repos", crumbs })}
${o.flash ? Notice({ tone: o.flash.tone, children: o.flash.text }) : ""}
${o.curlOut !== undefined ? Panel({ title: "As curl", children: html`<pre class="output" data-copy>${o.curlOut}</pre><p class="notes">Secrets stay shell variables ($NAME): set them in your shell to run it.</p>` }) : ""}
${editor(o)}
<div class="grid-2">${savedPanel({ repos: o.repos, repo: o.where.repo, files: o.files, env: o.where.env })}${historyPanel(o.history)}</div>
${importPanel(o.curl)}`;
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

export function responseRegion(s: Sent, view: string): Html {
  const inner = (): Child => {
    if (s.state === "sending") return html`<p class="notes" data-pending><span class="spinner"></span> Sending ${s.out.method} <code>${s.out.url}</code>…</p>`;
    if (s.state === "failed" || !s.resp) return Notice({ tone: "bad", children: html`Nothing came back from <code>${s.out.url}</code>: ${s.error ?? "it failed"}.` });
    const r = s.resp;
    const ct = r.headers.find(([k]) => k === "content-type")?.[1] ?? "";
    const b = bodyText(r.body, ct, view);
    const location = r.headers.find(([k]) => k === "location")?.[1];
    return html`${KeyValues([
      ["Status", html`${Pill({ tone: statusTone(r.status), children: String(r.status) })} ${r.statusText}`],
      ["Time", `${r.ms} ms`],
      ["Size", `${sizeText(r.size)}${r.truncated ? " (cut off: only the first part was read)" : ""}`],
      ...(location ? ([["Redirects to", html`<code>${location}</code> <span class="t3">(not followed)</span>`]] as [Child, Child][]) : []),
    ])}
<h3 class="sub-h">Body${b.json ? html` <span class="t3">JSON, pretty · <a href="${sentHref(s.id, "raw")}">raw</a></span>` : view === "raw" ? html` <span class="t3"><a href="${sentHref(s.id)}">pretty</a></span>` : ""}</h3>
${r.binary ? html`<p class="notes">${sizeText(r.size)} of ${ct || "binary data"}: not shown.</p>` : r.body ? html`<pre class="output" data-copy>${b.text}</pre>` : html`<p class="notes">No body.</p>`}
<h3 class="sub-h">Headers</h3>
${r.headers.length ? html`<div class="sheet"><table class="data"><tbody>${r.headers.map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td class="mono">${v}</td></tr>`)}</tbody></table></div>` : html`<p class="notes">None.</p>`}`;
  };
  return html`<div data-live id="http-sent-${s.id}">${Panel({
    title: "Response",
    meta: html`<span class="t3"><strong>${s.out.method}</strong> <span class="mono">${s.out.url}</span></span>`,
    children: inner(),
  })}</div>`;
}

export function sentPage(o: HomeOpts & { sent: Sent; view: string }): Html {
  return html`${PageHeader({ title: o.sent.req.name || `${o.sent.out.method} request`, sub: html`<span class="mono">${o.sent.out.url}</span>`, crumbs })}
${responseRegion(o.sent, o.view)}
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
${Confirm({ action: "/http/save", fields: { ...formFields(o.req, w), confirm: "1" }, label: "Save", question: html`Write <code>${w.repo}/.http/${w.file}</code>?` })}
<p><a href="${homeHref({ repo: w.repo, file: w.opened, n: w.n, env: w.env })}">Back without saving</a></p>`,
})}`;
}

export const fileOk = (f: string) => FILE_RE.test(f) && !f.includes("..");

type Html = ReturnType<typeof html>;
