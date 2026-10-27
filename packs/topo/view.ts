/**
 * Topo's views: its page (/topo), a catalog of local repositories, peak.yaml component
 * boundaries, rules, docs, and direct agent launching; and what it puts in core pages' slots
 * (the component picker on /agents/new, a PR's tier and docs, New work's Projects) and Bino's lines.
 */
import { html } from "hono/html";
import { type Child, Dot, type Html, Item, List, PageHeader, Panel, Pill, Tabs, type Tone } from "dovre/ui/kit.ts";
import { Link, safeUrl } from "dovre/pages/parts.ts";
import { SCHEMA_URL, SPEC_URL, type Peak } from "@bergaaberg/peak";
import { type TopoEntry, type TopoProblem } from "./scan.ts";

function tierTone(tier?: string): Tone {
  if (!tier) return "neutral";
  const t = tier.toLowerCase();
  if (t === "active" || t === "production") return "ok";
  if (t === "core" || t === "platform") return "accent";
  if (t === "utility" || t === "tool") return "neutral";
  if (t === "deprecated" || t === "archive") return "warn";
  return "neutral";
}

function repoLinks(entry: TopoEntry): Html {
  const parts: Html[] = [];
  if (entry.peak.url) {
    const label = (() => {
      try {
        return `${new URL(entry.peak.url).host} ↗`;
      } catch {
        return "Site ↗";
      }
    })();
    parts.push(html`<a class="t2" href="${safeUrl(entry.peak.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  }
  parts.push(html`<a class="t2" href="/code/${encodeURIComponent(entry.repo)}">Code →</a>`);
  parts.push(html`<a class="t2" href="/agents/new?repo=${encodeURIComponent(entry.repo)}">Agent →</a>`);
  if (entry.peak.health?.workers?.length || entry.peak.health?.links?.length) {
    parts.push(html`<a class="t2" href="/ops#${encodeURIComponent(entry.repo)}">Health →</a>`);
  }
  return html`<div class="buttons">${parts}</div>`;
}

function repoPanel(entry: TopoEntry): Html {
  const rows: Child[] = [];

  // Components
  if (entry.peak.components?.length) {
    rows.push(
      Item({
        title: html`<span class="sub-h">Components (${entry.peak.components.length})</span>`,
        quiet: true,
      }),
    );
    for (const c of entry.peak.components) {
      const prompt = focusPrompt(entry.peak, c);
      rows.push(
        Item({
          title: html`<strong>${c.name}</strong>${c.rules ? html`<span class="mono sm t3 topo-rule">rules: ${c.rules}</span>` : ""}`,
          line: html`<span class="mono sm">owns: ${c.owns.join(", ")}</span>`,
          trail: html`<a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(entry.repo)}&prompt=${encodeURIComponent(prompt)}">Focus agent</a>`,
        }),
      );
    }
  }

  // Docs
  const docEntries = Object.entries(entry.peak.docs ?? {}).filter(([, p]) => typeof p === "string" && p.trim().length > 0);
  if (docEntries.length) {
    rows.push(
      Item({
        title: html`<span class="sub-h">Docs (${docEntries.length})</span>`,
        quiet: true,
      }),
    );
    for (const [key, docPath] of docEntries) {
      rows.push(
        Item({
          title: html`<strong>${key}</strong> <span class="mono sm t3">${docPath}</span>`,
          trail: html`<a class="btn sm ghost" href="/code/${encodeURIComponent(entry.repo)}?path=${encodeURIComponent(docPath as string)}">Read →</a>`,
        }),
      );
    }
  }

  return Panel({
    id: entry.repo,
    title: html`${entry.peak.name} ${entry.peak.tier ? Pill({ tone: tierTone(entry.peak.tier), children: entry.peak.tier }) : ""}`,
    actions: repoLinks(entry),
    flush: true,
    children: html`
      ${entry.peak.description ? html`<p class="panel-note">${entry.peak.description}</p>` : ""}
      ${rows.length ? List(rows) : ""}
    `,
  });
}

function bareItem(repo: string): Html {
  return Item({
    title: html`<strong>${repo}</strong>`,
    line: html`<span class="t3">No peak.yaml</span>`,
    trail: html`
      <div class="buttons">
        <a class="btn sm ghost" href="/code/${encodeURIComponent(repo)}">Code</a>
        <a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(repo)}&prompt=${encodeURIComponent(draftPrompt())}" title="Start an agent session that drafts one">Write peak.yaml</a>
      </div>
    `,
  });
}

/** Files Dovre can't use: every problem, and where the format is written down. */
function problemsPanel(problems: TopoProblem[]): Html {
  return Panel({
    title: "Files with problems",
    meta: String(problems.length),
    foot: html`The format: ${Link(SPEC_URL, "peak.yaml spec")} · ${Link(SCHEMA_URL, "JSON Schema")}. Check a repo with <code>npx github:bergaaberg/peak check</code>.`,
    flush: true,
    children: List(
      problems.map((p) =>
        Item({
          lead: Dot({ tone: "bad" }),
          title: html`<strong>${p.repo}</strong> <span class="t3">${p.file}</span>`,
          line: p.problems.join(" "),
          trail: html`
            <div class="buttons">
              <a class="btn sm ghost" href="/code/${encodeURIComponent(p.repo)}?path=${encodeURIComponent(p.file)}">Open</a>
              <a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(p.repo)}&prompt=${encodeURIComponent(fixPrompt(p))}" title="Start an agent session that fixes it">Fix</a>
            </div>
          `,
        }),
      ),
    ),
  });
}

/** The page's body; the pack's route puts it in Dovre's shell. */
export function topoPage(
  opts: {
    entries: TopoEntry[];
    bare?: string[];
    /** Checkouts whose file can't be used. */
    problems?: TopoProblem[];
    filter?: string;
  },
): Html {
  const { entries, bare = [], problems = [], filter } = opts;
  const filtered = filter ? entries.filter((e) => (e.peak.tier ?? "").toLowerCase() === filter.toLowerCase()) : entries;

  const tiers = Array.from(new Set(entries.map((e) => (e.peak.tier ?? "").toLowerCase()).filter(Boolean))) as string[];
  const tabs =
    tiers.length > 0
      ? Tabs({
          label: "Topo tiers",
          items: [
            { href: "/topo", label: "All", n: entries.length, current: !filter },
            ...tiers.map((t) => ({
              href: `/topo?tier=${encodeURIComponent(t)}`,
              label: t[0].toUpperCase() + t.slice(1),
              n: entries.filter((e) => (e.peak.tier ?? "").toLowerCase() === t).length,
              current: (filter ?? "").toLowerCase() === t,
            })),
          ],
        })
      : undefined;

  const sub = `${entries.length} cataloged ${entries.length === 1 ? "project" : "projects"}${bare.length ? ` · ${bare.length} uncataloged` : ""}. What each repo is, what owns what, and what to read.`;

  const body = html`
    ${PageHeader({
      title: "Topo",
      sub,
      tabs,
      actions: html`
        <a class="btn" href="/topo?refresh=1">Rescan</a>
        <a class="btn primary" href="/agents/new">New agent session</a>
      `,
    })}
    <div data-live id="topo">
      ${!filter && problems.length ? problemsPanel(problems) : ""}
      ${filtered.map(repoPanel)}
      ${!filter && bare.length > 0 ? Panel({ title: "Uncataloged Checkouts", meta: String(bare.length), flush: true, children: List(bare.map(bareItem)) }) : ""}
    </div>
  `;

  return body;
}

/** The prompt that focuses an agent on one component. */
const CHECK = "npx github:bergaaberg/peak check";

/** For a checkout without a peak.yaml (#140): the agent drafts one from what the repo says about itself. */
export const draftPrompt = () =>
  `Write a peak.yaml for this repo (the format: ${SPEC_URL}). Draft it from the README, the folder layout, AGENTS.md / CLAUDE.md and any docs: name, a one-line description, tier, its components with the paths each owns (and rules files where they exist), docs, and health (deployed workers and URLs that should answer) only where the repo names them. Leave out what you'd have to guess. Then run \`${CHECK}\` and fix what it reports.`;

/** For a file Dovre can't use: what's wrong, and the check to run after. */
export const fixPrompt = (p: TopoProblem) =>
  `${p.file} in this repo has problems (the format: ${SPEC_URL}): ${p.problems.join(" ")} Fix them, then run \`${CHECK}\` until it passes.`;

const focusPrompt = (peak: Peak, c: Peak["components"][number]) =>
  `Focus on component "${c.name}" (${c.owns.join(", ")}) in ${peak.name}${c.rules ? `, following rules in ${c.rules}` : ""}: `;

/** /agents/new's "agents.new" slot: a checkout's components, each a link that sets the prompt. */
export function componentField(repo: string, peak: Peak | undefined): Html | "" {
  if (!peak?.components?.length) return "";
  return html`<div class="field"><span class="label">Component</span><div class="buttons">${peak.components.map(
    (c) => html`<a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(repo)}&prompt=${encodeURIComponent(focusPrompt(peak, c))}" title="Owns: ${c.owns.join(", ")}">${c.name}</a>`,
  )}</div><span class="hint">Clicking a component sets boundaries and loads component rules.</span></div>`;
}

/** A PR row's "pr.lead" slot: its repo's tier. */
export function prLead(peak: Peak | undefined): Html | "" {
  return peak ? html` ${Pill({ tone: "neutral", children: peak.tier })}` : "";
}

/** A PR's "pr.facts" slot: its repo's tier, site and docs (links into /code). */
export function prFacts(repo: string, peak: Peak | undefined): [string, Html][] {
  if (!peak) return [];
  const short = repo.replace(/^.*\//, "");
  const docs = Object.entries(peak.docs);
  return [
    [
      "Topo",
      html`${Pill({ tone: "ok", children: `tier: ${peak.tier}` })}${peak.url ? html` ${Link(peak.url, peak.name)}` : html` <strong>${peak.name}</strong>`}${
        docs.length ? html` · docs: ${docs.map(([k, path], i) => html`${i ? ", " : ""}${Link(`/code/${short}?path=${encodeURIComponent(path)}`, k)}`)}` : ""
      }`,
    ],
  ];
}

/** New work's "work.new" slot: the cataloged projects, each with its docs and an agent. */
export function projectsPanel(entries: TopoEntry[]): Html | "" {
  if (!entries.length) return "";
  const items = entries.map((e) =>
    Item({
      href: `/code/${e.repo}`,
      title: html`<strong>${e.peak.name}</strong> ${Pill({ tone: "ok", children: `tier: ${e.peak.tier}` })}`,
      line: e.peak.description ?? "",
      more: html`${e.peak.url ? Link(e.peak.url, "Live site ↗") : ""}${Object.entries(e.peak.docs).map(([k, p]) => html` · ${Link(`/code/${e.repo}?path=${encodeURIComponent(p)}`, k)}`)}`,
      trail: html`<a class="btn sm ghost" href="/agents/new?repo=${encodeURIComponent(e.repo)}">Start agent</a>`,
    }),
  );
  return Panel({ title: "Projects", flush: true, children: List(items) });
}

/** What Bino is told: a line per cataloged repo, kept within what a pack may say (APP_CHARS). */
export function binoLines(entries: TopoEntry[], max = 1400): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, { repo, peak }] of entries.entries()) {
    const comps = peak.components?.length ? ` Components: ${peak.components.slice(0, 6).map((c) => `${c.name} (${c.owns.join(", ")})`).join("; ")}${peak.components.length > 6 ? ` (and ${peak.components.length - 6} more)` : ""}.` : "";
    const docs = Object.entries(peak.docs ?? {}).slice(0, 6).map(([k, p]) => `${k}: ${p}`).join(", ");
    const l = `- ${repo}${peak.tier ? ` [${peak.tier}]` : ""}: ${(peak.description ?? peak.name).replace(/\s+/g, " ").slice(0, 100)}.${comps}${docs ? ` Docs: ${docs}.` : ""}`.slice(0, 400);
    if (used + l.length > max) {
      out.push(`- (and ${entries.length - i} more cataloged repositories)`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}
