/**
 * Topo's views: its page (/topo), a catalog of local repositories, peak.yaml component
 * boundaries, rules, docs, and direct agent launching; and what it puts in core pages' slots
 * (the component picker on /agents/new, a PR's tier and docs, New work's Projects) and Bino's lines.
 */
import { html } from "hono/html";
import { type Child, Dot, type Html, Item, List, newTab, Notice, PageHeader, Panel, Pill, Tabs, type Tone } from "dovre/ui/kit.ts";
import { Link, safeUrl } from "dovre/pages/parts.ts";
import { SCHEMA_URL, SPEC_URL, type Peak } from "@bergaaberg/peak";
import type { Coverage } from "./catalog.ts";
import type { TopoEntry, TopoRepo } from "./scan.ts";

function tierTone(tier?: string): Tone {
  if (!tier) return "neutral";
  const t = tier.toLowerCase();
  if (t === "active" || t === "production") return "ok";
  if (t === "core" || t === "platform") return "accent";
  if (t === "utility" || t === "tool") return "neutral";
  if (t === "deprecated" || t === "archive") return "warn";
  return "neutral";
}

/**
 * Where a repo's file opens: the code viewer for a checkout, else its page on the forge (the
 * default branch). Without a path, the repo itself.
 */
export function fileHref(r: TopoRepo, path?: string): string | undefined {
  if (r.dir) return `/code/${encodeURIComponent(r.repo)}${path ? `?path=${encodeURIComponent(path)}` : ""}`;
  if (path && r.blob) return r.blob + path.split("/").map(encodeURIComponent).join("/");
  return r.web;
}

/** An agent can start in it: there's a checkout here, or hosted (the Mac's agents pick the checkout). */
const agentable = (r: TopoRepo, hosted: boolean) => !!r.dir || hosted;
const agentHref = (r: TopoRepo, prompt?: string) => `/agents/new?repo=${encodeURIComponent(r.repo)}${prompt ? `&prompt=${encodeURIComponent(prompt)}` : ""}`;

/** "Code →" into the viewer, or "Repo ↗" on the forge. */
function codeLink(r: TopoRepo, cls: string, label = "Code"): Html | "" {
  if (r.dir) return html`<a class="${cls}" href="${safeUrl(fileHref(r))}">${label}${cls === "t2" ? " →" : ""}</a>`;
  return r.web ? Link(r.web, "Repo ↗", cls) : "";
}

function repoLinks(entry: TopoEntry, hosted: boolean): Html {
  const parts: Child[] = [];
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
  parts.push(codeLink(entry, "t2"));
  if (agentable(entry, hosted)) parts.push(html`<a class="t2" href="${agentHref(entry)}">Agent →</a>`);
  if (entry.peak.health?.workers?.length || entry.peak.health?.links?.length) {
    parts.push(html`<a class="t2" href="/ops#${encodeURIComponent(entry.repo)}">Health →</a>`);
  }
  return html`<div class="buttons">${parts}</div>`;
}

function repoPanel(entry: TopoEntry, hosted: boolean): Html {
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
          trail: agentable(entry, hosted) ? html`<a class="btn sm ghost" href="${agentHref(entry, prompt)}">Focus agent</a>` : undefined,
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
      const href = fileHref(entry, docPath);
      rows.push(
        Item({
          title: html`<strong>${key}</strong> <span class="mono sm t3">${docPath}</span>`,
          trail: href ? html`<a class="btn sm ghost" href="${safeUrl(href)}"${newTab(safeUrl(href))}>Read →</a>` : undefined,
        }),
      );
    }
  }

  return Panel({
    id: entry.repo,
    title: html`${entry.peak.name} ${entry.peak.tier ? Pill({ tone: tierTone(entry.peak.tier), children: entry.peak.tier }) : ""}`,
    actions: repoLinks(entry, hosted),
    flush: true,
    children: html`
      ${entry.peak.description ? html`<p class="panel-note">${entry.peak.description}</p>` : ""}
      ${rows.length ? List(rows) : ""}
    `,
  });
}

/** A coverage finding's row: what's wrong, where the file opens, and an agent session that fixes it. */
function coverageItem(f: Coverage, hosted: boolean): Html {
  const open = f.file ? fileHref(f, f.file) : undefined;
  const agent = agentable(f, hosted);
  if (f.kind === "uncataloged") {
    return Item({
      title: html`<strong>${f.full ?? f.repo}</strong>`,
      line: html`<span class="t3">No peak.yaml</span>`,
      trail: html`
        <div class="buttons">
          ${codeLink(f, "btn sm ghost")}
          ${agent ? html`<a class="btn sm ghost" href="${agentHref(f, draftPrompt())}" title="Start an agent session that drafts one">Write peak.yaml</a>` : ""}
        </div>
      `,
    });
  }
  const bad = f.kind === "problems";
  return Item({
    lead: Dot({ tone: bad ? "bad" : "warn" }),
    title: html`<strong>${f.full ?? f.repo}</strong> <span class="t3">${f.file}</span>`,
    line: html`${bad ? "" : "Warnings: "}${f.lines.join(" ")}`,
    trail: html`
      <div class="buttons">
        ${open ? html`<a class="btn sm ghost" href="${safeUrl(open)}"${newTab(safeUrl(open))}>Open</a>` : ""}
        ${agent ? html`<a class="btn sm ghost" href="${agentHref(f, fixPrompt({ file: f.file!, problems: f.lines, warnings: !bad }))}" title="Start an agent session that fixes it">Fix</a>` : ""}
      </div>
    `,
  });
}

/** Coverage (dovre-packs#68): files Dovre can't use, files with warnings, then repos with no file. */
function coveragePanels(coverage: Coverage[], hosted: boolean): Html {
  const files = coverage.filter((f) => f.kind !== "uncataloged");
  const bare = coverage.filter((f) => f.kind === "uncataloged");
  const problems = files.filter((f) => f.kind === "problems").length;
  return html`
    ${files.length
      ? Panel({
          title: problems ? "Files with problems" : "Files with warnings",
          meta: String(files.length),
          foot: html`The format: ${Link(SPEC_URL, "peak.yaml spec")} · ${Link(SCHEMA_URL, "JSON Schema")}. Check a repo with <code>npx github:bergaaberg/peak check</code>.`,
          flush: true,
          children: List(files.map((f) => coverageItem(f, hosted))),
        })
      : ""}
    ${bare.length ? Panel({ title: "Without a peak.yaml", meta: String(bare.length), flush: true, children: List(bare.map((f) => coverageItem(f, hosted))) }) : ""}
  `;
}

/** The page's body; the pack's route puts it in Dovre's shell. */
export function topoPage(
  opts: {
    entries: TopoEntry[];
    /** Its coverage findings (TopoCatalog.coverage). */
    coverage?: Coverage[];
    /** What the forge couldn't read this time. */
    unread?: { error?: string; failed: string[] };
    /** What it can read from: checkouts here, the forge. */
    reads?: { checkouts: boolean; forge: boolean };
    filter?: string;
    hosted?: boolean;
  },
): Html {
  const { entries, coverage = [], unread, reads, filter, hosted = false } = opts;
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

  const bare = coverage.filter((f) => f.kind === "uncataloged").length;
  const fix = coverage.length - bare;
  const sub = `${entries.length} cataloged ${entries.length === 1 ? "repo" : "repos"}${bare ? ` · ${bare} without a peak.yaml` : ""}${fix ? ` · ${fix} to fix` : ""}. What each repo is, what owns what, and what to read.`;

  const notes: Html[] = [];
  if (reads && !reads.checkouts && !reads.forge) notes.push(Notice({ tone: "warn", children: "Nothing to read: there's no code folder here, and the forge can't read repos' files." }));
  if (unread?.error) notes.push(Notice({ tone: "warn", children: html`${unread.error}. What's shown is from the last read that worked.` }));
  if (unread?.failed.length) {
    notes.push(Notice({ tone: "warn", children: html`Couldn't read ${unread.failed.length === 1 ? "one repo" : `${unread.failed.length} repos`} this time: ${unread.failed.slice(0, 8).join(", ")}${unread.failed.length > 8 ? ", …" : ""}.` }));
  }

  return html`
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
      ${notes}
      ${filtered.map((e) => repoPanel(e, hosted))}
      ${!filter ? coveragePanels(coverage, hosted) : ""}
    </div>
  `;
}

/** The prompt that focuses an agent on one component. */
const CHECK = "npx github:bergaaberg/peak check";

/** For a checkout without a peak.yaml (#140): the agent drafts one from what the repo says about itself. */
export const draftPrompt = () =>
  `Write a peak.yaml for this repo (the format: ${SPEC_URL}). Draft it from the README, the folder layout, AGENTS.md / CLAUDE.md and any docs: name, a one-line description, tier, its components with the paths each owns (and rules files where they exist), docs, and health (deployed workers and URLs that should answer) only where the repo names them. Leave out what you'd have to guess. Then run \`${CHECK}\` and fix what it reports.`;

/** For a file Dovre can't use, or one with warnings: what's wrong, and the check to run after. */
export const fixPrompt = (p: { file: string; problems: string[]; warnings?: boolean }) =>
  `${p.file} in this repo has ${p.warnings ? "warnings" : "problems"} (the format: ${SPEC_URL}): ${p.problems.join(" ")} Fix them, then run \`${CHECK}\` until it passes${p.warnings ? " with no warnings" : ""}.`;

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

/** A PR's "pr.facts" slot: its repo's tier, site and docs (into /code, or on the forge). */
export function prFacts(entry: TopoEntry | undefined): [string, Html][] {
  if (!entry) return [];
  const { peak } = entry;
  const docs = Object.entries(peak.docs);
  return [
    [
      "Topo",
      html`${Pill({ tone: "ok", children: `tier: ${peak.tier}` })}${peak.url ? html` ${Link(peak.url, peak.name)}` : html` <strong>${peak.name}</strong>`}${
        docs.length ? html` · docs: ${docs.map(([k, path], i) => html`${i ? ", " : ""}${Link(fileHref(entry, path), k)}`)}` : ""
      }`,
    ],
  ];
}

/** New work's "work.new" slot: the cataloged projects, each with its docs and an agent. */
export function projectsPanel(entries: TopoEntry[], hosted = false): Html | "" {
  if (!entries.length) return "";
  const items = entries.map((e) =>
    Item({
      href: fileHref(e) ? safeUrl(fileHref(e)) : undefined,
      title: html`<strong>${e.peak.name}</strong> ${Pill({ tone: "ok", children: `tier: ${e.peak.tier}` })}`,
      line: e.peak.description ?? "",
      more: html`${e.peak.url ? Link(e.peak.url, "Live site ↗") : ""}${Object.entries(e.peak.docs).map(([k, p]) => html` · ${Link(fileHref(e, p), k)}`)}`,
      trail: agentable(e, hosted) ? html`<a class="btn sm ghost" href="${agentHref(e)}">Start agent</a>` : undefined,
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
