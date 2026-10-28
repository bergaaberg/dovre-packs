/**
 * Topo's views: its page (/topo), a map of the repos by tier with what each uses between them and
 * its findings on it (map.ts lays it out), a card for the picked place, and every place as a list;
 * and what it puts in core pages' slots (the component picker on /agents/new, a PR's tier and docs,
 * New work's Projects) and Bino's lines.
 */
import { html } from "hono/html";
import { type Child, Confirm, ConfirmSubmit, Empty, type Html, Item, List, newTab, Notice, PageHeader, Panel, Pill, type Tone } from "dovre/ui/kit.ts";
import { Link, safeUrl } from "dovre/pages/parts.ts";
import { type Kind, KINDS, runsIn, SPEC_URL, type Peak } from "@bergaaberg/peak";
import type { Coverage } from "./catalog.ts";
import type { CloudRead } from "./cloud.ts";
import { CF_NAMES, type Drift, type Missing, type Orphan } from "./drift.ts";
import { clip, drawMap, type Glyph, type MapStyle, type Off, offKind, offName, type Picture, type Place, type RepoFinding, type Spot, STYLES, textW, topoModel, type TopoModel } from "./map.ts";
import { type Finding, RULES, type RuleId } from "./rules.ts";
import type { TopoEntry, TopoRepo } from "./scan.ts";
import { WRITE } from "./fix.ts";

/** Fix PRs (step 5), when the forge can open them: who I am there (a new file's owner), and how the last one went. */
export type PrOpts = { login?: string; said?: { ok: boolean; text: string; url?: string } };
const PR_KIND = `topo.${WRITE}`;
const said = (pr?: PrOpts) => (pr?.said ? Notice({ tone: pr.said.ok ? "ok" : "warn", children: html`${pr.said.text}${pr.said.url ? html` ${Link(pr.said.url, "Open the PR")}` : ""}` }) : "");
/** Drops a missing thing from the repo's peak.yaml, in a PR. */
const dropPr = (e: TopoEntry, m: { kind: string; name: string; worker?: string }, what: string) =>
  e.full
    ? Confirm({ kind: PR_KIND, action: "/topo/pr", fields: { what: "drop", repo: e.full, kind: m.kind, name: m.name, ...(m.worker ? { worker: m.worker } : {}) }, label: "PR: take it out", question: html`Open a PR on ${e.full} taking ${what} <code>${m.name}</code> out of ${e.file}? It isn't on Cloudflare.` })
    : "";

function tierTone(tier?: string): Tone {
  if (!tier) return "neutral";
  const t = tier.toLowerCase();
  if (t === "active" || t === "production") return "ok";
  if (t === "core" || t === "platform") return "accent";
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
/** The page with a place picked. */
const atHref = (key: string) => safeUrl(`/topo?at=${encodeURIComponent(key)}`);

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

/** What the page knows about drift: whether Cloudflare is set up, its last read, and the findings. */
export type DriftView = { configured: boolean; read?: CloudRead; drift?: Drift; /** Some file declares Cloudflare runs. */ declares: boolean };

/** What the page knows about the rules: the findings, which rules are off, and words in TOPO_RULES_OFF that aren't rules. */
export type RulesView = { findings: Finding[]; off: Set<RuleId>; unknown: string[] };

/** Topo's panel on Settings: the map's style, and each rule and whether it's on. */
export function rulesSettings(off: Set<RuleId>, unknown: string[], map?: { style: MapStyle; unknown?: string }): Html {
  return html`${map
    ? html`<p class="notes">Map: <code>${map.style}</code>${map.unknown ? html` (<code>${map.unknown}</code> isn't a style)` : ""}. Set <code>TOPO_MAP</code> to one of ${STYLES.map((s, i) => html`${i ? ", " : ""}<code>${s}</code>`)}: lanes by tier, rings with active in the middle, terrain with active at the summit, or off for the list alone.</p>`
    : ""}<p class="notes">Rules: ${RULES.map((r, i) => html`${i ? "; " : ""}<code>${r.id}</code> ${off.has(r.id) ? "(off)" : "(on)"} ${r.about}`)}${unknown.length ? html` Not rules, so ignored: ${unknown.join(", ")}.` : ""} Switch one off by naming it in <code>TOPO_RULES_OFF</code>.</p>`;
}

// ── The map ────────────────────────────────────────────────────────────────

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const worst = (fs: RepoFinding[]) => (fs.some((f) => f.sev === "bad") ? "bad" : "warn");
const glyphKind = (k: Kind | "objects"): Kind => (k === "objects" ? "workers" : k);
const GLYPH_W: Record<Kind, number> = { workers: 7, databases: 7, stores: 7, buckets: 8, queues: 11 };
const GLYPH_NAMES: Record<Kind, string> = { workers: "worker", databases: "database", stores: "store", buckets: "bucket", queues: "queue" };

/** A resource's mark, centred on (cx, cy): worker ■, database ●, store ◆, bucket ▲, queue ▬. */
function glyph(kind: Kind, cx: number, cy: number, miss = false): Html {
  const cls = `topo-g${miss ? " miss" : ""}`;
  const x = f1(cx);
  const y = f1(cy);
  switch (kind) {
    case "databases":
      return html`<circle class="${cls}" cx="${x}" cy="${y}" r="3.5"></circle>`;
    case "stores":
      return html`<path class="${cls}" d="M${x} ${f1(cy - 4)} L${f1(cx + 4)} ${y} L${x} ${f1(cy + 4)} L${f1(cx - 4)} ${y} Z"></path>`;
    case "buckets":
      return html`<path class="${cls}" d="M${x} ${f1(cy - 4)} L${f1(cx + 4)} ${f1(cy + 3.5)} L${f1(cx - 4)} ${f1(cy + 3.5)} Z"></path>`;
    case "queues":
      return html`<rect class="${cls}" x="${f1(cx - 5.5)}" y="${f1(cy - 2)}" width="11" height="4"></rect>`;
    default:
      return html`<rect class="${cls}" x="${f1(cx - 3.5)}" y="${f1(cy - 3.5)}" width="7" height="7"></rect>`;
  }
}

/** A mark on its own, for the card, the list and the legend. */
const glyphIcon = (kind: Kind, miss = false) => html`<svg class="topo-gi" viewBox="0 0 12 10" aria-hidden="true">${glyph(kind, 6, 5, miss)}</svg>`;

function badge(n: number, sev: string, cx: number, cy: number): Html {
  const w = Math.max(16, String(n).length * 6.5 + 8);
  return html`<rect class="topo-badge ${sev}" x="${f1(cx - w / 2)}" y="${f1(cy - 8)}" width="${f1(w)}" height="16" rx="8"></rect><text class="topo-bt" x="${f1(cx)}" y="${f1(cy + 3.5)}">${n}</text>`;
}

function placeSvg(s: Spot, on: boolean): Html {
  const p = s.place;
  const name = clip(p.entry.repo, 18);
  const lw = textW(name, 11) + 12;
  const n = p.findings.length;
  const glyphs = p.glyphs.slice(0, 8);
  let gx = s.x - (glyphs.reduce((a, g) => a + GLYPH_W[g.kind] + 3, 0) - 3) / 2;
  const marks = glyphs.map((g: Glyph) => {
    const m = glyph(g.kind, gx + GLYPH_W[g.kind] / 2, s.y + 32, g.miss);
    gx += GLYPH_W[g.kind] + 3;
    return m;
  });
  const label = `${p.entry.full ?? p.entry.repo}, ${p.entry.peak.tier}${n ? `, ${n} ${n === 1 ? "finding" : "findings"}` : ""}`;
  return html`<a class="topo-place${on ? " on" : ""}${p.deprecated ? " dep" : ""}" href="${atHref(p.key)}" aria-label="${label}"><title>${label}</title><circle class="topo-dot" cx="${f1(s.x)}" cy="${f1(s.y)}" r="6"></circle><rect class="topo-pn" x="${f1(s.x - lw / 2)}" y="${f1(s.y + 9)}" width="${f1(lw)}" height="15" rx="5"></rect><text class="topo-pt" x="${f1(s.x)}" y="${f1(s.y + 20.5)}">${name}</text>${marks}${
    n ? badge(n, worst(p.findings), s.x + 12, s.y - 9) : ""
  }</a>`;
}

function chipSvg(c: Picture["chips"][number], on: boolean): Html {
  const o = c.off;
  const name = clip(offName(o), 28);
  const kind = offKind(o);
  const nameX = c.x + 22;
  const icon = o.what === "orphan" ? glyph(glyphKind(o.orphan.kind), c.x + 12, c.y) : html`<circle class="topo-g repo" cx="${f1(c.x + 12)}" cy="${c.y}" r="3.5"></circle>`;
  return html`<a class="topo-chip${on ? " on" : ""}" href="${atHref(o.key)}" aria-label="${offName(o)}, ${kind}"><title>${offName(o)}, ${kind}</title><rect class="topo-cr" x="${f1(c.x)}" y="${c.y - 11}" width="${f1(c.w)}" height="22" rx="6"></rect>${icon}<text class="topo-ct" x="${f1(nameX)}" y="${c.y + 4}">${name}</text><text class="topo-ck" x="${f1(nameX + textW(name, 10.5) + 6)}" y="${c.y + 3.5}">${kind}</text></a>`;
}

function mapSvg(pic: Picture, at: string, count: number, findings: number): Html {
  const { trails, hints } = pic;
  const strip = pic.chips.length || pic.more;
  return html`<div class="topo-map"><svg class="topo-svg" viewBox="0 0 ${pic.w} ${pic.h}" role="group" aria-label="Map of ${count} repos by tier, with what each uses and ${findings} findings. The list below has the same.">
<rect class="topo-sea" x="0" y="0" width="${pic.w}" height="${pic.h}"></rect>
${pic.bands.map((d, i) => html`<path class="topo-band b${i}" d="${d}"></path>`)}
<path class="topo-minor" d="${pic.minor}"></path><path class="topo-idx" d="${pic.index}"></path>
${strip ? html`<path class="topo-shore" d="${pic.shore}"></path><path class="topo-coast" d="${pic.coast}"></path>` : ""}
<path class="topo-hint" d="${hints.plain}"></path>
<path class="topo-tr" d="${trails.plain.d}"></path><path class="topo-ar" d="${trails.plain.ar}"></path>
<path class="topo-tr warn" d="${trails.warn.d}"></path><path class="topo-ar warn" d="${trails.warn.ar}"></path>
<path class="topo-tr hot" d="${trails.hot.d}"></path><path class="topo-ar hot" d="${trails.hot.ar}"></path>
<path class="topo-hint hot" d="${hints.hot}"></path>
${pic.labels.map((l) => html`<text class="topo-bl${l.start ? " start" : ""}" x="${l.x}" y="${l.y}">${l.text}</text>`)}
${pic.services.map((v) => {
  const t = `${v.name} · service`;
  const w = textW(t, 10.5) + 14;
  return html`<g class="topo-svc${v.hot ? " hot" : ""}"><rect x="${f1(v.x - w / 2)}" y="${v.y - 10}" width="${f1(w)}" height="20" rx="5"></rect><text x="${v.x}" y="${v.y + 3.5}">${t}</text></g>`;
})}
${pic.spots.map((s) => placeSvg(s, s.place.key === at))}
${strip ? html`<text class="topo-shl" x="18" y="${pic.h - 82}">OFF THE MAP · NO FILE CLAIMS THESE</text>` : ""}
${pic.more ? html`<a href="#topo-list" class="topo-more"><text class="topo-shl end" x="${pic.w - 18}" y="${pic.h - 82}">+${pic.more} MORE IN THE LIST</text></a>` : ""}
${pic.chips.map((c) => chipSvg(c, c.off.key === at))}
</svg></div>`;
}

function legend(style: MapStyle): Html {
  const tiers = style === "rings" ? "Rings are tiers: active in the middle" : style === "terrain" ? "Height is tier: active at the summit" : "Lanes are tiers: active at the top";
  return html`<div class="topo-legend"><span>${tiers}</span><span><svg class="topo-li" viewBox="0 0 22 6" aria-hidden="true"><path class="topo-tr" d="M0 3 H22"></path></svg>uses</span><span>${KINDS.map(
    (k) => html`${glyphIcon(k)}${GLYPH_NAMES[k]} `,
  )}</span><span>${glyphIcon("workers", true)}declared, missing</span><span><span class="topo-n bad">1</span><span class="topo-n warn">1</span>findings</span></div>`;
}

/** On a phone: a band per tier holding the names, then what's off the map. */
function phoneBands(model: TopoModel, at: string): Html {
  const bands: [string, Place[]][] = [
    ["Active", model.places.filter((p) => p.band === 0)],
    ["Maintained", model.places.filter((p) => p.band === 1)],
    ["Scratch and other", model.places.filter((p) => p.band === 2)],
  ];
  const chip = (key: string, name: string, n: number, sev: string, cls = "") =>
    html`<a class="topo-pchip${key === at ? " on" : ""}${cls}" href="${atHref(key)}">${name}${n ? html` <span class="topo-n ${sev}">${n}</span>` : ""}</a>`;
  return html`<div class="topo-phone">${bands
    .filter(([, ps]) => ps.length)
    .map(([label, ps]) => html`<div class="topo-pband"><p class="topo-ph">${label}</p>${ps.map((p) => chip(p.key, p.entry.repo, p.findings.length, worst(p.findings), p.deprecated ? " dep" : ""))}</div>`)}${
    model.off.length ? html`<div class="topo-pband off"><p class="topo-ph">Off the map</p>${model.off.map((o) => chip(o.key, offName(o), 0, "warn"))}</div>` : ""
  }</div>`;
}

// ── The card ───────────────────────────────────────────────────────────────

function findingBox(f: { sev: string; tag: string; why: string; fix: string }): Html {
  return html`<div class="topo-f"><span class="topo-sev ${f.sev}">${f.tag}</span> ${f.why} <span class="topo-fix">Fix: ${f.fix}</span></div>`;
}

const section = (title: string, body: Child) => html`<div class="topo-cs"><h3>${title}</h3>${body}</div>`;
const none = (s: string) => html`<p class="topo-none">${s}</p>`;
const btn = (href: string, label: string, primary = false, title?: string) =>
  html`<a class="btn sm${primary ? " primary" : " ghost"}" href="${safeUrl(href)}"${newTab(safeUrl(href))}${title ? html` title="${title}"` : ""}>${label}</a>`;

/** Every runs entry in every environment, with the environments that list it and whether it's missing there. */
function runsOf(p: Place): { kind: Kind; name: string; envs: { env: string; miss: boolean }[] }[] {
  const peak = p.entry.peak;
  const out = new Map<string, { kind: Kind; name: string; envs: { env: string; miss: boolean }[] }>();
  for (const env of ["production", ...Object.keys(peak.environments ?? {}).filter((e) => e !== "production")]) {
    const runs = runsIn(peak, env);
    for (const kind of KINDS) {
      for (const r of runs[kind] ?? []) {
        const k = `${kind}\n${r.name}`;
        const miss = p.missing.some((m) => m.kind === kind && m.name === r.name && m.envs.includes(env));
        const row = out.get(k) ?? { kind, name: r.name, envs: [] };
        row.envs.push({ env, miss });
        out.set(k, row);
      }
    }
  }
  return [...out.values()];
}

function repoCard(p: Place, model: TopoModel, hosted: boolean, pr?: PrOpts): Html {
  const { entry } = p;
  const peak = entry.peak;
  const open = fileHref(entry, entry.file);
  const runs = runsOf(p);
  const objects = p.missing.filter((m) => m.kind === "objects");
  const named = (key: string) => model.places.find((x) => x.key === key);
  const warnUse = (k: string) => p.findings.some((f) => f.uses && f.uses.toLowerCase() === (named(k)?.entry.full ?? "").toLowerCase());
  const docs = Object.entries(peak.docs ?? {}).filter(([, path]) => typeof path === "string" && path.trim());
  return html`
    ${said(pr)}<div class="topo-ch"><h2>${entry.repo}</h2>${Pill({ tone: tierTone(peak.tier), children: peak.tier })}</div>
    <p class="topo-sub">${entry.full ?? entry.repo}${peak.name !== entry.repo ? html` · ${peak.name}` : ""} · owner ${peak.owner ?? "none"}</p>
    ${peak.description ? html`<p class="topo-about">${peak.description}</p>` : ""}
    ${repoLinks(entry, hosted)}
    ${section(
      "Findings",
      html`${p.findings.length ? p.findings.map(findingBox) : html`<p><span class="topo-sev ok">clear</span></p>`}
      <div class="buttons">${p.findings.length && agentable(entry, hosted) ? btn(agentHref(entry, findingsPrompt(entry.file, p.findings)), "Fix with an agent", true, "Start an agent session that fixes them") : ""}${open ? btn(open, `Open ${entry.file}`) : ""}</div>`,
    )}
    ${section(
      "Runs",
      runs.length || objects.length
        ? html`<ul class="topo-runs">${runs.map(
            (r) => html`<li>${glyphIcon(r.kind, r.envs.some((e) => e.miss))}<span class="topo-rn"><span class="t3">${GLYPH_NAMES[r.kind]}</span> ${r.name}</span><span class="topo-envs">${r.envs.map(
              (e) => html`<span class="topo-env${e.miss ? " miss" : ""}">${e.env}${e.miss ? ": missing" : ""}</span>`,
            )}${pr && r.envs.some((e) => e.miss) ? dropPr(entry, r, GLYPH_NAMES[r.kind]) : ""}</span></li>`,
          )}${objects.map((m) => html`<li>${glyphIcon("workers", true)}<span class="topo-rn"><span class="t3">class on ${m.worker}</span> ${m.name}</span><span class="topo-envs"><span class="topo-env miss">missing</span>${pr ? dropPr(entry, m, `the class on ${m.worker}`) : ""}</span></li>`)}</ul>`
        : none("Nothing. A library or a tool."),
    )}
    ${section(
      "Uses",
      p.uses.length || p.services.length
        ? html`<p class="topo-chips">${p.uses.map((k) => html`<a class="topo-pchip${warnUse(k) ? " warn" : ""}" href="${atHref(k)}">${named(k)?.entry.repo ?? k}</a>`)}${p.services.map((s) => html`<span class="topo-pchip svc">${s} · service</span>`)}</p>`
        : none("Nothing."),
    )}
    ${section(
      "Used by",
      p.usedBy.length ? html`<p class="topo-chips">${p.usedBy.map((k) => html`<a class="topo-pchip" href="${atHref(k)}">${named(k)?.entry.repo ?? k}</a>`)}</p>` : none("No cataloged repo."),
    )}
    ${p.looks.length
      ? section(
          "Unclaimed, looks like this repo's",
          html`<ul class="topo-runs">${p.looks.map((k) => {
            const o = model.off.find((x) => x.key === k);
            return o?.what === "orphan" ? html`<li>${glyphIcon(glyphKind(o.orphan.kind))}<span class="topo-rn"><span class="t3">${offKind(o)}</span> ${offName(o)}</span><span class="topo-envs"><a href="${atHref(k)}">Claim or delete</a></span></li>` : "";
          })}</ul>`,
        )
      : ""}
    ${peak.components?.length
      ? section(
          "Components",
          html`<ul class="topo-comps">${peak.components.map(
            (c) => html`<li><strong>${c.name}</strong> <span class="mono sm t3">owns ${c.owns.join(", ")}${c.rules ? html` · rules: ${c.rules}` : ""}</span>${
              agentable(entry, hosted) ? html`<span class="topo-envs"><a href="${agentHref(entry, focusPrompt(peak, c))}">Focus agent</a></span>` : ""
            }</li>`,
          )}</ul>`,
        )
      : ""}
    ${docs.length
      ? section(
          "Docs",
          html`<p class="topo-chips">${docs.map(([key, path]) => {
            const href = fileHref(entry, path);
            return href ? html`<a href="${safeUrl(href)}"${newTab(safeUrl(href))} title="${path}">${key}</a>` : html`<span title="${path}">${key}</span>`;
          })}</p>`,
        )
      : ""}
  `;
}

function offCard(o: Off, model: TopoModel, hosted: boolean, pr?: PrOpts): Html {
  if (o.what === "orphan") {
    const like = o.like ? model.places.find((p) => p.key === o.like) : undefined;
    const kind = CF_NAMES[o.orphan.kind][0];
    const full = like?.entry.full;
    // A class goes on the worker entry that names its worker; a pattern or health.workers can't take it.
    const claimable = !!full && (o.orphan.kind !== "objects" || !!like!.entry.peak.runs?.workers?.some((w) => w.name === o.orphan.worker));
    const claim = pr && claimable
      ? Confirm({ kind: PR_KIND, action: "/topo/pr", fields: { what: "claim", repo: full!, kind: o.orphan.kind, name: o.orphan.name, ...(o.orphan.worker ? { worker: o.orphan.worker } : {}) }, label: `PR: claim it in ${like!.entry.repo}`, question: html`Open a PR on ${full} adding <code>${o.orphan.name}</code> to ${o.orphan.kind === "objects" ? html`<code>${o.orphan.worker}</code>'s objects` : html`<code>runs.${o.orphan.kind}</code>`} in ${like!.entry.file}?` })
      : "";
    return html`
      ${said(pr)}<div class="topo-ch"><h2>${offName(o)}</h2>${Pill({ children: kind })}</div>
      <p class="topo-sub">On Cloudflare, in no peak.yaml</p>
      ${findingBox({
        sev: "warn",
        tag: "unclaimed",
        why: `It's on Cloudflare, and no peak.yaml lists it under runs.${like ? ` The name looks like ${like.entry.full ?? like.entry.repo}'s.` : ""}`,
        fix: like ? `Add it under runs in ${like.entry.full ?? like.entry.repo}, or delete it if it's left over.` : "Add it under runs in the repo that deploys it, or delete it if it's left over. A name ending in * claims by prefix.",
      })}
      <div class="buttons">${like && agentable(like.entry, hosted) ? btn(agentHref(like.entry, claimPrompt(o.orphan, like.entry.file)), `Claim it in ${like.entry.repo}`, true) : ""}${claim}${like ? btn(`/topo?at=${encodeURIComponent(like.key)}`, `Go to ${like.entry.repo}`) : ""}</div>
    `;
  }
  const r = o.repo;
  const bare = o.what === "bare";
  const open = r.file ? fileHref(r, r.file) : undefined;
  const start = pr && bare && r.full ? startForm(r, pr) : "";
  return html`
    ${said(pr)}<div class="topo-ch"><h2>${r.repo}</h2>${Pill({ children: "repo" })}</div>
    <p class="topo-sub">${r.full ?? r.repo}</p>
    ${findingBox(
      bare
        ? { sev: "warn", tag: "coverage", why: "It's followed, but has no peak.yaml, so Topo knows nothing about it.", fix: "Write one. An agent can draft it from the repo." }
        : { sev: "bad", tag: "unreadable", why: `${r.file} can't be used: ${r.lines.join(" ")}`, fix: `Fix it, then run ${CHECK}.` },
    )}
    <div class="buttons">${
      agentable(r, hosted)
        ? bare
          ? btn(agentHref(r, draftPrompt()), "Write peak.yaml", true, "Start an agent session that drafts one")
          : btn(agentHref(r, fixPrompt({ file: r.file!, problems: r.lines })), "Fix with an agent", true, "Start an agent session that fixes it")
        : ""
    }${open ? btn(open, `Open ${r.file}`) : codeLink(r, "btn sm ghost")}</div>
    ${start}
  `;
}

/** A new peak.yaml in a PR: what it's called and who answers for it; the worker comes from its wrangler config. */
function startForm(r: Coverage, pr: PrOpts): Html {
  const short = r.repo.replace(/^.*\//, "");
  return section(
    "Or open a PR with a first one",
    html`<form method="post" action="/topo/pr" class="fields"><input type="hidden" name="what" value="start"><input type="hidden" name="repo" value="${r.full}">
      <label class="field"><span class="label">Name</span><input name="name" value="${short}" required maxlength="100"></label>
      <label class="field"><span class="label">Description</span><input name="description" maxlength="300" placeholder="Empty: the README's first paragraph"></label>
      <label class="field"><span class="label">Tier</span><select name="tier"><option>active</option><option>maintained</option><option>scratch</option></select></label>
      <label class="field"><span class="label">Owner</span><input name="owner" value="${pr.login ? `@${pr.login}` : ""}" maxlength="100"></label>
      <div class="field">${ConfirmSubmit({ kind: PR_KIND, label: "Open the PR", question: html`Open a PR on ${r.full} adding peak.yaml? The worker and its Durable Object classes come from its wrangler config, if it has one.` })}</div>
    </form>`,
  );
}

// ── The list ───────────────────────────────────────────────────────────────

function findingsCell(fs: RepoFinding[]): Html {
  return fs.length ? html`<span class="topo-sev ${worst(fs)}">${fs.length} ${fs.length === 1 ? "finding" : "findings"}</span>` : html`<span class="topo-sev ok">clear</span>`;
}

function listPanel(model: TopoModel, at: string, folded: Place[]): Html {
  const shown = model.places.filter((p) => !folded.includes(p));
  const runs = (p: Place) => Math.max(0, ...["production", ...Object.keys(p.entry.peak.environments ?? {})].map((env) => KINDS.reduce((n, k) => n + (runsIn(p.entry.peak, env)[k]?.length ?? 0), 0)));
  const row = (key: string, name: Child, tier: Child, n: Child, links: Child, f: Html) =>
    html`<tr class="${key === at ? "on" : ""}"><th scope="row"><a href="${atHref(key)}">${name}</a></th><td>${tier}</td><td>${n}</td><td>${links}</td><td>${f}</td></tr>`;
  return Panel({
    id: "topo-list",
    title: "All repos",
    meta: "The same places as a list",
    flush: true,
    children: html`<div class="topo-tw"><table class="topo-table"><thead><tr><th scope="col">Repo</th><th scope="col">Tier</th><th scope="col">Runs</th><th scope="col">Uses · used by</th><th scope="col">Findings</th></tr></thead><tbody>
${shown.map((p) => row(p.key, p.entry.repo, p.entry.peak.tier, runs(p) || "–", `${p.uses.length + p.services.length} · ${p.usedBy.length}`, findingsCell(p.findings)))}
${model.off.map((o) =>
  o.what === "orphan"
    ? row(o.key, html`<code>${offName(o)}</code>`, "unclaimed", CF_NAMES[o.orphan.kind][0], "–", html`<span class="topo-sev warn">no file claims it</span>`)
    : row(o.key, o.repo.full ?? o.repo.repo, "off the map", "?", "?", html`<span class="topo-sev ${o.what === "bare" ? "warn" : "bad"}">${o.what === "bare" ? "no peak.yaml" : "unreadable"}</span>`),
)}
</tbody></table></div>${
      folded.length
        ? html`<details class="topo-quiet"><summary>${folded.length} quiet repos: no links, no findings</summary><p class="topo-chips">${folded.map((p) => html`<a class="topo-pchip" href="${atHref(p.key)}">${p.entry.repo}</a>`)}</p></details>`
        : ""
    }`,
  });
}

// ── The page ───────────────────────────────────────────────────────────────

/** The place picked by `at`, else the one most worth a look: missing things first, then any findings, then the first. */
function picked(model: TopoModel, at?: string): string {
  const lower = (at ?? "").toLowerCase();
  if (lower && model.places.some((p) => p.key === lower)) return lower;
  const o = at ? model.off.find((x) => x.key === at || x.key === lower) : undefined;
  if (o) return o.key;
  const first = model.places.find((p) => p.findings.some((f) => f.sev === "bad")) ?? model.places.find((p) => p.findings.length) ?? model.places[0];
  return first?.key ?? model.off[0]?.key ?? "";
}

function notices(o: { reads?: { checkouts: boolean; forge: boolean }; unread?: { error?: string; failed: string[] }; drift?: DriftView; rules?: RulesView; map?: { unknown?: string }; unusable: number }): Html[] {
  const out: Html[] = [];
  if (o.reads && !o.reads.checkouts && !o.reads.forge) out.push(Notice({ tone: "warn", children: "Nothing to read: there's no code folder here, and the forge can't read repos' files." }));
  if (o.unread?.error) out.push(Notice({ tone: "warn", children: html`${o.unread.error}. What's shown is from the last read that worked.` }));
  if (o.unread?.failed.length) {
    out.push(Notice({ tone: "warn", children: html`Couldn't read ${o.unread.failed.length === 1 ? "one repo" : `${o.unread.failed.length} repos`} this time: ${o.unread.failed.slice(0, 8).join(", ")}${o.unread.failed.length > 8 ? ", …" : ""}.` }));
  }
  const d = o.drift;
  if (d && !d.configured && d.declares) out.push(Notice({ children: html`Set <code>CF_ACCOUNT_ID</code> and <code>CF_API_TOKEN</code> (read-only) in Settings to check what the files declare against Cloudflare.` }));
  if (d?.configured && d.read?.failed.length) {
    out.push(Notice({ tone: "warn", children: html`Couldn't read from Cloudflare this time, so these aren't checked: ${d.read.failed.map((f, i) => html`${i ? "; " : ""}${CF_NAMES[f.what][1]} (${f.why})`)}.` }));
  }
  if (d?.drift?.orphans.length && o.unusable) {
    out.push(Notice({ children: html`${o.unusable === 1 ? "One file has" : `${o.unusable} files have`} problems, so what ${o.unusable === 1 ? "it claims" : "they claim"} isn't counted: some unclaimed things may be theirs.` }));
  }
  if (o.rules?.unknown.length) {
    out.push(Notice({ tone: "warn", children: html`<code>TOPO_RULES_OFF</code> names ${o.rules.unknown.length === 1 ? "something that isn't a rule" : "things that aren't rules"}: ${o.rules.unknown.join(", ")}. The rules are ${RULES.map((x, i) => html`${i ? ", " : ""}<code>${x.id}</code>`)}.` }));
  }
  if (o.map?.unknown) out.push(Notice({ tone: "warn", children: html`<code>TOPO_MAP</code> is <code>${o.map.unknown}</code>, which isn't a style, so the map uses lanes. The styles are ${STYLES.map((s, i) => html`${i ? ", " : ""}<code>${s}</code>`)}.` }));
  return out;
}

/** The page's body; the pack's route puts it in Dovre's shell. */
export function topoPage(opts: {
  entries: TopoEntry[];
  /** Its coverage findings (TopoCatalog.coverage). */
  coverage?: Coverage[];
  /** What the forge couldn't read this time. */
  unread?: { error?: string; failed: string[] };
  /** What it can read from: checkouts here, the forge. */
  reads?: { checkouts: boolean; forge: boolean };
  hosted?: boolean;
  /** Drift against Cloudflare. */
  drift?: DriftView;
  /** Policy and dependency rules. */
  rules?: RulesView;
  /** The picked place: a repo's `owner/name`, or an off-the-map key. */
  at?: string;
  /** The TOPO_MAP setting, read. */
  map?: { style: MapStyle; unknown?: string };
  /** Fix PRs, when the forge can open them. */
  pr?: PrOpts;
}): Html {
  const { entries, coverage = [], unread, reads, hosted = false, drift, rules, map = { style: "lanes" as MapStyle } } = opts;
  const model = topoModel({ entries, coverage, findings: rules?.findings, drift: drift?.drift });
  const at = picked(model, opts.at);
  const pic = map.style === "off" || !model.places.length ? undefined : drawMap(model, map.style, at);

  const bad = model.places.reduce((n, p) => n + p.findings.filter((f) => f.sev === "bad").length, 0);
  const warn = model.places.reduce((n, p) => n + p.findings.filter((f) => f.sev === "warn").length, 0) + model.off.length;
  const clear = drift?.configured && drift.drift && !drift.drift.missing.length && !drift.drift.orphans.length;
  const sub = `${entries.length} cataloged ${entries.length === 1 ? "repo" : "repos"}${bad ? ` · ${bad} missing on Cloudflare` : ""}${warn ? ` · ${warn} to look at` : ""}${clear ? " · Cloudflare matches the files" : ""}. What each repo is, what it uses, and what's out of line.`;

  const place = model.places.find((p) => p.key === at);
  const off = place ? undefined : model.off.find((o) => o.key === at);
  const card = place ? repoCard(place, model, hosted, opts.pr) : off ? offCard(off, model, hosted, opts.pr) : "";
  const list = listPanel(model, at, pic?.folded ?? []);

  return html`
    ${PageHeader({
      title: "Topo",
      sub,
      actions: html`
        <a class="btn" href="/topo?refresh=1">Rescan</a>
        <a class="btn primary" href="/agents/new">New agent session</a>
      `,
    })}
    <div data-live id="topo">
      ${notices({ reads, unread, drift, rules, map, unusable: coverage.filter((f) => f.kind === "problems").length })}
      ${!model.places.length && !model.off.length
        ? Empty({ title: "No repos yet", children: html`<p>Topo draws a repo once it has a peak.yaml (the format: ${Link(SPEC_URL, "peak.yaml spec")}).</p>` })
        : html`<div class="topo-wrap">
            <section class="topo-main" aria-label="${pic ? "Map" : "Repos"}">${pic ? html`${mapSvg(pic, at, model.places.length, bad + warn)}${phoneBands(model, at)}${legend(map.style)}` : list}</section>
            ${card ? html`<aside class="topo-card" id="topo-card" aria-label="Picked">${card}</aside>` : ""}
          </div>
          ${pic ? list : ""}`}
    </div>
  `;
}

/** A place's findings, for an agent: each with its fix, and the check to run after. */
export const findingsPrompt = (file: string, fs: RepoFinding[]) =>
  `Topo found these in this repo's ${file} (the format: ${SPEC_URL}): ${fs.map((f) => `${f.why} ${f.fix}`).join(" ")} Fix what the file can fix where the repo says enough to, and ask me about the rest (anything on Cloudflare included). Then run \`${CHECK}\`.`;

/** Something on Cloudflare no file claims, whose name looks like this repo's. */
export const claimPrompt = (o: Orphan, file: string) =>
  `The ${CF_NAMES[o.kind][0]} ${o.worker ? `${o.worker}/` : ""}${o.name} is on Cloudflare and no peak.yaml claims it; its name looks like this repo's. If this repo deploys it, add it under runs in ${file} (the format: ${SPEC_URL}), then run \`${CHECK}\`. If it doesn't, say so and stop.`;

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

/** What Bino is told about the rules: a line per finding, within `max` characters. */
export function ruleLines(findings: Finding[], max = 300): string {
  if (!findings.length) return "";
  const lines = ["Against the peak.yaml rules:", ...findings.map((f) => `- ${f.repo} (${f.rule}): ${f.why}`.slice(0, 200))];
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
