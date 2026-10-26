/**
 * Jira Pack (`jira`): what's assigned to me and not done, what moved lately in the projects I
 * follow, a Today card, Jira in search, and ticket keys (`PROJ-123`) as links.
 *
 * Two ways to Jira (JIRA_VIA): `rest` with an API token, or `mcp` through Claude Code's Atlassian
 * MCP where tokens are locked down (mcp.ts; local only). A job through the MCP takes ~15 s and a
 * little money, so it runs every JIRA_EVERY_MIN (10) or on "Read now", never per page; a job that
 * fails keeps the last good answer, which is also kept on disk so a restart has something to draw.
 */
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { keptFile, type Kept } from "dovre/issues/templates.ts";
import { type FindItem, type Pack, PACK_API, type PackContext } from "dovre/packs/types.ts";
import { type JiraKept, projectsOf, readJira, siteOf, siteOk, viaOf } from "./data.ts";
import { type Agent, JiraSetupError, loadViaMcp } from "./mcp.ts";
import { jiraCard, jiraPage } from "./view.ts";

const everyMsOf = (env: Record<string, string | undefined>) => {
  const min = Number(env.JIRA_EVERY_MIN);
  return (Number.isFinite(min) && min >= 2 ? Math.min(min, 240) : 10) * 60_000;
};

/** The agent as a server runs it: off the main thread, in an empty folder of its own (no CLAUDE.md or project settings to pick up). */
async function serverAgent(): Promise<Agent> {
  const [{ runOff }, { mkdirSync }] = await Promise.all([import("dovre/spawn.ts"), import("node:fs")]);
  const cwd = join(tmpdir(), "dovre-jira");
  mkdirSync(cwd, { recursive: true });
  return { run: runOff, cwd };
}

export function createJiraPack(
  opts: {
    fetchFn?: typeof fetch;
    /** For tests: the MCP agent (default: claude on the PATH, off the main thread). */
    agent?: Agent;
    /** For tests: where the last answer is kept (default: data/jira-kept.json beside Dovre's database). */
    kept?: Kept;
    now?: () => number;
  } = {},
): Pack & { kept(): JiraKept | undefined } {
  const now = opts.now ?? Date.now;
  let kept: JiraKept | undefined;
  let agent: Agent | undefined;
  let store: Kept | undefined;
  /** When the last MCP job started: the cadence counts from attempts, so a signed-out MCP isn't asked every round. */
  let triedAt = Number.NEGATIVE_INFINITY;
  let force = false;

  async function readMcp(ctx: PackContext): Promise<void> {
    const site = siteOf(ctx.env);
    if (!force && now() - triedAt < everyMsOf(ctx.env)) return;
    force = false;
    triedAt = now();
    agent ??= opts.agent ?? (await serverAgent());
    try {
      const r = await loadViaMcp(agent, site, projectsOf(ctx.env), ctx.env.JIRA_JQL?.trim() || undefined);
      ctx.log(`via mcp: ${r.mine.length} mine, ${r.moving.length} moving, $${r.cost.toFixed(4)}`);
      kept = { at: now(), ok: true, site, via: "mcp", mine: r.mine, moving: r.moving };
      store?.set("jira", { at: kept.at, value: kept });
    } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 200);
      ctx.log(`via mcp: ${error}`);
      // The last good answer stays; with none, the failure is what there is.
      if (!kept?.ok) kept = { at: now(), ok: false, site, via: "mcp", error, mine: [], moving: [], ...(e instanceof JiraSetupError ? { setup: e.setup } : {}) };
    }
  }

  async function refresh(ctx: PackContext): Promise<void> {
    if (viaOf(ctx.env) === "mcp") await readMcp(ctx);
    else kept = await readJira(ctx, opts.fetchFn, now());
    ctx.publish(["jira", "snapshot"]);
  }

  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "jira",
      name: "Jira",
      description: "Jira issues assigned to me, what moved in my projects, and ticket keys as links.",
      domain: "work",
      execution: "any",
      everyMs: 5 * 60_000,
      settings: [
        { key: "JIRA_SITE", label: "Jira hostname", required: true, help: "e.g. your-org.atlassian.net" },
        { key: "JIRA_VIA", label: "How to reach Jira", help: "rest (an API token), mcp (Claude Code's Atlassian MCP, where tokens are locked down; local only) or off. Unset: rest with a token, else off." },
        { key: "JIRA_EMAIL", label: "Jira account email", help: "For Atlassian Cloud Basic auth (rest)" },
        { key: "JIRA_TOKEN", label: "Jira API token", secret: true, help: "For rest" },
        { key: "JIRA_PROJECTS", label: "Projects to watch", help: "Jira keys, comma-separated: what moved in them in 3 days, and which keys become links" },
        { key: "JIRA_JQL", label: "Mine (JQL)", help: "Default: assigned to me and not done" },
        { key: "JIRA_EVERY_MIN", label: "Read every (minutes, mcp)", help: "Each read through the MCP is an agent job (default 10)" },
      ],
    },
    available: (ctx) => {
      const via = viaOf(ctx.env);
      if (via === "off" || !siteOk(siteOf(ctx.env))) return false;
      return via === "rest" ? !!ctx.env.JIRA_TOKEN?.trim() : !ctx.hosted;
    },
    init(ctx) {
      if (viaOf(ctx.env) !== "mcp") return;
      store = opts.kept ?? keptFile(join(dirname(resolve(ctx.env.U_DB || "data/dovre.sqlite")), "jira-kept.json"));
      const last = store.get("jira")?.value as JiraKept | undefined;
      kept = last?.ok && last.site === siteOf(ctx.env) ? last : { at: now(), ok: false, site: siteOf(ctx.env), via: "mcp", setup: "waiting", error: "", mine: [], moving: [] };
    },
    refresh,
    nav: () => [{ href: "/jira", title: "Jira", icon: "ticket", group: "Plan" }],
    pages: () => [{ title: "Jira", href: "/jira", icon: "🎫", about: "Jira issues: mine, and what moved in my projects", also: ["tickets", "sprint", "saker"] }],
    routes(app, ctx) {
      app.get("/jira", (c) => ctx.page(c, { title: "Jira", body: jiraPage(kept, { refresh: true }) }));
      /** Read Jira now, past the cadence; the page fills in when it lands. */
      app.post("/jira/refresh", (c) => {
        force = true;
        triedAt = Number.NEGATIVE_INFINITY;
        void refresh(ctx);
        return c.redirect("/jira", 303);
      });
    },
    today: () => (kept ? [{ id: "now", render: jiraCard(kept) }] : []),
    finds: () => {
      if (!kept?.ok) return [];
      const seen = new Set<string>();
      const out: FindItem[] = [];
      for (const i of [...kept.mine, ...kept.moving]) {
        if (seen.has(i.key)) continue;
        seen.add(i.key);
        out.push({ title: `${i.key} ${i.summary}`, sub: [i.status, i.assignee].filter(Boolean).join(" · "), href: i.url, also: [i.key, i.project], icon: "🎫" });
      }
      return out;
    },
    /** Ticket keys as links: only in the projects I watch or have issues in, once any are known; until then any key-shaped text. */
    refs: (ctx) => {
      const site = siteOf(ctx.env);
      if (!siteOk(site)) return [];
      const projects = new Set([...projectsOf(ctx.env), ...(kept?.mine ?? []).map((i) => i.project)]);
      const pattern = projects.size ? new RegExp(`\\b(?:${[...projects].join("|")})-\\d{1,9}\\b`, "g") : /\b[A-Z][A-Z0-9_]{1,9}-\d{1,6}\b/g;
      return [{ pattern, href: (m) => `https://${site}/browse/${encodeURIComponent(m)}` }];
    },
    bino: () => {
      if (!kept?.ok) return "";
      const mine = kept.mine.map((i) => `${i.key} [${i.status}]: ${i.summary}`);
      const moved = new Map<string, number>();
      for (const i of kept.moving) moved.set(i.project, (moved.get(i.project) ?? 0) + 1);
      return [mine.length ? `Mine in Jira:\n${mine.join("\n")}` : "Nothing in Jira assigned to me.", ...[...moved].map(([p, n]) => `${n} moved in ${p} in 3 days.`)].join("\n");
    },
  };
}

export const jiraPack: Pack = createJiraPack();
export const jiraCrate = jiraPack;
