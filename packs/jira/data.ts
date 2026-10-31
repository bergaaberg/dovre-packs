/**
 * Jira Pack (`jira`): what's mine and not done, and what moved lately in the projects I follow
 * (JIRA_PROJECTS). Two ways to Jira (JIRA_VIA): `rest`, Jira's REST API v3 with an API token, or
 * `mcp`, Claude Code's Atlassian MCP (mcp.ts) where tokens are locked down.
 */
import type { PackContext } from "dovre/packs/types.ts";
import { type CreateType, type RawCreateField, type Screen, TICKET_KEY } from "./tickets.ts";

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
/** The link to a ticket on a site (a bare host): what `refs` and the PR slots both use. */
export const browseHref = (site: string, key: string) => `https://${site}/browse/${encodeURIComponent(key)}`;
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

/** The Authorization header for REST: Basic with JIRA_EMAIL (Atlassian Cloud), else Bearer. */
export function authOf(env: Record<string, string | undefined>): string {
  const email = (env.JIRA_EMAIL ?? "").trim();
  const token = (env.JIRA_TOKEN ?? "").trim();
  return email ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` : `Bearer ${token}`;
}

/** Jira through its REST API: mine (JIRA_JQL, or assigned and not done) and, with JIRA_PROJECTS, what moved in 3 days. */
export async function readJira(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<JiraKept> {
  const site = siteOf(ctx.env);
  const token = (ctx.env.JIRA_TOKEN ?? "").trim();
  const base = { at: now, site, via: "rest" as const, mine: [], moving: [] };
  if (!site || !token) return { ...base, ok: false, error: "Set JIRA_SITE and JIRA_TOKEN to read Jira issues." };
  const auth = authOf(ctx.env);
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

// ── Filing a ticket through REST ──

export type Rest = { site: string; auth: string; fetchFn: typeof fetch };

async function rest<T>(r: Rest, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await r.fetchFn(`https://${r.site}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: r.auth, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type RawType = { id?: unknown; name?: unknown; description?: unknown; subtask?: unknown };
/** A project's work types as Jira lists them (createmeta), sub-tasks left out, every value checked. */
export const typesOf = (list: RawType[]): CreateType[] =>
  list
    .filter((t) => t.subtask !== true && /^\d{1,12}$/.test(String(t.id ?? "")) && typeof t.name === "string")
    .map((t) => ({ id: String(t.id), name: String(t.name).slice(0, 80), description: (typeof t.description === "string" ? t.description : "").slice(0, 300) }));

/** A project's create screen through REST: its work types, then each one's fields. */
export async function loadScreenRest(r: Rest, project: string): Promise<Screen> {
  const [p] = safeProjects([project]);
  if (!p) throw new Error(`«${project}» isn't a Jira project key`);
  const t = await rest<{ issueTypes?: RawType[]; values?: RawType[] }>(r, `/rest/api/3/issue/createmeta/${p}/issuetypes?maxResults=50`);
  const types = typesOf(t.issueTypes ?? t.values ?? []);
  const fields: Record<string, RawCreateField[]> = {};
  await Promise.all(
    types.map(async (ty) => {
      try {
        const f = await rest<{ fields?: RawCreateField[]; values?: RawCreateField[] }>(r, `/rest/api/3/issue/createmeta/${p}/issuetypes/${ty.id}?maxResults=100`);
        fields[ty.id] = f.fields ?? f.values ?? [];
      } catch {
        // A type whose fields didn't come: its form says so when it's picked.
      }
    }),
  );
  return { types, fields };
}

/** Files the ticket through REST; the key comes from Jira's answer. */
export async function createRest(r: Rest, payload: { fields: Record<string, unknown> }): Promise<{ key: string; url: string }> {
  const a = await rest<{ key?: unknown }>(r, "/rest/api/3/issue", { method: "POST", body: payload });
  const key = typeof a?.key === "string" ? a.key : "";
  if (!TICKET_KEY.test(key)) throw new Error("Jira's answer has no ticket key: check Jira before trying again");
  return { key, url: `https://${r.site}/browse/${encodeURIComponent(key)}` };
}
