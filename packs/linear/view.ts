/** Linear Pack (`linear`) views. */
import { html } from "hono/html";
import { type Html, Card, Empty, Gauge, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import { Link, safeUrl } from "dovre/pages/parts.ts";
import { type LinearIssue, type LinearKept, PRIORITY } from "./data.ts";

const stateTone = (i: LinearIssue): "ok" | "warn" | "accent" | "neutral" => {
  if (/review/i.test(i.state)) return "accent";
  if (/progress|started/i.test(i.state)) return "ok";
  if (/todo|backlog|triage/i.test(i.state)) return "warn";
  return "neutral";
};

/** The order the page groups states in: working states first, then whatever else came back. */
const STATE_ORDER = ["In Progress", "In Review", "Todo"];

function issueItem(i: LinearIssue) {
  return Item({
    href: safeUrl(i.url),
    title: html`<strong>${i.key}</strong> ${i.title}`,
    line: [i.project, i.cycle ? `Cycle ${i.cycle}` : undefined].filter(Boolean).join(" · "),
    trail: html`${Pill({ tone: stateTone(i), children: i.state })} ${Pill({ tone: "neutral", children: PRIORITY[i.priority] ?? "No priority" })}`,
  });
}

function issueList(issues: LinearIssue[]) {
  return List(issues.map(issueItem));
}

function cyclePanel(k: LinearKept) {
  return k.teams
    .filter((t) => t.cycle)
    .map((t) => {
      const c = t.cycle!;
      const ends = c.endsAt ? ` · ends ${new Date(c.endsAt).toLocaleDateString()}` : "";
      return Panel({
        title: `${t.name} · Cycle ${c.number}`,
        meta: `${c.completed}/${c.issues}`,
        children: html`<div class="t2">${c.progress}% complete${ends}</div>
${Gauge({ value: c.completed, max: c.issues, tone: c.progress >= 80 ? "ok" : "accent", title: `${c.completed} of ${c.issues} issues done` })}`,
      });
    });
}

function untriagedPanel(k: LinearKept) {
  const untriaged = k.teams.flatMap((t) => t.untriaged.map((i) => i));
  if (!untriaged.length) return "";
  return Panel({
    title: "Un-triaged",
    meta: String(untriaged.length),
    flush: true,
    children: List(
      untriaged.map((i) =>
        Item({ href: safeUrl(i.url), title: html`<strong>${i.key}</strong> ${i.title}`, line: `${i.team} · ${i.state}`, trail: Pill({ tone: "warn", children: "No priority" }) }),
      ),
    ),
  });
}

export function linearPage(k: LinearKept | undefined) {
  const groups = new Map<string, LinearIssue[]>();
  for (const i of k?.mine ?? []) groups.set(i.state, [...(groups.get(i.state) ?? []), i]);
  const ordered = [
    ...STATE_ORDER.filter((s) => groups.has(s)),
    ...[...groups.keys()].filter((s) => !STATE_ORDER.includes(s)),
  ];
  return html`${PageHeader({ title: "Linear", sub: k?.viewer ? `Assigned to ${k.viewer}` : "Your Linear issues" })}
<div data-live id="linear">
${k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Linear unavailable" }) : ""}
${k && k.ok && !k.mine.length && !k.teams.length ? Empty({ title: "Nothing open in Linear" }) : ""}
${ordered.map((state) =>
    Panel({ title: state, meta: String(groups.get(state)!.length), flush: true, children: issueList(groups.get(state)!) }),
  )}
${k?.ok ? cyclePanel(k) : ""}
${k?.ok ? untriagedPanel(k) : ""}
</div>`;
}

export function linearCard(k: LinearKept) {
  const top = [...k.mine].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  return Card({
    id: "linear-now",
    title: "Linear",
    meta: html`<a href="/linear">Open</a>`,
    children: k.ok
      ? top.length
        ? issueList(top)
        : html`<p class="t2">No open issues assigned to you</p>`
      : html`<p class="t2">${k.error ?? "Linear unavailable"}</p>`,
  });
}

/** The pill a PR's row shows when its branch or title names a Linear issue we know. */
export function linearLead(issue: LinearIssue): Html {
  return Pill({ tone: stateTone(issue), children: `${issue.key} ${issue.state}`, title: `${issue.title} · ${PRIORITY[issue.priority] ?? "No priority"}` });
}

/** The Linear row of a PR's facts: the issue, its key and title linked. */
export function linearFact(issue: LinearIssue): Html {
  const label = `${issue.key} ${issue.title}`;
  const href = safeUrl(issue.url);
  return href ? Link(href, label) : html`${label}`;
}
