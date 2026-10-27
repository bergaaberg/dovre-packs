/**
 * Topo (dovre#147): what each repo is, from the peak.yaml (bergaaberg/peak) at the root of each
 * checkout right under the code folder. Its page (/topo), Bino's lines about the repos, and what it
 * puts in core pages through slots: the component picker on /agents/new, a PR's tier and docs on
 * /prs, the Projects on New work. Local only: it reads the checkouts (`ctx.codeDir`). It needs
 * `@bergaaberg/peak` in the instance (`pnpm add github:bergaaberg/peak#v0.1.0`).
 */
import { listRepos } from "dovre/sources/claude.ts";
import { WORK } from "dovre/agents/workdir.ts";
import { type Pack, PACK_API, type PackContext } from "dovre/packs/types.ts";
import { TopoScanner } from "./scan.ts";
import { binoLines, componentField, prFacts, prLead, projectsPanel, topoPage } from "./view.ts";

export { TopoScanner, type TopoEntry, type TopoProblem } from "./scan.ts";

export type TopoDeps = {
  /** Keeps what it read for 30 s; default: one over `ctx.codeDir`. */
  scanner?: TopoScanner;
};

const CSS = `.topo-rule { margin-left: .5rem; opacity: .8; }`;

export function createTopoPack(o: TopoDeps = {}): Pack {
  let scanner = o.scanner;
  /** The scanner over the code folder (made on first use, so every hook works before init too). */
  const of = (ctx: PackContext): TopoScanner => {
    if (scanner) return scanner;
    if (!ctx.codeDir) throw new Error("no code folder (CODE_DIR)");
    return (scanner = new TopoScanner(ctx.codeDir));
  };
  return {
    manifest: {
      api: PACK_API,
      id: "topo",
      name: "Topo",
      description: "What each repo is, from its peak.yaml: tier, components, rules and docs",
      domain: "general",
      execution: "local-only",
      // Topo was called Atlas: old links and bookmarks land on /topo.
      paths: ["atlas"],
    },
    init: (ctx) => void of(ctx),
    styles: CSS,
    nav: () => [{ href: "/topo", title: "Topo", icon: "contours", group: "Code" }],
    pages: () => [{ title: "Topo", href: "/topo", icon: "⎈", about: "The map of your repos: what each is, its components, rules and docs", also: ["topo", "atlas", "map", "peak", "range", "catalog", "manifest", "repos"] }],
    bino: (ctx) => binoLines(of(ctx).list()),
    slots: (ctx) => ({
      "agents.new": ({ repo }) => componentField(repo, of(ctx).get(repo)),
      "pr.lead": ({ repo }) => prLead(of(ctx).get(repo)),
      "pr.facts": ({ repo }) => prFacts(repo, of(ctx).get(repo)),
      "work.new": () => projectsPanel(of(ctx).list()),
    }),
    routes: (app, ctx) => {
      app.get("/atlas", (c) => c.redirect(`/topo${new URL(c.req.url).search}`, 301));
      app.get("/topo", (c) => {
        const s = of(ctx);
        if (c.req.query("refresh") === "1" || c.req.query("fresh") === "1") s.scan(true);
        const entries = s.list();
        const problems = s.problems();
        const broken = new Set(problems.map((p) => p.repo));
        const bare = listRepos(ctx.codeDir!).filter((r) => r !== WORK && !s.get(r) && !broken.has(r));
        return ctx.page(c, { title: "Topo · Dovre", current: "/topo", body: topoPage({ entries, bare, problems, filter: c.req.query("tier") }) });
      });
    },
  };
}

export const topoPack = createTopoPack();
