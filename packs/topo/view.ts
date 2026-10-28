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
import type { CloudRead } from "./cloud.ts";
import { CF_NAMES, type Drift, type Missing, type Orphan } from "./drift.ts";
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

/** What the page knows about drift: whether Cloudflare is set up, its last read, and the findings. */
export type DriftView = { configured: boolean; read?: CloudRead; drift?: Drift; /** Some file declares Cloudflare runs. */ declares: boolean };

const what = (kind: Missing["kind"], worker?: string) => (worker ? html`${CF_NAMES[kind][0]} on <code>${worker}</code>` : CF_NAMES[kind][0]);

/** A missing entry's row: what the file declares, in which environments, and where the file opens. */
function missingItem(m: Missing): Html {
  const open = fileHref(m, m.file);
  return Item({
    lead: Dot({ tone: "bad" }),
    title: html`<strong>${m.full ?? m.repo}</strong> <span class="t3">${m.file}</span>`,
    line: html`Declares ${what(m.kind, m.worker)} <code>${m.name}</code>, but Cloudflare has none · ${m.envs.join(", ")}`,
    trail: open ? html`<div class="buttons"><a class="btn sm ghost" href="${safeUrl(open)}"${newTab(safeUrl(open))}>Open</a></div>` : "",
  });
}

/** Orphans, a row per kind (and per worker for Durable Object classes). */
function orphanItems(orphans: Orphan[]): Html[] {
  const groups = new Map<string, Orphan[]>();
  for (const o of orphans) {
    const k = `${o.kind}\n${o.worker ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  return [...groups.values()].map((g) => {
    const { kind, worker } = g[0]!;
    return Item({
      lead: Dot({ tone: "warn" }),
      title: worker ? html`<strong>${CF_NAMES[kind][1]}</strong> on <code>${worker}</code>` : html`<strong>${CF_NAMES[kind][1]}</strong>`,
      line: html`${g.map((o, i) => html`${i ? ", " : ""}<code>${o.name}</code>`)}`,
      trail: html`<span class="t3">${g.length}</span>`,
    });
  });
}

/** Drift (dovre-packs#68 step 2): what the files declare on Cloudflare and isn't there, and what's there that no file claims. */
function driftPanels(d: DriftView): Html | "" {
  if (!d.configured) {
    return d.declares ? Notice({ children: html`Set <code>CF_ACCOUNT_ID</code> and <code>CF_API_TOKEN</code> (read-only) in Settings to check what the files declare against Cloudflare.` }) : "";
  }
  if (!d.read || !d.drift) return "";
  const { missing, orphans } = d.drift;
  const unread = d.read.failed.length
    ? Notice({ tone: "warn", children: html`Couldn't read from Cloudflare this time, so these aren't checked: ${d.read.failed.map((f, i) => html`${i ? "; " : ""}${CF_NAMES[f.what][1]} (${f.why})`)}.` })
    : "";
  const clear = !missing.length && !orphans.length;
  return html`
    ${unread}
    ${missing.length ? Panel({ title: "Missing in Cloudflare", meta: String(missing.length), flush: true, children: List(missing.map(missingItem)) }) : ""}
    ${orphans.length
      ? Panel({
          title: "Not in any peak.yaml",
          meta: String(orphans.length),
          foot: html`Claim them under <code>runs</code> in the repo that deploys them. A name ending in <code>*</code> claims by prefix.`,
          flush: true,
          children: List(orphanItems(orphans)),
        })
      : ""}
    ${clear ? Panel({ title: "Drift", children: html`<p class="t3">What the files declare on Cloudflare is there, and everything there is claimed.</p>` }) : ""}
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
    /** Drift against Cloudflare. */
    drift?: DriftView;
  },
): Html {
  const { entries, coverage = [], unread, reads, filter, hosted = false, drift } = opts;
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
  const drifts = (drift?.drift?.missing.length ?? 0) + (drift?.drift?.orphans.length ?? 0);
  const sub = `${entries.length} cataloged ${entries.length === 1 ? "repo" : "repos"}${bare ? ` · ${bare} without a peak.yaml` : ""}${fix ? ` · ${fix} to fix` : ""}${drifts ? ` · ${drifts} out of line with Cloudflare` : ""}. What each repo is, what owns what, and what to read.`;

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
      ${!filter && drift ? driftPanels(drift) : ""}
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

/** What Bino is told about drift: missing names by repo, then orphans by kind, within `max` characters. */
export function driftLines(d: Drift | undefined, max = 600): string {
  if (!d || (!d.missing.length && !d.orphans.length)) return "";
  const named = (kind: Missing["kind"], name: string, worker?: string) => `${CF_NAMES[kind][0]} ${worker ? `${worker}/` : ""}${name}`;
  const lines = [
    "Drift against Cloudflare:",
    ...d.missing.map((m) => `- missing: ${m.repo} declares ${named(m.kind, m.name, m.worker)} (${m.envs.join(", ")}), not on Cloudflare`),
    ...d.orphans.map((o) => `- orphan: ${named(o.kind, o.name, o.worker)} is on Cloudflare, in no peak.yaml`),
  ];
  const out: string[] = [];
  let used = 0;
  for (const [i, l] of lines.entries()) {
    if (used + l.length > max) {
      out.push(`- (and ${lines.length - i} more)`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}
