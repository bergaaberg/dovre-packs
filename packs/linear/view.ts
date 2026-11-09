/** Linear Pack (`linear`) views. */
import { html } from "hono/html";
import { Card, Confirm, Empty, Gauge, type Html, Item, KeyValues, Link, List, markdown, Notice, type PackAgentCan, type PackAgentRun, PageHeader, Panel, Pill, safeUrl } from "dovre/pack.ts";
import { LANDS, settled, type Turn } from "./agent.ts";
import { type LinearIssue, type LinearKept, PRIORITY } from "./data.ts";

const stateTone = (i: LinearIssue): "ok" | "warn" | "accent" | "neutral" => {
  if (/review/i.test(i.state)) return "accent";
  if (/progress|started/i.test(i.state)) return "ok";
  if (/todo|backlog|triage/i.test(i.state)) return "warn";
  return "neutral";
};

/** The order the page groups states in: working states first, then whatever else came back. */
const STATE_ORDER = ["In Progress", "In Review", "Todo"];

function issueItem(i: LinearIssue, agent = false) {
  return Item({
    href: agent ? `/linear/issue/${encodeURIComponent(i.key)}` : safeUrl(i.url),
    title: html`<strong>${i.key}</strong> ${i.title}`,
    line: [i.project, i.cycle ? `Cycle ${i.cycle}` : undefined].filter(Boolean).join(" · "),
    trail: html`${Pill({ tone: stateTone(i), children: i.state })} ${Pill({ tone: "neutral", children: PRIORITY[i.priority] ?? "No priority" })}`,
  });
}

function issueList(issues: LinearIssue[], agent = false) {
  return List(issues.map((i) => issueItem(i, agent)));
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

/** `agent`: each issue links to its page here, where an agent plans or tries it (once I allowed agent turns), instead of to Linear. */
export function linearPage(k: LinearKept | undefined, o: { agent?: boolean } = {}) {
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
    Panel({ title: state, meta: String(groups.get(state)!.length), flush: true, children: issueList(groups.get(state)!, o.agent) }),
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
  return href === "#" ? html`${label}` : Link(href, label);
}

// ── An issue's page: its agent turns (Plan it, Try it) ──

const money = (n: number) => `$${n.toFixed(2)}`;
const STATUS_TONE: Record<PackAgentRun["status"], "ok" | "bad" | "neutral"> = { running: "neutral", done: "ok", failed: "bad", stopped: "bad" };

function turnPanel(t: Turn): Html {
  const r = t.last;
  const plan = t.where === "read";
  const title = plan ? "Plan" : "Try";
  if (!r || r.status === "running") return Panel({ title, meta: t.repo, children: html`<p class="t2">${plan ? "Planning" : "Trying"} in ${t.repo}… This page fills in when it ends.</p>` });
  const meta = html`${Pill({ tone: STATUS_TONE[r.status], children: r.status })} ${t.repo} · ${money(r.cost)}`;
  const body = r.said ? markdown(r.said, { headingOffset: 2 }) : html`<p class="t2">It said nothing.</p>`;
  if (plan) return Panel({ title, meta, children: body });
  const n = r.commits;
  const foot = t.pr
    ? html`Draft PR: ${Link(safeUrl(t.pr.url), `#${t.pr.number}`)}`
    : n === undefined
      ? html`<span class="t2">Its commits are coming home…</span>`
      : n === 0
        ? html`<span class="t2">No commits to land.</span>`
        : Confirm({ kind: `linear.${LANDS}`, action: `/linear/issue/${t.key}/land`, label: "Open a draft PR", question: html`Push its ${n} ${n === 1 ? "commit" : "commits"} to a new branch on ${t.repo} and open a draft PR?` });
  return Panel({ title, meta, foot, children: html`${t.error ? Notice({ tone: "bad", children: t.error }) : ""}${body}` });
}

function startForm(key: string, o: { can: Extract<PackAgentCan, { ok: true }>; repos: string[]; picked?: string }): Html {
  if (!o.repos.length) return Notice({ children: "None of the repos allowed for Linear has a checkout in the code folder." });
  const options = o.repos.map((r) => html`<option value="${r}"${r === o.picked ? " selected" : ""}>${r}</option>`);
  const buttons = [
    o.can.where.includes("read") ? html`<button type="submit" name="where" value="read" class="primary">Plan it</button>` : "",
    o.can.where.includes("sandbox") ? html`<button type="submit" name="where" value="sandbox">Try it</button>` : "",
  ];
  return html`<form method="post" action="/linear/issue/${key}/start"><div class="fields"><label class="field"><span class="label">Repo</span><select name="repo">${options}</select><span class="hint">Plan it reads the checkout and changes nothing. Try it works in a sandbox; then you choose whether its commits become a draft PR. Up to ${money(o.can.runUsd)} and ${o.can.minutes} minutes a turn.</span></label></div><div class="buttons">${buttons}</div></form>`;
}

/** One issue, and what an agent made of it. */
export function issuePage(i: LinearIssue, o: { can: PackAgentCan; repos: string[]; picked?: string; turn?: Turn; note?: string }): Html {
  const running = !!o.turn && !settled(o.turn);
  const ask = !o.can.ok
    ? Notice({ children: `Agent turns are off for Linear: ${o.can.why}.` })
    : running
      ? ""
      : Panel({ title: o.turn ? "Again" : "Ask an agent", children: startForm(i.key, { can: o.can, repos: o.repos, picked: o.picked }) });
  return html`${PageHeader({ title: html`${i.key} ${i.title}`, sub: Link(safeUrl(i.url), "Open in Linear"), crumbs: [{ href: "/linear", label: "Linear" }] })}
<div data-live id="linear-issue">
${KeyValues([["State", Pill({ tone: stateTone(i), children: i.state })], ["Priority", PRIORITY[i.priority] ?? "No priority"], ...(i.project ? ([["Project", i.project]] as [string, string][]) : [])])}
${o.note ? Notice({ tone: "warn", children: o.note }) : ""}
${o.turn ? turnPanel(o.turn) : ""}
${ask}
</div>`;
}
