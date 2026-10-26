/** Jira Pack (`jira`) views. */
import { html } from "hono/html";
import { Ago, safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill, Post } from "dovre/ui/kit.ts";
import type { JiraIssue, JiraKept, JiraSetup } from "./data.ts";

const tone = (i: JiraIssue) => (i.category === "done" ? "ok" : i.category === "indeterminate" ? "warn" : undefined);

const issueItem = (i: JiraIssue, showAssignee: boolean) =>
  Item({
    href: safeUrl(i.url),
    title: html`<strong>${i.key}</strong> ${i.summary}`,
    line: html`${[i.type, i.priority].filter(Boolean).join(" · ")}${showAssignee ? html` · ${i.assignee ?? "unassigned"}` : ""}`,
    trail: html`${Pill({ tone: tone(i), children: i.status })}${i.updated ? Ago(i.updated) : ""}`,
  });

/** Jira through the MCP isn't answering yet: what to do about it. */
export function setupNote(setup: JiraSetup, error: string) {
  if (setup === "waiting") return html`<p class="t2">Asking Jira through Claude Code's Atlassian MCP. It takes about 15 seconds, and fills in by itself.</p>`;
  const how =
    setup === "no-claude"
      ? html`Jira goes through Claude Code's Atlassian MCP here (<code>JIRA_VIA=mcp</code>), and Claude Code isn't installed. Install it, or set <code>JIRA_VIA=off</code>.`
      : html`Claude Code's Atlassian MCP isn't signed in. Run <code>claude</code> in a terminal, type <code>/mcp</code>, pick <strong>atlassian</strong> and sign in; Dovre asks again on its next round, or at once with Read now.`;
  return Notice({ tone: "warn", children: html`<strong>Jira isn't reachable yet.</strong> ${how} <span class="t3">(${error})</span>` });
}

export function jiraPage(k: JiraKept | undefined, opts: { refresh?: boolean } = {}) {
  const byProject = new Map<string, JiraIssue[]>();
  for (const i of k?.moving ?? []) byProject.set(i.project, [...(byProject.get(i.project) ?? []), i]);
  const sub = k?.ok ? `${k.mine.length} assigned to you and not done${k.moving.length ? `; ${k.moving.length} moved in the last 3 days` : ""}.` : k?.site ? `On ${k.site}` : "Open assigned issues";
  return html`${PageHeader({ title: "Jira", sub })}
<div data-live id="jira">
${k?.setup ? setupNote(k.setup, k.error ?? "") : k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Jira unavailable" }) : ""}
${Panel({
  title: "Mine, not done",
  meta: k ? html`${String(k.mine.length)}${k.at ? html` · ${Ago(k.at)}` : ""}` : "loading",
  flush: true,
  children: k?.mine.length ? List(k.mine.map((i) => issueItem(i, false))) : Empty({ title: k?.ok ? "Nothing assigned to you" : "Not read yet" }),
})}
${[...byProject].map(([project, list]) => Panel({ title: `Moving in ${project}`, meta: String(list.length), flush: true, children: List(list.map((i) => issueItem(i, true))) }))}
</div>
${opts.refresh ? Post({ action: "/jira/refresh", label: "Read now" }) : ""}`;
}

export function jiraCard(k: JiraKept) {
  return Card({
    id: "jira-now",
    title: "Jira",
    meta: html`<a href="/jira">Open</a>`,
    children: k.mine.length
      ? List(k.mine.slice(0, 8).map((i) => issueItem(i, false)))
      : html`<p class="t2">${k.ok ? "No open issues assigned to you" : k.setup === "waiting" ? "Asking Jira…" : (k.error ?? "Jira unavailable")}</p>`,
  });
}
