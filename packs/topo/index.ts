/**
 * Topo (dovre#147): what each repo is, from its peak.yaml (bergaaberg/peak). Locally it reads the
 * checkouts right under the code folder, and the forge's copies (default branch) for the followed
 * repos that aren't checked out; hosted it reads the forge only (dovre-packs#68 step 1). Its page
 * (/topo, with coverage: repos without a file, files with problems or warnings), Bino's lines about
 * the repos, and what it puts in core pages through slots: the component picker on /agents/new, a
 * PR's tier and docs on /prs, the Projects on New work. It needs `@bergaaberg/peak` in the instance
 * (`pnpm add github:bergaaberg/peak#v0.2.0`). With a Cloudflare account and a read-only token set,
 * it also checks drift (step 2): what the files declare on Cloudflare and isn't there, and what's
 * there that no file claims. Its rules (step 3) check owners, components, scratch repos and what
 * each repo uses; TOPO_RULES_OFF switches some off. The page draws it all as a map (dovre-packs#72):
 * the repos by tier, what each uses, and the findings on the repo they're about; TOPO_MAP picks the
 * style (lanes, rings, terrain, or off for the list alone). Drift is a need on Today, ringing as
 * topo-drift once switched on, and Today's opening line says which repos are out of line (step 4).
 * Where the forge can open PRs (dovre#203), a card offers one fixing the file (step 5, fix.ts):
 * claim an orphan, take out a missing entry, or start a peak.yaml, each behind a Confirm of kind
 * topo.peak-pr.
 */
import { listRepos } from "dovre/sources/claude.ts";
import { strictOrigin } from "dovre/strict.ts";
import { WORK } from "dovre/agents/workdir.ts";
import { type Pack, PACK_API, type PackContext } from "dovre/packs/types.ts";
import { TopoCatalog } from "./catalog.ts";
import { CloudInventory } from "./cloud.ts";
import { declaresCloudflare, drift } from "./drift.ts";
import { type FixDone, runFix, WRITE } from "./fix.ts";
import { ForgeCatalog } from "./forge.ts";
import { mapStyle } from "./map.ts";
import { driftNeeds, RING, topoBrief } from "./needs.ts";
import { checkRules, rulesOff } from "./rules.ts";
import { TopoScanner } from "./scan.ts";
import { CSS } from "./style.ts";
import { binoLines, componentField, driftLines, type DriftView, prFacts, prLead, projectsPanel, ruleLines, type RulesView, rulesSettings, topoPage } from "./view.ts";

export { TopoScanner, type TopoEntry, type TopoProblem, type TopoRepo } from "./scan.ts";
export { ForgeCatalog, type ForgeRead } from "./forge.ts";
export { TopoCatalog, type Coverage } from "./catalog.ts";
export { CloudInventory, type CloudRead } from "./cloud.ts";
export { drift, type Drift, type Missing, type Orphan } from "./drift.ts";
export { checkRules, type Finding, RULES, type RuleId, rulesOff } from "./rules.ts";
export { driftNeeds, RING, topoBrief } from "./needs.ts";
export { drawMap, mapStyle, type MapStyle, STYLES, topoModel } from "./map.ts";
export { claimText, dropText, runFix, startText, wranglerRuns } from "./fix.ts";

export type TopoDeps = {
  /** Keeps what it read for 30 s; default: one over `ctx.codeDir` (none without a code folder). */
  scanner?: TopoScanner;
  /** Keeps what it read for 15 min; default: one over `ctx.forge()`. */
  forge?: ForgeCatalog;
  /** Keeps what it read for 15 min; default: one over the CF_ACCOUNT_ID and CF_API_TOKEN settings. */
  cloud?: CloudInventory;
};

export function createTopoPack(o: TopoDeps = {}): Pack {
  let catalog: TopoCatalog | undefined;
  let cloud: CloudInventory | undefined;
  /** How the last fix PR went, by the place it was asked from: shown once on its card. */
  const done = new Map<string, FixDone>();
  const cloudOf = (ctx: PackContext) => (cloud ??= o.cloud ?? new CloudInventory({ env: () => ({ account: ctx.env.CF_ACCOUNT_ID, token: ctx.env.CF_API_TOKEN }) }));
  /** Drift as of the last reads: the files against the last Cloudflare read. */
  const driftOf = (ctx: PackContext): DriftView => {
    const c = cloudOf(ctx);
    const entries = of(ctx).list();
    const read = c.configured() ? c.peek() : undefined;
    return { configured: c.configured(), read, drift: read ? drift(entries, read) : undefined, declares: declaresCloudflare(entries) };
  };
  /** The rule findings as of the last reads. */
  const rulesOf = (ctx: PackContext): RulesView => {
    const t = of(ctx);
    const { off, unknown } = rulesOff(ctx.env.TOPO_RULES_OFF);
    const f = ctx.forge();
    const read = t.forge?.peek();
    const findings = checkRules({
      entries: t.list(),
      problems: t.problems(),
      bare: t.bare(),
      owners: (f?.owners ?? "").split(",").map((o) => o.trim()).filter(Boolean),
      followedKnown: !!read && !read.error,
      unread: read?.failed,
      off,
    });
    return { findings, off, unknown };
  };
  /** The catalog over the code folder and the forge (made on first use, so every hook works before init too). */
  const of = (ctx: PackContext): TopoCatalog => {
    if (catalog) return catalog;
    const codeDir = ctx.hosted ? undefined : ctx.codeDir;
    const scanner = o.scanner ?? (codeDir ? new TopoScanner(codeDir) : undefined);
    const forge = o.forge ?? new ForgeCatalog({ forge: () => ctx.forge() });
    const checkouts = () => (codeDir ? listRepos(codeDir).filter((r) => r !== WORK) : []);
    return (catalog = new TopoCatalog({ scanner, forge, checkouts }));
  };
  /** Fresh forge and Cloudflare reads, then the page's region redrawn. */
  const reload = async (ctx: PackContext, force = false) => {
    const f = of(ctx).forge;
    const c = cloudOf(ctx);
    const before = [f?.peek(), c.peek()];
    const after = await Promise.all([f?.can() ? f.load(force) : before[0], c.load(force)]);
    if (after.some((r, i) => r !== before[i])) ctx.publish(["topo"]);
  };
  return {
    manifest: {
      api: PACK_API,
      id: "topo",
      name: "Topo",
      description: "What each repo is, from its peak.yaml: tier, components, rules and docs, and which repos have none",
      domain: "general",
      execution: "any",
      everyMs: 15 * 60_000,
      settings: [
        { key: "CF_ACCOUNT_ID", label: "Cloudflare account id", help: "For drift: what the peak.yaml files declare on Cloudflare against what's there." },
        {
          key: "CF_API_TOKEN",
          label: "Cloudflare API token (read-only)",
          secret: true,
          help: "Workers Scripts, D1, Workers KV Storage, Workers R2 Storage and Queues Read. Without it Topo doesn't check drift.",
        },
        { key: "TOPO_RULES_OFF", label: "Rules switched off", help: "Rule ids, comma-separated: owner, component, scratch-runs-nothing, uses. Every rule is on unless named here." },
        { key: "TOPO_MAP", label: "Map style", help: "lanes (the default: a lane per tier), rings (active in the middle), terrain (active at the summit), or off (the list alone)." },
      ],
      rings: [{ kind: RING, label: "Topo finds drift", hint: "Something a peak.yaml declares isn't on Cloudflare, or something there is in no peak.yaml", off: true }],
      // Topo was called Atlas: old links and bookmarks land on /topo.
      paths: ["atlas"],
    },
    writes: [{ kind: WRITE, label: "Open a PR fixing a repo's peak.yaml" }],
    init: (ctx) => void of(ctx),
    refresh: (ctx) => reload(ctx),
    styles: CSS,
    nav: () => [{ href: "/topo", title: "Topo", icon: "contours", group: "Code" }],
    pages: () => [{ title: "Topo", href: "/topo", icon: "⎈", about: "The map of your repos: what each is and uses, by tier, with what's out of line drawn on it", also: ["topo", "atlas", "map", "peak", "range", "catalog", "manifest", "repos", "coverage"] }],
    needs: (ctx) => {
      const d = driftOf(ctx);
      return d.read ? driftNeeds(d.drift, d.read.at) : [];
    },
    brief: (ctx) => topoBrief({ drift: driftOf(ctx).drift, findings: rulesOf(ctx).findings, problems: of(ctx).problems() }),
    // Within Bino's 1500 characters a pack: drift first (what to act on), then the rules, then the repos.
    bino: (ctx) => {
      const d = driftLines(driftOf(ctx).drift, 500);
      const r = ruleLines(rulesOf(ctx).findings, 300);
      return [d, r, binoLines(of(ctx).list(), 1400 - d.length - r.length)].filter(Boolean).join("\n");
    },
    settings: (ctx) => {
      const { off, unknown } = rulesOff(ctx.env.TOPO_RULES_OFF);
      return rulesSettings(off, unknown, mapStyle(ctx.env.TOPO_MAP));
    },
    slots: (ctx) => ({
      "agents.new": ({ repo }) => componentField(repo, of(ctx).get(repo)),
      "pr.lead": ({ repo }) => prLead(of(ctx).get(repo)),
      "pr.facts": ({ repo }) => prFacts(of(ctx).entry(repo)),
      "work.new": () => projectsPanel(of(ctx).list(), ctx.hosted),
    }),
    routes: (app, ctx) => {
      app.get("/atlas", (c) => c.redirect(`/topo${new URL(c.req.url).search}`, 301));
      /** Fix PRs on the page, when the forge opens them, with how the last one asked from `at` went (once). */
      const prOpts = (at?: string) => {
        const f = ctx.forge();
        if (!f?.propose || !f.file) return undefined;
        const key = (at ?? "").toLowerCase();
        const said = done.get(key);
        done.delete(key);
        return { login: f.login, ...(said ? { said: { ok: said.ok, text: said.text, ...(said.ok ? { url: said.url } : {}) } } : {}) };
      };
      app.use("/topo/pr", strictOrigin);
      app.post("/topo/pr", async (c) => {
        const t = of(ctx);
        const r = await runFix(await c.req.parseBody(), { entries: t.list(), drift: driftOf(ctx).drift, bare: t.bare() }, ctx.forge());
        if (done.size > 50) done.clear();
        done.set(r.key, r);
        // The PR's branch changes nothing on the default branch, so the reads stay as they are.
        return c.redirect(`/topo?at=${encodeURIComponent(r.key)}`, 303);
      });
      app.get("/topo", async (c) => {
        const t = of(ctx);
        const force = c.req.query("refresh") === "1" || c.req.query("fresh") === "1";
        if (force) t.scanner?.scan(true);
        // The forge is known after the first gather; a first visit waits for it, as core pages do.
        if (!ctx.forge()) await ctx.gathered();
        await reload(ctx, force).catch((e) => ctx.log(`topo: ${String((e as Error)?.message ?? e)}`));
        return ctx.page(c, {
          title: "Topo · Dovre",
          current: "/topo",
          body: topoPage({
            entries: t.list(),
            coverage: t.coverage(),
            unread: t.unread(),
            hosted: ctx.hosted,
            reads: { checkouts: !!t.scanner, forge: !!t.forge?.can() },
            drift: driftOf(ctx),
            rules: rulesOf(ctx),
            at: c.req.query("at"),
            map: mapStyle(ctx.env.TOPO_MAP),
            pr: prOpts(c.req.query("at")),
          }),
        });
      });
    },
  };
}

export const topoPack = createTopoPack();
