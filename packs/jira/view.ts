/** Jira Pack (`jira`) views. */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import type { JiraKept } from "./data.ts";

function renderIssues(k: JiraKept) {
  return List(
    k.issues.map((i) =>
      Item({
        href: safeUrl(i.url),
        title: html`<strong>${i.key}</strong> ${i.summary}`,
        line: i.priority ? `${i.status} · ${i.priority}` : i.status,
        trail: Pill({ children: i.status }),
      }),
    ),
  );
}

export function jiraPage(k: JiraKept | undefined) {
  return html`${PageHeader({ title: "Jira", sub: k?.site ? `Open issues on ${k.site}` : "Open assigned issues" })}
<div data-live id="jira">
${k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Jira unavailable" }) : ""}
${Panel({
  title: "Assigned to you",
  meta: k ? String(k.issues.length) : "loading",
  flush: true,
  children: k?.issues.length ? renderIssues(k) : Empty({ title: k ? "No open Jira issues" : "Not read yet" }),
})}
</div>`;
}

export function jiraCard(k: JiraKept) {
  return Card({
    id: "jira-now",
    title: "Jira",
    meta: html`<a href="/jira">Open</a>`,
    children: k.issues.length ? renderIssues(k) : html`<p class="t2">${k.ok ? "No open issues assigned to you" : k.error ?? "Jira unavailable"}</p>`,
  });
}
