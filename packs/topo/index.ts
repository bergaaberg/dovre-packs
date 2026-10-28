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
 * each repo uses; TOPO_RULES_OFF switches some off.
 */
import { listRepos } from "dovre/sources/claude.ts";
import { WORK } from "dovre/agents/workdir.ts";
import { type Pack, PACK_API, type PackContext } from "dovre/packs/types.ts";
import { TopoCatalog } from "./catalog.ts";
import { CloudInventory } from "./cloud.ts";
import { declaresCloudflare, drift } from "./drift.ts";
import { ForgeCatalog } from "./forge.ts";
import { checkRules, rulesOff } from "./rules.ts";
import { TopoScanner } from "./scan.ts";
import { binoLines, componentField, driftLines, type DriftView, prFacts, prLead, projectsPanel, ruleLines, type RulesView, rulesSettings, topoPage } from "./view.ts";

export { TopoScanner, type TopoEntry, type TopoProblem, type TopoRepo } from "./scan.ts";
export { ForgeCatalog, type ForgeRead } from "./forge.ts";
export { TopoCatalog, type Coverage } from "./catalog.ts";
export { CloudInventory, type CloudRead } from "./cloud.ts";
export { drift, type Drift, type Missing, type Orphan } from "./drift.ts";
export { checkRules, type Finding, RULES, type RuleId, rulesOff } from "./rules.ts";

export type TopoDeps = {
  /** Keeps what it read for 30 s; default: one over `ctx.codeDir` (none without a code folder). */
  scanner?: TopoScanner;
  /** Keeps what it read for 15 min; default: one over `ctx.forge()`. */
  forge?: ForgeCatalog;
  /** Keeps what it read for 15 min; default: one over the CF_ACCOUNT_ID and CF_API_TOKEN settings. */
  cloud?: CloudInventory;
};

const CSS = `.topo-rule { margin-left: .5rem; opacity: .8; }
.topo-finding { display: block; }`;

export function createTopoPack(o: TopoDeps = {}): Pack {
  let catalog: TopoCatalog | undefined;
  let cloud: CloudInventory | undefined;
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
      ],
      // Topo was called Atlas: old links and bookmarks land on /topo.
      paths: ["atlas"],
    },
    init: (ctx) => void of(ctx),
    refresh: (ctx) => reload(ctx),
    styles: CSS,
    nav: () => [{ href: "/topo", title: "Topo", icon: "contours", group: "Code" }],
    pages: () => [{ title: "Topo", href: "/topo", icon: "⎈", about: "The map of your repos: what each is, its components, rules and docs", also: ["topo", "atlas", "map", "peak", "range", "catalog", "manifest", "repos", "coverage"] }],
    // Within Bino's 1500 characters a pack: drift first (what to act on), then the rules, then the repos.
    bino: (ctx) => {
      const d = driftLines(driftOf(ctx).drift, 500);
      const r = ruleLines(rulesOf(ctx).findings, 300);
      return [d, r, binoLines(of(ctx).list(), 1400 - d.length - r.length)].filter(Boolean).join("\n");
    },
    settings: (ctx) => {
      const { off, unknown } = rulesOff(ctx.env.TOPO_RULES_OFF);
      return rulesSettings(off, unknown);
    },
    slots: (ctx) => ({
      "agents.new": ({ repo }) => componentField(repo, of(ctx).get(repo)),
      "pr.lead": ({ repo }) => prLead(of(ctx).get(repo)),
      "pr.facts": ({ repo }) => prFacts(of(ctx).entry(repo)),
      "work.new": () => projectsPanel(of(ctx).list(), ctx.hosted),
    }),
    routes: (app, ctx) => {
      app.get("/atlas", (c) => c.redirect(`/topo${new URL(c.req.url).search}`, 301));
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
          body: topoPage({ entries: t.list(), coverage: t.coverage(), unread: t.unread(), filter: c.req.query("tier"), hosted: ctx.hosted, reads: { checkouts: !!t.scanner, forge: !!t.forge?.can() }, drift: driftOf(ctx), rules: rulesOf(ctx) }),
        });
      });
    },
  };
}

export const topoPack = createTopoPack();
