/**
 * Linear Pack (`linear`): assigned open issues, active cycle progress, un-triaged team issues,
 * `TEAM-123` reference linking, Today's glance and opening line, and Bino acts (create an issue,
 * comment on one).
 *
 * PR pills (`pr.lead`, `pr.facts`) wait for core: those slots are told only the repo, so a pill
 * would land on every PR in it, not the one that names the issue (bergaaberg/dovre#15).
 */
import { html } from "hono/html";
import { type Pack, PACK_API, type RefRule } from "dovre/packs/types.ts";
import { logAction } from "dovre/actions/deploys.ts";
import { checkIssue, commentIssue, createIssue, type LinearIssue, type LinearKept, PRIORITY, readLinear } from "./data.ts";
import { linearCard, linearPage } from "./view.ts";

/** The keys this Dovre links: the configured team, else every team key seen in the data. */
function refPattern(envTeam: string | undefined, kept: LinearKept | undefined): RegExp | null {
  const keys = [envTeam?.trim().toUpperCase(), ...(kept?.teams ?? []).map((t) => t.key), ...(kept?.mine ?? []).map((i) => i.team)]
    .filter((k): k is string => !!k && /^[A-Z][A-Z0-9]{0,9}$/.test(k));
  const uniq = [...new Set(keys)];
  if (!uniq.length) return null;
  return new RegExp(`\\b(?:${uniq.join("|")})-\\d{1,7}\\b`, "g");
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
    nav: () => [{ href: "/linear", title: "Linear", icon: "ticket", group: "Code" }],
    pages: () => [{ title: "Linear", href: "/linear", icon: "🎫", about: "Assigned Linear issues", also: ["issues", "cycle"] }],
    routes(app, ctx) {
      app.get("/linear", (c) => ctx.page(c, { title: "Linear", body: linearPage(kept) }));
    },
    today: () => (kept ? [{ id: "now", render: linearCard(kept) }] : []),
    glance: () => (kept?.ok ? [{ label: "Linear", value: kept.mine.length }] : []),
    brief() {
      const n = kept?.ok ? kept.mine.filter((i) => i.priority === 1).length : 0;
      return n ? [{ text: `${n} urgent Linear ${n === 1 ? "issue" : "issues"}`, href: "/linear", tone: "warn" }] : [];
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
    acts(ctx) {
      const apiKey = () => (ctx.env.LINEAR_API_KEY ?? "").trim();
      return [
        {
          kind: "create",
          title: "A Linear issue",
          when: "I want a new issue in one of my Linear teams, with a title and optional description.",
          fields: [
            { name: "team", about: "the team key, e.g. ENG", required: true, max: 20 },
            { name: "title", about: "the issue's title", required: true, max: 200 },
            { name: "description", about: "what it's about, in a few lines", max: 4000, text: true },
          ],
          button: "Create",
          hint: "Creates the issue and links it here.",
          question: "Create this Linear issue?",
          inputs: (act) => html`${act.title ?? act.team ?? ""}`,
          async run(form) {
            const team = (form.team ?? "").trim().toUpperCase();
            const title = (form.title ?? "").trim().slice(0, 200);
            const key = apiKey();
            if (!key || !team || !title) return { ok: false, error: "Set LINEAR_API_KEY, and give a team key and a title." };
            const target = `${team} issue`;
            try {
              const r = await createIssue(key, team, title, (form.description ?? "").trim().slice(0, 4000), fetchFn);
              if (r === null) {
                await logAction(ctx.db, { kind: "linear.create", target, ok: false, error: "no such team" });
                return { ok: false, error: `Linear has no team "${team}".` };
              }
              if ("error" in r) {
                await logAction(ctx.db, { kind: "linear.create", target, ok: false, error: r.error });
                return { ok: false, error: r.error };
              }
              await logAction(ctx.db, { kind: "linear.create", target, detail: title, ok: true });
              kept = await read(ctx);
              ctx.publish(["linear"]);
              return { ok: true, done: `Created ${r.key}`, href: opts.issueHref?.(r.key) ?? (r.url || "/linear") };
            } catch (e) {
              const error = String((e as Error)?.message ?? e);
              await logAction(ctx.db, { kind: "linear.create", target, ok: false, error });
              return { ok: false, error };
            }
          },
        },
        {
          kind: "comment",
          title: "A comment on a Linear issue",
          when: "I want to add a comment to a Linear issue I can name by its key, e.g. ENG-123.",
          fields: [
            { name: "issue", about: "the issue key, e.g. ENG-123", required: true, max: 30 },
            { name: "text", about: "the comment", required: true, max: 4000, text: true },
          ],
          button: "Comment",
          hint: "Adds the comment from you.",
          question: "Post this comment on Linear?",
          inputs: (act) => html`${act.issue ?? ""}`,
          async run(form) {
            const issueKey = (form.issue ?? "").trim().toUpperCase();
            const text = (form.text ?? "").trim().slice(0, 4000);
            const key = apiKey();
            if (!key || !/^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(issueKey) || !text) return { ok: false, error: "Set LINEAR_API_KEY, and give an issue key and a comment." };
            const target = `${issueKey} comment`;
            try {
              const issue = await checkIssue(key, issueKey, fetchFn);
              if (!issue) {
                await logAction(ctx.db, { kind: "linear.comment", target, ok: false, error: "no such issue" });
                return { ok: false, error: `Linear has no issue ${issueKey}.` };
              }
              if (!issue.open) {
                await logAction(ctx.db, { kind: "linear.comment", target, ok: false, error: `${issue.state}` });
                return { ok: false, error: `${issueKey} is ${issue.state}; let it be.` };
              }
              const r = await commentIssue(key, issue.id, text, fetchFn);
              if (r !== true) {
                await logAction(ctx.db, { kind: "linear.comment", target, ok: false, error: r.error });
                return { ok: false, error: r.error };
              }
              await logAction(ctx.db, { kind: "linear.comment", target, ok: true });
              return { ok: true, done: `Commented on ${issue.key}`, href: opts.issueHref?.(issue.key) ?? (issue.url || "/linear") };
            } catch (e) {
              const error = String((e as Error)?.message ?? e);
              await logAction(ctx.db, { kind: "linear.comment", target, ok: false, error });
              return { ok: false, error };
            }
          },
        },
      ];
    },
  };
}

export const linearPack: Pack = createLinearPack();
export const linearCrate = linearPack;
