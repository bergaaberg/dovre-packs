/**
 * Topo (dovre#147): what each repo is, from its peak.yaml (bergaaberg/peak). Locally it reads the
 * checkouts right under the code folder, and the forge's copies (default branch) for the followed
 * repos that aren't checked out; hosted it reads the forge only (dovre-packs#68 step 1). Its page
 * (/topo, with coverage: repos without a file, files with problems or warnings), Bino's lines about
 * the repos, and what it puts in core pages through slots: the component picker on /agents/new, a
 * PR's tier and docs on /prs, the Projects on New work. It needs `@bergaaberg/peak` in the instance
 * (`pnpm add github:bergaaberg/peak#v0.2.0`).
 */
import { listRepos } from "dovre/sources/claude.ts";
import { WORK } from "dovre/agents/workdir.ts";
import { type Pack, PACK_API, type PackContext } from "dovre/packs/types.ts";
import { TopoCatalog } from "./catalog.ts";
import { ForgeCatalog } from "./forge.ts";
import { TopoScanner } from "./scan.ts";
import { binoLines, componentField, prFacts, prLead, projectsPanel, topoPage } from "./view.ts";

export { TopoScanner, type TopoEntry, type TopoProblem, type TopoRepo } from "./scan.ts";
export { ForgeCatalog, type ForgeRead } from "./forge.ts";
export { TopoCatalog, type Coverage } from "./catalog.ts";

export type TopoDeps = {
  /** Keeps what it read for 30 s; default: one over `ctx.codeDir` (none without a code folder). */
  scanner?: TopoScanner;
  /** Keeps what it read for 15 min; default: one over `ctx.forge()`. */
  forge?: ForgeCatalog;
};

const CSS = `.topo-rule { margin-left: .5rem; opacity: .8; }`;

export function createTopoPack(o: TopoDeps = {}): Pack {
  let catalog: TopoCatalog | undefined;
  /** The catalog over the code folder and the forge (made on first use, so every hook works before init too). */
  const of = (ctx: PackContext): TopoCatalog => {
    if (catalog) return catalog;
    const codeDir = ctx.hosted ? undefined : ctx.codeDir;
    const scanner = o.scanner ?? (codeDir ? new TopoScanner(codeDir) : undefined);
    const forge = o.forge ?? new ForgeCatalog({ forge: () => ctx.forge() });
    const checkouts = () => (codeDir ? listRepos(codeDir).filter((r) => r !== WORK) : []);
    return (catalog = new TopoCatalog({ scanner, forge, checkouts }));
  };
  /** A fresh forge read, then the page's region redrawn. */
  const reload = async (ctx: PackContext, force = false) => {
    const f = of(ctx).forge;
    if (!f?.can()) return;
    const before = f.peek();
    const after = await f.load(force);
    if (after !== before) ctx.publish(["topo"]);
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
      // Topo was called Atlas: old links and bookmarks land on /topo.
      paths: ["atlas"],
    },
    init: (ctx) => void of(ctx),
    refresh: (ctx) => reload(ctx),
    styles: CSS,
    nav: () => [{ href: "/topo", title: "Topo", icon: "contours", group: "Code" }],
    pages: () => [{ title: "Topo", href: "/topo", icon: "⎈", about: "The map of your repos: what each is, its components, rules and docs", also: ["topo", "atlas", "map", "peak", "range", "catalog", "manifest", "repos", "coverage"] }],
    bino: (ctx) => binoLines(of(ctx).list()),
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
          body: topoPage({ entries: t.list(), coverage: t.coverage(), unread: t.unread(), filter: c.req.query("tier"), hosted: ctx.hosted, reads: { checkouts: !!t.scanner, forge: !!t.forge?.can() } }),
        });
      });
    },
  };
}

export const topoPack = createTopoPack();
