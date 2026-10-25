/**
 * Linear Pack (`linear`): reads assigned open issues, active cycles and un-triaged team issues
 * from Linear's GraphQL API (`https://api.linear.app/graphql`).
 */
import type { PackContext } from "dovre/packs/types.ts";

export const LINEAR_API = "https://api.linear.app/graphql";

/** Linear's priority numbers, as they say them. */
export const PRIORITY: Record<number, string> = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" };

export type LinearIssue = {
  key: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  priority: number;
  team: string;
  project?: string;
  cycle?: number;
  updatedAt: number;
};

export type LinearCycle = { number: number; endsAt?: number; progress: number; issues: number; completed: number };

export type LinearTeam = { key: string; name: string; untriaged: LinearIssue[]; cycle?: LinearCycle };

export type LinearKept = {
  at: number;
  ok: boolean;
  error?: string;
  viewer?: string;
  mine: LinearIssue[];
  teams: LinearTeam[];
};

type RawIssue = {
  identifier?: string;
  title?: string;
  url?: string;
  priority?: number;
  updatedAt?: string;
  team?: { key?: string };
  state?: { name?: string; type?: string };
  project?: { name?: string };
  cycle?: { number?: number } | null;
};

const cut = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
const at = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : 0);

/** One raw node, as far as it checks out; an identifier that isn't a Linear key is dropped. */
function toIssue(n: RawIssue, now: number): LinearIssue | null {
  const key = String(n.identifier ?? "").trim();
  if (!/^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(key)) return null;
  return {
    key,
    title: cut(n.title, 200, key),
    url: /^https:\/\/linear\.app\/issue\/[A-Za-z0-9-]+$/.test(String(n.url ?? "")) ? String(n.url) : `https://linear.app/issue/${key}`,
    state: cut(n.state?.name, 60, "Open"),
    stateType: cut(n.state?.type, 30, "backlog"),
    priority: typeof n.priority === "number" && n.priority >= 0 && n.priority <= 4 ? Math.trunc(n.priority) : 0,
    team: cut(n.team?.key, 20, "").toUpperCase(),
    project: cut(n.project?.name, 120) || undefined,
    cycle: typeof n.cycle?.number === "number" ? n.cycle.number : undefined,
    updatedAt: at(n.updatedAt) || now,
  };
}

/** One GraphQL round trip: never throws; the key goes in the Authorization header, never a URL. */
export async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(LINEAR_API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `Linear HTTP ${res.status}` };
    const j = (await res.json()) as { data?: T; errors?: { message?: string }[] };
    if (j.errors?.length) return { ok: false, error: cut(j.errors[0]?.message, 180, "Linear error") };
    if (!j.data) return { ok: false, error: "Linear returned nothing" };
    return { ok: true, data: j.data };
  } catch (e) {
    return { ok: false, error: cut(String((e as Error)?.message ?? e), 180, "Linear unreachable") };
  }
}

type ReadData = {
  viewer?: { name?: string };
  issues?: { nodes?: RawIssue[] };
  teams?: {
    nodes?: ({
      key?: string;
      name?: string;
      activeCycle?: ({ number?: number; startsAt?: string; endsAt?: string; progress?: number; issueCount?: number; completedIssueCount?: number } | null) | undefined;
      issues?: { nodes?: RawIssue[] };
    })[];
  };
};

const READ_QUERY = `query DovreLinear {
  viewer { name }
  issues(first: 50, filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }, orderBy: updatedAt) {
    nodes { identifier title url priority updatedAt team { key } state { name type } project { name } cycle { number } }
  }
  teams(first: 10) {
    nodes {
      key name
      activeCycle { number startsAt endsAt progress issueCount completedIssueCount }
      issues(first: 20, filter: { priority: { eq: 0 }, state: { type: { nin: ["completed", "canceled"] } } }, orderBy: updatedAt) {
        nodes { identifier title url priority updatedAt team { key } state { name type } project { name } cycle { number } }
      }
    }
  }
}`;

/** Reads everything the pack's pages show, into one kept snapshot. */
export async function readLinear(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<LinearKept> {
  const apiKey = (ctx.env.LINEAR_API_KEY ?? "").trim();
  if (!apiKey) return { at: now, ok: false, error: "Set LINEAR_API_KEY to read Linear.", mine: [], teams: [] };
  const r = await gql<ReadData>(apiKey, READ_QUERY, {}, fetchFn);
  if (!r.ok) return { at: now, ok: false, error: r.error, mine: [], teams: [] };

  const mine = (r.data.issues?.nodes ?? []).flatMap((n) => {
    const i = toIssue(n, now);
    return i ? [i] : [];
  });
  const teams: LinearTeam[] = [];
  for (const t of r.data.teams?.nodes ?? []) {
    const key = cut(t.key, 20).toUpperCase();
    if (!key || teams.some((x) => x.key === key)) continue;
    const c = t.activeCycle;
    teams.push({
      key,
      name: cut(t.name, 120, key),
      untriaged: (t.issues?.nodes ?? []).flatMap((n) => {
        const i = toIssue(n, now);
        return i && i.team === key ? [i] : [];
      }),
      cycle:
        typeof c?.number === "number"
          ? {
              number: c.number,
              endsAt: at(c.endsAt) || undefined,
              progress: typeof c.progress === "number" ? Math.min(100, Math.max(0, Math.round(c.progress))) : 0,
              issues: Math.max(0, Math.trunc(c.issueCount ?? 0)),
              completed: Math.max(0, Math.trunc(c.completedIssueCount ?? 0)),
            }
          : undefined,
    });
  }
  const wanted = (ctx.env.LINEAR_TEAM ?? "").trim().toUpperCase();
  return { at: now, ok: true, viewer: cut(r.data.viewer?.name, 80) || undefined, mine, teams: wanted ? teams.filter((t) => t.key === wanted) : teams };
}

// ── Writes (Bino acts): each re-checks the current state before it writes ──────

const TEAM_QUERY = `query DovreLinearTeam($key: String!) {
  teams(first: 1, filter: { key: { eq: $key } }) { nodes { key name } }
}`;
const ISSUE_QUERY = `query DovreLinearIssue($key: String!) {
  issue(id: $key) { identifier title url state { name type } team { key } }
}`;
const CREATE_MUTATION = `mutation DovreLinearCreate($teamId: String!, $title: String!, $description: String) {
  issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
    success issue { identifier title url }
  }
}`;
const COMMENT_MUTATION = `mutation DovreLinearComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

/** A Linear issue as an act re-checks it: null when there's no such open issue. */
export async function checkIssue(
  apiKey: string,
  key: string,
  fetchFn: typeof fetch,
): Promise<{ id: string; key: string; title: string; state: string; open: boolean } | null> {
  const r = await gql<{ issue?: { id?: string; identifier?: string; title?: string; state?: { type?: string; name?: string } } }>(apiKey, ISSUE_QUERY, { key }, fetchFn);
  if (!r.ok || !r.data.issue?.id || !r.data.issue.identifier) return null;
  const type = cut(r.data.issue.state?.type, 30);
  return {
    id: String(r.data.issue.id),
    key: String(r.data.issue.identifier),
    title: cut(r.data.issue.title, 200),
    state: cut(r.data.issue.state?.name, 60, "Open"),
    open: type !== "completed" && type !== "canceled",
  };
}

/** Creates an issue in a team whose key was re-checked first; null when the team isn't there. */
export async function createIssue(
  apiKey: string,
  teamKey: string,
  title: string,
  description: string,
  fetchFn: typeof fetch,
): Promise<{ key: string; url: string } | null | { error: string }> {
  const t = await gql<{ teams?: { nodes?: { key?: string; name?: string }[] } }>(apiKey, TEAM_QUERY, { key: teamKey }, fetchFn);
  if (!t.ok) return { error: t.error };
  const team = t.data.teams?.nodes?.[0];
  if (!team) return null;
  const r = await gql<{ issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } } }>(
    apiKey,
    CREATE_MUTATION,
    { teamId: team.key, title, description: description || undefined },
    fetchFn,
  );
  if (!r.ok) return { error: r.error };
  const issue = r.data.issueCreate?.issue;
  if (!r.data.issueCreate?.success || !issue?.identifier) return { error: "Linear didn't create the issue" };
  return { key: issue.identifier, url: /^https:\/\/linear\.app\/issue\/[A-Za-z0-9-]+$/.test(String(issue.url ?? "")) ? String(issue.url) : `https://linear.app/issue/${issue.identifier}` };
}

/** Comments on an issue whose id was re-checked first. */
export async function commentIssue(apiKey: string, issueId: string, body: string, fetchFn: typeof fetch): Promise<true | { error: string }> {
  const r = await gql<{ commentCreate?: { success?: boolean } }>(apiKey, COMMENT_MUTATION, { issueId, body }, fetchFn);
  if (!r.ok) return { error: r.error };
  return r.data.commentCreate?.success ? true : { error: "Linear didn't add the comment" };
}
