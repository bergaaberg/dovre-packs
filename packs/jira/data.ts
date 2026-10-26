/**
 * Jira Pack (`jira`): what's mine and not done, and what moved lately in the projects I follow
 * (JIRA_PROJECTS). Two ways to Jira (JIRA_VIA): `rest`, Jira's REST API v3 with an API token, or
 * `mcp`, Claude Code's Atlassian MCP (mcp.ts) where tokens are locked down.
 */
import type { PackContext } from "dovre/packs/types.ts";

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  /** Jira's status category: "new", "indeterminate" or "done". */
  category: string;
  project: string;
  type: string;
  assignee: string | null;
  /** ISO time, or "" when Jira didn't say. */
  updated: string;
  priority?: string;
  url: string;
};

/** Why Jira through the MCP isn't answering yet: the page says how to fix it. */
export type JiraSetup = "no-claude" | "sign-in" | "waiting";

export type JiraVia = "rest" | "mcp" | "off";

export type JiraKept = {
  at: number;
  ok: boolean;
  site: string;
  via: JiraVia;
  error?: string;
  setup?: JiraSetup;
  mine: JiraIssue[];
  moving: JiraIssue[];
};

export const siteOf = (env: Record<string, string | undefined>) => (env.JIRA_SITE ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
export const siteOk = (site: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site);

/** JIRA_VIA as set; unset, a token means REST, otherwise off. */
export function viaOf(env: Record<string, string | undefined>): JiraVia {
  const set = (env.JIRA_VIA ?? "").trim().toLowerCase();
  if (set === "rest" || set === "mcp" || set === "off") return set;
  return env.JIRA_TOKEN?.trim() ? "rest" : "off";
}

/** Project keys are letters and digits; anything else would let a setting rewrite the query. */
export const safeProjects = (keys: string[]) => keys.map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
export const projectsOf = (env: Record<string, string | undefined>) => safeProjects((env.JIRA_PROJECTS ?? "").split(","));

export const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

type RawIssue = {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    priority?: { name?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string } | null;
    updated?: string;
  };
};

export function issueOf(site: string, i: RawIssue): JiraIssue | undefined {
  const key = String(i.key ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{0,20}-\d{1,9}$/.test(key)) return undefined;
  const f = i.fields ?? {};
  const cat = f.status?.statusCategory?.key ?? "";
  const updated = String(f.updated ?? "");
  return {
    key,
    summary: String(f.summary ?? key).slice(0, 500),
    status: String(f.status?.name ?? "Open").slice(0, 80),
    category: ["new", "indeterminate", "done"].includes(cat) ? cat : "new",
    project: key.slice(0, key.lastIndexOf("-")),
    type: String(f.issuetype?.name ?? "").slice(0, 80),
    assignee: f.assignee?.displayName ? String(f.assignee.displayName).slice(0, 120) : null,
    updated: Number.isFinite(Date.parse(updated)) ? updated : "",
    priority: f.priority?.name ? String(f.priority.name).slice(0, 40) : undefined,
    url: `https://${site}/browse/${encodeURIComponent(key)}`,
  };
}

async function searchRest(site: string, auth: string, jql: string, max: number, fetchFn: typeof fetch): Promise<JiraIssue[]> {
  const url = `https://${site}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,priority,issuetype,assignee,updated`;
  const res = await fetchFn(url, { headers: { accept: "application/json", authorization: auth }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Jira HTTP ${res.status}`);
  const j = (await res.json()) as { issues?: RawIssue[] };
  return (j.issues ?? []).flatMap((i) => issueOf(site, i) ?? []);
}

/** Jira through its REST API: mine (JIRA_JQL, or assigned and not done) and, with JIRA_PROJECTS, what moved in 3 days. */
export async function readJira(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<JiraKept> {
  const site = siteOf(ctx.env);
  const email = (ctx.env.JIRA_EMAIL ?? "").trim();
  const token = (ctx.env.JIRA_TOKEN ?? "").trim();
  const base = { at: now, site, via: "rest" as const, mine: [], moving: [] };
  if (!site || !token) return { ...base, ok: false, error: "Set JIRA_SITE and JIRA_TOKEN to read Jira issues." };
  const auth = email ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` : `Bearer ${token}`;
  const projects = projectsOf(ctx.env);
  try {
    const [mine, moving] = await Promise.all([
      searchRest(site, auth, ctx.env.JIRA_JQL?.trim() || MINE_JQL, 50, fetchFn),
      projects.length ? searchRest(site, auth, `project in (${projects.join(",")}) AND updated >= -3d ORDER BY updated DESC`, 100, fetchFn) : Promise.resolve([]),
    ]);
    return { ...base, ok: true, mine, moving };
  } catch (e) {
    return { ...base, ok: false, error: String((e as Error)?.message ?? e).slice(0, 180) };
  }
}
