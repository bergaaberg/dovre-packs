/**
 * Linear Pack (`linear`): assigned open issues, active cycle progress, un-triaged team issues,
 * `TEAM-123` reference linking, Today's glance and opening line, Bino lookups (an issue by key,
 * a title search; agents get them as tools too) and Bino acts (create an issue, comment on one).
 *
 * PR pills (`pr.lead`, `pr.facts`): a PR whose branch or title names an issue the pack keeps (assigned
 * to you, or un-triaged in a team) gets that issue's pill and a Linear row. Keys match in any case,
 * for Linear's own lower-case branch names (`someone/eng-123-fix-it`). An issue not kept draws nothing.
 */
import { type Pack, PACK_API, type RefRule } from "dovre/packs/types.ts";
import { commentAct, createAct } from "dovre/packs/acts.ts";
import { checkIssue, commentIssue, createIssue, type LinearIssue, type LinearKept, lookIssue, PRIORITY, readLinear, searchIssues } from "./data.ts";
import { linearCard, linearFact, linearLead, linearPage } from "./view.ts";

/** The keys this Dovre links: the configured team, else every team key seen in the data. */
function refPattern(envTeam: string | undefined, kept: LinearKept | undefined): RegExp | null {
  const keys = [envTeam?.trim().toUpperCase(), ...(kept?.teams ?? []).map((t) => t.key), ...(kept?.mine ?? []).map((i) => i.team)]
    .filter((k): k is string => !!k && /^[A-Z][A-Z0-9]{0,9}$/.test(k));
  const uniq = [...new Set(keys)];
  if (!uniq.length) return null;
  return new RegExp(`\\b(?:${uniq.join("|")})-\\d{1,7}\\b`, "g");
}

/** The kept issue a PR's branch or title names (the key in any case), if the pack keeps it. */
function issueFor(kept: LinearKept | undefined, envTeam: string | undefined, pr: { branch?: string; title?: string }): LinearIssue | undefined {
  const pattern = refPattern(envTeam, kept);
  if (!kept?.ok || !pattern) return undefined;
  const all = [...kept.mine, ...kept.teams.flatMap((t) => t.untriaged)];
  for (const text of [pr.branch, pr.title]) {
    for (const m of (text ?? "").toUpperCase().matchAll(pattern)) {
      const found = all.find((i) => i.key.toUpperCase() === m[0]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Each issue's link through `href`, when one is given. */
function relink(k: LinearKept, href: ((key: string) => string) | undefined): LinearKept {
  if (!href) return k;
  const one = (i: LinearIssue) => ({ ...i, url: href(i.key) });
  return { ...k, mine: k.mine.map(one), teams: k.teams.map((t) => ({ ...t, untriaged: t.untriaged.map(one) })) };
}

export function createLinearPack(
  opts: {
    fetchFn?: typeof fetch;
    /** Where an issue's link points, in place of linear.app (the public demo's "External link" page). */
    issueHref?: (key: string) => string;
  } = {},
): Pack & { kept(): LinearKept | undefined } {
  const fetchFn = opts.fetchFn ?? fetch;
  let kept: LinearKept | undefined;
  const read = async (ctx: Parameters<typeof readLinear>[0]) => relink(await readLinear(ctx, fetchFn), opts.issueHref);
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "linear",
      name: "Linear",
      description: "Assigned Linear issues, cycle progress, un-triaged team issues and TEAM-123 linking.",
      domain: "work",
      execution: "any",
      everyMs: 5 * 60_000,
      settings: [
        { key: "LINEAR_API_KEY", label: "Linear API key", secret: true, required: true, help: "A personal API key (or OAuth token) for api.linear.app" },
        { key: "LINEAR_TEAM", label: "Team key", help: "Only this team (e.g. ENG); empty means every team you're in" },
      ],
    },
    async refresh(ctx) {
      kept = await read(ctx);
      ctx.publish(["linear", "snapshot"]);
    },
    slots: (ctx) => ({
      "pr.lead": (pr) => {
        const issue = issueFor(kept, ctx.env.LINEAR_TEAM, pr);
        return issue ? linearLead(issue) : "";
      },
      "pr.facts": (pr) => {
        const issue = issueFor(kept, ctx.env.LINEAR_TEAM, pr);
        return issue ? [["Linear", linearFact(issue)]] : [];
      },
    }),
    nav: () => [{ href: "/linear", title: "Linear", icon: "ticket", group: "Code" }],
    pages: () => [{ title: "Linear", href: "/linear", icon: "🎫", about: "Assigned Linear issues", also: ["issues", "cycle"] }],
    routes(app, ctx) {
      app.get("/linear", (c) => ctx.page(c, { title: "Linear", body: linearPage(kept) }));
    },
    today: () => (kept ? [{ id: "now", render: linearCard(kept) }] : []),
    glance: () => (kept?.ok ? [{ label: "Linear", value: kept.mine.length }] : []),
    brief() {
      const n = kept?.ok ? kept.mine.filter((i) => i.priority === 1).length : 0;
      return n ? [{ text: `${n} urgent Linear ${n === 1 ? "issue is" : "issues are"} yours.`, href: "/linear", tone: "warn" }] : [];
    },
    refs(ctx): RefRule[] {
      // Links need the workspace, which the first refresh learns.
      const pattern = refPattern(ctx.env.LINEAR_TEAM, kept);
      const workspace = kept?.workspace;
      const href = opts.issueHref ?? (workspace ? (m: string) => `https://linear.app/${workspace}/issue/${m}` : undefined);
      return pattern && href ? [{ pattern, href }] : [];
    },
    bino: () => {
      if (!kept?.ok) return "";
      const lines: string[] = [];
      if (kept.mine.length) {
        const byState = new Map<string, number>();
        for (const i of kept.mine) byState.set(i.state, (byState.get(i.state) ?? 0) + 1);
        lines.push(`${kept.mine.length} assigned open: ${[...byState].map(([s, n]) => `${n} ${s}`).join(", ")}.`);
        for (const i of kept.mine.slice(0, 10)) lines.push(`${i.key} [${i.state}, ${PRIORITY[i.priority] ?? "No priority"}]: ${i.title}`);
      }
      for (const t of kept.teams) {
        if (t.cycle) lines.push(`${t.key} cycle ${t.cycle.number}: ${t.cycle.completed}/${t.cycle.issues} done.`);
        if (t.untriaged.length) lines.push(`${t.key}: ${t.untriaged.length} un-triaged.`);
      }
      return lines.join("\n");
    },
    lookups(ctx) {
      const apiKey = (ctx.env.LINEAR_API_KEY ?? "").trim();
      if (!apiKey) return [];
      return [
        {
          kind: "issue",
          when: "One Linear issue by its key (ENG-123): its state, priority, assignee, description and latest comments.",
          fields: [{ name: "key", about: "the issue key, e.g. ENG-123", required: true, max: 30 }],
          run: (a) => lookIssue(apiKey, a.key ?? "", fetchFn),
        },
        {
          kind: "search",
          when: "Linear issues whose title has some words, newest first (15 at most): key, state, title, assignee.",
          fields: [{ name: "q", about: "words in the title", required: true, max: 100 }],
          run: (a) => searchIssues(apiKey, a.q ?? "", fetchFn),
        },
      ];
    },
    acts(ctx) {
      const apiKey = () => (ctx.env.LINEAR_API_KEY ?? "").trim();
      const ready = () => (apiKey() ? undefined : "Set LINEAR_API_KEY.");
      const href = (key: string, url: string) => opts.issueHref?.(key) ?? (url || "/linear");
      const upper = (s: string) => s.trim().toUpperCase();
      return [
        createAct({
          pack: "linear", app: "Linear", thing: "issue", ready,
          when: "I want a new issue in one of my Linear teams, with a title and optional description.",
          where: { name: "team", about: "the team key, e.g. ENG", pattern: /[A-Z][A-Z0-9]{0,9}/, max: 20, normalize: upper },
          async create(team, title, description) {
            const r = await createIssue(apiKey(), team, title, description, fetchFn);
            if (r === null) return null;
            if ("error" in r) return { refuse: r.error };
            kept = await read(ctx);
            ctx.publish(["linear"]);
            return { label: r.key, href: href(r.key, r.url) };
          },
        }),
        commentAct({
          pack: "linear", app: "Linear", thing: "issue", ready,
          ref: { name: "issue", about: "the issue key, e.g. ENG-123", pattern: /[A-Z][A-Z0-9]{0,9}-\d{1,7}/, max: 30, normalize: upper },
          async find(key) {
            const i = await checkIssue(apiKey(), key, fetchFn);
            return i && { ...i, label: i.key, href: href(i.key, i.url) };
          },
          comment: async (issue, text) => {
            const r = await commentIssue(apiKey(), issue.id, text, fetchFn);
            return r === true ? true : { refuse: r.error };
          },
        }),
      ];
    },
  };
}

export const linearPack: Pack = createLinearPack();
export const linearCrate = linearPack;
