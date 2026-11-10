/**
 * Jira through Claude Code and its Atlassian MCP (JIRA_VIA=mcp), for where API tokens are locked
 * down. The calls go through core's `ctx.mcp` (dovre#488): the pack lists exact calls to the tools
 * its manifest names, core has a headless Claude Code make them, and what the pack keeps comes
 * from the tools' own results, matched to a call with exactly the arguments asked for, so the
 * model can't change what's read. Each result is parsed strictly here.
 *
 * Results over ~45k characters don't come back whole (Claude Code saves them to a file and shows
 * a preview), so searches ask for few fields: the moving list goes without type and assignee.
 */
import type { PackMcp, PackMcpAsk, PackMcpResult } from "dovre/pack.ts";
import { type JiraIssue, type JiraSetup, safeProjects, typesOf } from "./data.ts";
import { type RawCreateField, type Screen, TICKET_KEY } from "./tickets.ts";

export const SEARCH = "searchJiraIssuesUsingJql";
export const TYPES = "getJiraProjectIssueTypesMetadata";
export const FIELDS = "getJiraIssueTypeMetaWithFields";
export const CREATE = "createJiraIssue";
/** The write kind a create goes under (the pack's `writes`). */
export const CREATE_KIND = "ticket-create";
/** What the manifest asks of core: the one server, the tools that read, and the one that writes. */
export const MCP_ASK: PackMcpAsk = {
  why: "Reads my Jira issues and files tickets through Claude Code's Atlassian MCP, where API tokens are locked down (JIRA_VIA=mcp).",
  server: { name: "atlassian", url: "https://mcp.atlassian.com/v1/mcp" },
  reads: [SEARCH, TYPES, FIELDS],
  writes: { [CREATE]: CREATE_KIND },
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** MCP calls aren't allowed yet, Claude Code isn't there, or its Atlassian MCP isn't signed in: the page says how, instead of failing. */
export class JiraSetupError extends Error {
  readonly setup: Exclude<JiraSetup, "waiting">;
  constructor(setup: Exclude<JiraSetup, "waiting">, message: string) {
    super(message);
    this.setup = setup;
  }
}

/** Runs one job; what stands in its way (not allowed, no Claude Code, not signed in) comes out as setup to do. */
async function job<T>(mcp: PackMcp, run: () => Promise<T>): Promise<T> {
  const can = mcp.can();
  if (!can.ok) throw /Claude Code isn't/.test(can.why) ? new JiraSetupError("no-claude", can.why) : new JiraSetupError("allow", can.why);
  try {
    return await run();
  } catch (e) {
    const setup = (e as { setup?: unknown })?.setup;
    if (setup === "no-claude" || setup === "sign-in") throw new JiraSetupError(setup, String((e as Error).message));
    throw new Error(`Jira via Claude Code: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

/** A call's result as the JSON text the tool gave; throws when there's none, it failed, or it isn't whole. */
export function textOf(r: PackMcpResult, tool: string): string {
  if (!r.ok) throw new Error(r.why);
  if (!/^\s*[{[]/.test(r.text)) throw new Error(`${tool}: ${r.text.split("\n")[0]!.slice(0, 160)}`);
  return r.text;
}

export const KEY = /^[A-Z][A-Z0-9_]{0,20}-\d{1,9}$/;
const CATEGORIES = new Set(["new", "indeterminate", "done"]);

/** A search result as issues: only what has a ticket key and a summary; every other value checked or dropped. */
export function issuesOf(site: string, text: string): JiraIssue[] {
  const j = obj(JSON.parse(text));
  const nodes = Array.isArray(obj(j.issues).nodes) ? (obj(j.issues).nodes as unknown[]) : Array.isArray(j.issues) ? (j.issues as unknown[]) : null;
  if (!nodes) throw new Error("the search result has no issues");
  const out: JiraIssue[] = [];
  for (const n of nodes.map(obj)) {
    const key = str(n.key);
    const f = obj(n.fields);
    const summary = str(f.summary);
    if (!key || !KEY.test(key) || summary === undefined) continue;
    const status = obj(f.status);
    const cat = str(obj(status.statusCategory).key) ?? "";
    const updated = str(f.updated) ?? "";
    out.push({
      key,
      summary: summary.slice(0, 500),
      status: (str(status.name) ?? "").slice(0, 80),
      category: CATEGORIES.has(cat) ? cat : "new",
      project: key.slice(0, key.lastIndexOf("-")),
      type: (str(obj(f.issuetype).name) ?? "").slice(0, 80),
      assignee: str(obj(f.assignee).displayName)?.slice(0, 120) ?? null,
      updated: Number.isFinite(Date.parse(updated)) ? updated : "",
      url: `https://${site}/browse/${encodeURIComponent(key)}`,
    });
  }
  return out;
}

/** The two searches the page shows, in one job: what's mine and not done; what moved in my projects in 3 days. */
export function searches(site: string, projects: string[], jql?: string) {
  const ps = safeProjects(projects);
  const mine = { cloudId: site, jql: jql || "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", maxResults: 50, fields: ["summary", "status", "issuetype", "updated"] };
  const moving = ps.length ? { cloudId: site, jql: `project in (${ps.join(",")}) AND updated >= -3d ORDER BY updated DESC`, maxResults: 50, fields: ["summary", "status", "updated"] } : null;
  return { mine, moving };
}

export async function loadViaMcp(mcp: PackMcp, site: string, projects: string[], jql?: string): Promise<{ mine: JiraIssue[]; moving: JiraIssue[]; cost: number }> {
  const q = searches(site, projects, jql);
  const r = await job(mcp, () => mcp.call([{ tool: SEARCH, input: q.mine }, ...(q.moving ? [{ tool: SEARCH, input: q.moving }] : [])]));
  const mine = issuesOf(site, textOf(r.results[0]!, SEARCH));
  const moving = q.moving ? issuesOf(site, textOf(r.results[1]!, SEARCH)) : [];
  return { mine, moving, cost: r.cost };
}

// ── Filing a ticket through the MCP ──

/** A project's create screen, in two jobs: its work types, then the fields of each one (at most 20). */
export async function loadScreenViaMcp(mcp: PackMcp, site: string, project: string): Promise<Screen & { cost: number }> {
  const [p] = safeProjects([project]);
  if (!p) throw new Error(`«${project}» isn't a Jira project key`);
  const first = await job(mcp, () => mcp.call([{ tool: TYPES, input: { cloudId: site, projectIdOrKey: p } }]));
  const raw = obj(JSON.parse(textOf(first.results[0]!, TYPES)));
  const types = typesOf((Array.isArray(raw.issueTypes) ? raw.issueTypes : Array.isArray(raw.values) ? raw.values : []).map(obj));
  const fields: Record<string, RawCreateField[]> = {};
  const asked = types.slice(0, 20);
  if (!asked.length) return { types, fields, cost: first.cost };
  const second = await job(mcp, () => mcp.call(asked.map((t) => ({ tool: FIELDS, input: { cloudId: site, projectIdOrKey: p, issueTypeId: t.id, requiredFieldsOnly: false } }))));
  asked.forEach((t, i) => {
    try {
      const r = obj(JSON.parse(textOf(second.results[i]!, FIELDS)));
      fields[t.id] = (Array.isArray(r.fields) ? r.fields : Array.isArray(r.values) ? r.values : []) as RawCreateField[];
    } catch {
      // A type whose fields didn't come: its form says so when it's picked.
    }
  });
  return { types, fields, cost: first.cost + second.cost };
}

/** What createJiraIssue gets, from the create payload the pack builds (tickets.ts). */
export function createInput(site: string, payload: { fields: Record<string, unknown> }, typeName: string): Record<string, unknown> {
  const { project, issuetype: _type, summary, description, ...rest } = payload.fields;
  const input: Record<string, unknown> = { cloudId: site, projectKey: str(obj(project).key) ?? "", issueTypeName: typeName, summary: str(summary) ?? "" };
  if (description) Object.assign(input, { description, contentFormat: "adf" });
  if (Object.keys(rest).length) input.additional_fields = rest;
  return input;
}

/** Files one ticket: one job that may call createJiraIssue only, with exactly these arguments. The key comes from Jira's answer. */
export async function createViaMcp(mcp: PackMcp, site: string, input: Record<string, unknown>): Promise<{ key: string; url: string; cost: number; warning?: string }> {
  const r = await job(mcp, () => mcp.write(CREATE_KIND, { tool: CREATE, input }));
  // Called, but not as asked: something may be there.
  if (!r.result.ok) throw new Error(r.times ? `${r.result.why}: check ${site} before trying again` : r.result.why);
  const key = str(obj(JSON.parse(textOf(r.result, CREATE))).key);
  if (!key || !TICKET_KEY.test(key)) throw new Error("Jira's answer has no ticket key: check Jira before trying again");
  return { key, url: `https://${site}/browse/${encodeURIComponent(key)}`, cost: r.cost, warning: r.times > 1 ? `The agent called createJiraIssue ${r.times} times: check ${site} for duplicates.` : undefined };
}
