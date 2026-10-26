/**
 * Jira Pack (`jira`): filing a ticket. Pick the work type, fill what the project's create screen
 * asks for, preview, create (the preview's Create is the second click). Drawn inside Dovre's shell
 * by the pack's routes (index.ts).
 */
import { html } from "hono/html";
import { Link, MyListBox, safeUrl } from "dovre/pages/parts.ts";
import { hidden, rows, star, wrap } from "dovre/pages/work.ts";
import { type Html, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Tabs } from "dovre/ui/kit.ts";
import { type CreateType, MAX_SUMMARY, nameOf, shown, type Ticket, type TicketErrors, type TicketField, ticketPairs } from "./tickets.ts";

export const NEW = "/jira/new";
export const newHref = (project?: string, type?: string) => safeUrl(`${NEW}${project ? `?project=${encodeURIComponent(project)}${type ? `&type=${encodeURIComponent(type)}` : ""}` : ""}`);
const browse = (site: string, key: string) => safeUrl(`https://${site}/browse/${encodeURIComponent(key)}`);
const crumbs = (label: string) => [{ href: "/jira", label: "Jira" }, { label }];

/** The pages' live region: a job that's still reading or writing marks it pending, and the page fills itself in when it lands. */
const live = (body: Html | string, pending = false) => html`<div data-live id="jira-ticket"${pending ? html` data-pending` : ""}>${body}</div>`;

/** New work's "work.new" slot, and /jira/new with no project: where a ticket can go. */
export function projectsPanel(projects: string[]): Html | "" {
  if (!projects.length) return "";
  return Panel({
    title: "A ticket in Jira",
    flush: true,
    children: List(projects.map((p) => Item({ href: newHref(p), title: html`<strong>Ticket</strong> in ${p}`, line: "What the business asks for: a story, a bug, an improvement. Fields come live from Jira." }))),
  });
}

/** "Or let an agent file it": the note goes to /agents/new, which shows the prompt before anything starts. */
export function agentPanel(project: string): Html {
  return Panel({
    title: "Or let an agent file it",
    children: html`<form method="post" action="${NEW}/draft">${hidden([["project", project]])}<div class="field"><label class="label" for="note">Describe it roughly</label><textarea id="note" name="note" rows="4" maxlength="4000" required></textarea><span class="hint">Claude Code files it through its Atlassian MCP, after your go. You see the prompt before it starts.</span></div><div class="buttons"><button type="submit">Draft with an agent…</button></div></form>`,
  });
}

export function noProjectsBody(): Html {
  return html`${PageHeader({ title: "New ticket", crumbs: crumbs("New ticket") })}
${Notice({ tone: "warn", children: html`No project to file in. Set <code>TICKET_PROJECTS</code> (Jira keys, comma-separated) on the Packs page.` })}`;
}

export function pickProjectBody(projects: string[]): Html {
  return html`${PageHeader({ title: "New ticket", sub: "Which project?", crumbs: crumbs("New ticket") })}${projectsPanel(projects)}`;
}

/** The create screen is being read (an agent job, ~15 s): the page fills itself in when it lands. */
export function loadingBody(project: string): Html {
  return html`${PageHeader({ title: `Ticket in ${project}`, crumbs: crumbs("New ticket") })}
${live(html`<p class="t2">Reading ${project}'s create screen from Jira. It takes about 15 seconds through Claude Code, and fills in by itself.</p>`, true)}
${agentPanel(project)}`;
}

/** Jira's types didn't load, or there are none to create. */
export function failedBody(site: string, project: string, error: string | undefined): Html {
  return html`${PageHeader({ title: `Ticket in ${project}`, crumbs: crumbs("New ticket") })}
${live(Notice({ tone: "bad", children: error === undefined ? html`Jira offers no work types to create in ${project}.` : html`<strong>Jira's work types for ${project} didn't load.</strong> ${error}` }))}
<div class="buttons"><a class="btn" href="${newHref(project)}">Try again</a>${Link(browse(site, project), `Open ${project} in Jira`, "btn ghost")}</div>
${agentPanel(project)}`;
}

function fieldHtml(f: TicketField, value: string, err?: string): Html {
  const id = nameOf(f);
  const label = html`<label class="label" for="${id}">${f.name}${star(f.required)}</label>`;
  const invalid = err ? html` aria-invalid="true"` : "";
  const req = f.required ? html` required` : "";
  if (f.kind === "select") {
    const none = f.required && f.default === undefined ? html`<option value="">Pick one…</option>` : f.required ? "" : html`<option value="">None</option>`;
    return wrap(err, html`${label}<select id="${id}" name="${id}"${req}${invalid}>${none}${f.options.map((o) => html`<option value="${o.id}"${o.id === value ? html` selected` : ""}>${o.label}</option>`)}</select>`);
  }
  if (f.kind === "line") return wrap(err, html`${label}<input type="text" id="${id}" name="${id}" value="${value}" maxlength="${MAX_SUMMARY}"${req}${invalid}>`);
  return wrap(err, html`${label}<span class="hint">Plain text; a blank line starts a new paragraph.</span><textarea id="${id}" name="${id}" rows="${rows(value, 8)}"${req}${invalid}>\n${value}</textarea>`);
}

export function formBody(o: { project: string; types: CreateType[]; ticket: Ticket; fields: TicketField[]; blocked: string[]; errors?: TicketErrors; fieldsFailed?: string }): Html {
  const t = o.ticket;
  const e = o.errors ?? {};
  const n = Object.values(e).filter(Boolean).length;
  const tabs = Tabs({ label: "Work type", items: o.types.map((ty) => ({ href: newHref(o.project, ty.id), label: ty.name, current: ty.id === t.type.id })) });
  const form = o.fieldsFailed
    ? ""
    : o.blocked.length
      ? Notice({ tone: "bad", children: html`Jira requires ${o.blocked.join(", ")} for a ${t.type.name}, which this form can't fill. Create it in Jira, or let an agent do it.` })
      : html`<form method="post" action="${NEW}/preview">${hidden([["project", o.project], ["type", t.type.id]])}
${o.fields.map((f) => fieldHtml(f, t.values[f.id] ?? "", e[f.id]))}
<div class="buttons"><button type="submit" class="primary">Preview</button></div>
</form>`;
  return html`${PageHeader({ title: `Ticket in ${o.project}`, sub: "What the business asks for.", crumbs: crumbs("New ticket"), tabs })}
${live(html`${n ? Notice({ tone: "bad", children: `${n} ${n === 1 ? "thing needs" : "things need"} fixing before the preview.` }) : ""}
${o.fieldsFailed ? Notice({ tone: "bad", children: html`<strong>The ${t.type.name} fields didn't load.</strong> ${o.fieldsFailed}` }) : ""}
${t.type.description ? html`<p class="t2">${t.type.description}</p>` : ""}`)}
${Panel({ title: html`A ${t.type.name}`, meta: "fields from Jira, live", children: form })}
${agentPanel(o.project)}`;
}

const paragraphs = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => html`<p>${p.split("\n").map((line, i) => html`${i ? html`<br>` : ""}${line}`)}</p>`);

export function previewBody(o: { ticket: Ticket; fields: TicketField[]; nonce: string; problem?: string }): Html {
  const t = o.ticket;
  const summary = o.fields.find((f) => f.kind === "line");
  const description = o.fields.find((f) => f.kind === "paragraph");
  const selects = o.fields.filter((f) => f.kind === "select");
  const kv = KeyValues([
    ["Project", t.project],
    ["Type", Pill({ children: t.type.name })],
    ["Summary", html`<strong>${summary ? t.values[summary.id]?.trim() : ""}</strong>`],
    ...selects.map((f): [string, Html | string] => [f.name, shown(f, t) || html`<span class="t3">${f.default ? "Jira's default" : "none"}</span>`]),
  ]);
  const body = description && t.values[description.id]?.trim() ? paragraphs(t.values[description.id]!) : html`<p class="t3">No description.</p>`;
  const actions = html`<form method="post" action="${NEW}/create">${hidden([...ticketPairs(t, o.fields), ["nonce", o.nonce]])}${MyListBox}<div class="buttons"><button type="submit" formaction="${NEW}/preview" name="edit" value="1">Edit</button><button type="submit" class="primary">Create ticket</button></div></form>`;
  return html`${PageHeader({ title: "Preview", sub: html`Nothing is created until <strong>Create ticket</strong>.`, crumbs: crumbs("New ticket") })}
${o.problem ? Notice({ tone: "bad", children: o.problem }) : ""}
${Panel({ title: "What will be created", children: html`${kv}${body}`, foot: actions })}`;
}

/** The create is running (a fresh check, then the write): the page fills itself in when it lands. */
export function workingBody(o: { project: string; summary: string }): Html {
  return html`${PageHeader({ title: "Creating the ticket", crumbs: crumbs("New ticket") })}
${live(html`<p class="t2">Checking ${o.project} in Jira again, then creating <strong>${o.summary}</strong>. Through Claude Code it takes up to half a minute; this page fills in by itself.</p>`, true)}`;
}

export function doneBody(o: { site: string; key: string; warning?: string }): Html {
  const url = browse(o.site, o.key);
  return html`${PageHeader({ title: "Ticket created", crumbs: crumbs("New ticket") })}
${live(html`${Notice({ tone: "ok", children: html`Created ${Link(url, o.key)}.` })}${o.warning ? Notice({ tone: "warn", children: o.warning }) : ""}`)}
<div class="buttons">${Link(url, "Open it in Jira", "btn primary")}<a class="btn ghost" href="${newHref(o.key.slice(0, o.key.lastIndexOf("-")))}">Another ticket</a></div>`;
}

export function problemBody(message: Html | string, back = NEW): Html {
  return html`${PageHeader({ title: "New ticket", crumbs: crumbs("New ticket") })}${Notice({ tone: "bad", children: message })}<div class="buttons"><a class="btn" href="${safeUrl(back)}">Start over</a></div>`;
}
