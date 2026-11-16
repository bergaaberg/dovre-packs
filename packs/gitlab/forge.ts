/**
 * GitLab as a Dovre forge (REST API v4, a personal access token with `read_api`). Merge requests map
 * onto Dovre's PRs, todos onto notifications, project events onto movement, and blocked deployments
 * onto waiting deploys, issues onto the Issues pack's sets, and merged merge requests, releases and
 * tags onto what shipped. Read-only: nothing here writes to GitLab.
 */
import { type Deploy, type Forge, type ForgeShipped, type Issue, type IssueSets, type Move, type Note, owners as ownersList, type Pr, type PrRef } from "dovre/pack.ts";

export type Fetch = typeof fetch;
const enc = encodeURIComponent;
/** "gitlab.com", "https://git.example.com/" → "git.example.com". */
export const hostOf = (raw: string | undefined) => (raw ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase() || "gitlab.com";

export type GitLab = { host: string; get<T>(path: string): Promise<T>; getAll<T>(path: string, max?: number): Promise<T[]> };

/** A GitLab answer that wasn't 2xx, or no answer in time (status 0). */
export class GitLabError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const PAGE_SIZE = 100;
/** Items followed by `getAll`, at most: 5 pages of 100. */
const MAX_ITEMS = 500;
/** Detail and events reads in flight at once. */
const PARALLEL = 4;

export function createGitLab(opts: { host: string; token: string; fetchFn?: Fetch; timeoutMs?: number }): GitLab {
  const f = opts.fetchFn ?? fetch;
  const base = `https://${opts.host}/api/v4`;
  const request = async (path: string) => {
    const name = path.split("?")[0];
    let res: Response;
    try {
      res = await f(base + path, { headers: { "private-token": opts.token, accept: "application/json", "user-agent": "dovre" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new GitLabError(`GitLab GET ${name}: timed out`, 0);
      throw e;
    }
    if (!res.ok) throw new GitLabError(`GitLab GET ${name}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
    return res;
  };
  return {
    host: opts.host,
    async get<T>(path: string) {
      return (await (await request(path)).json()) as T;
    },
    async getAll<T>(path: string, max = MAX_ITEMS) {
      const out: T[] = [];
      let page = "1";
      // Pages too are capped: a server that keeps sending x-next-page on empty pages can't loop us.
      for (let read = 0; page && out.length < max && read < Math.ceil(max / PAGE_SIZE) + 1; read++) {
        const res = await request(page === "1" ? path : `${path}${path.includes("?") ? "&" : "?"}page=${enc(page)}`);
        out.push(...((await res.json()) as T[]));
        page = res.headers.get("x-next-page")?.trim() ?? "";
      }
      return out.slice(0, max);
    },
  };
}

/** Runs the calls it's given, at most `n` at a time. */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((go) => queue.push(go));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** A read that may fail quietly (a missing detail is just a blank), except when GitLab says slow down: that is an error. */
const orElse = <T>(v: T) => (e: unknown): T => {
  if (e instanceof GitLabError && e.status === 429) throw e;
  return v;
};

const MR_PATH = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/;

/** "https://host/group/sub/shop/-/merge_requests/3" → "group/sub/shop". */
export const repoOfUrl = (url: string) => url.match(/^https?:\/\/[^/]+\/(.+?)\/-\//)?.[1] ?? "";

/** In one of the owners' groups (or under a user's namespace). */
const inOwners = (repo: string, owners: string[]) => owners.some((o) => repo.toLowerCase().startsWith(`${o.toLowerCase()}/`));

/** GitLab's service accounts: project and group access tokens, and the ghost user. */
export const isBot = (login: string) => /^(project|group)_\d+_bot/.test(login) || /\[bot\]$|-bot$/.test(login) || login === "ghost";

// ── Merge requests ────────────────────────────────────────────────────────────

type RawMr = {
  iid: number; project_id: number; title: string; description: string | null; draft?: boolean; work_in_progress?: boolean; web_url: string;
  updated_at: string; source_branch: string; sha: string; author: { username: string } | null; labels: string[];
  head_pipeline?: { id: number; status: string } | null; state?: string;
};
type RawReviewer = { user: { username: string }; state: string };
type RawApprovals = { approved?: boolean; approved_by?: { user: { username: string } }[] };
type RawDiscussion = { notes: { resolvable?: boolean; resolved?: boolean }[] };
type RawJob = { name: string; status: string; web_url: string | null; allow_failure?: boolean };
type RawDiff = { new_path: string; diff: string };

/** A pipeline's status as Dovre's checks rollup. */
export function checksOf(status: string | undefined | null): Pr["checks"] {
  switch (status) {
    case "success": return "SUCCESS";
    case "failed": return "FAILURE";
    case "canceled": case "skipped": case undefined: case null: return "NONE";
    default: return "PENDING";
  }
}

/** A job's status as one of Dovre's run states. A failure that's allowed to fail doesn't count. */
export function jobState(j: Pick<RawJob, "status" | "allow_failure">): Pr["runs"][number]["state"] {
  if (j.status === "success") return "ok";
  if (j.status === "failed") return j.allow_failure ? "skipped" : "bad";
  if (["canceled", "skipped", "manual"].includes(j.status)) return "skipped";
  return "pending";
}
const RANK = { bad: 0, pending: 1, ok: 2, skipped: 3 } as const;

/** Lines added and removed in one file's unified diff. */
export function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

const REVIEW_STATE: Record<string, string> = { approved: "APPROVED", requested_changes: "CHANGES_REQUESTED", reviewed: "COMMENTED" };

/** A merge request and what was read about it, as Dovre's PR. */
export function toPr(mr: RawMr, more: { reviewers: RawReviewer[]; approvals: RawApprovals; discussions: RawDiscussion[]; jobs: RawJob[]; diffs: RawDiff[]; pipeline?: { status: string } | null }): Pr {
  const files = more.diffs.slice(0, 80).map((d) => ({ path: d.new_path, ...diffCounts(d.diff ?? "") }));
  const reviews = more.reviewers.filter((r) => REVIEW_STATE[r.state]).map((r) => ({ login: r.user.username, state: REVIEW_STATE[r.state]! }));
  for (const a of more.approvals.approved_by ?? []) if (!reviews.some((r) => r.login === a.user.username)) reviews.push({ login: a.user.username, state: "APPROVED" });
  const requested = more.reviewers.filter((r) => r.state === "unreviewed").map((r) => r.user.username);
  const review: Pr["review"] = reviews.some((r) => r.state === "CHANGES_REQUESTED")
    ? "CHANGES_REQUESTED"
    : more.approvals.approved && (more.approvals.approved_by?.length ?? 0) > 0
      ? "APPROVED"
      : more.reviewers.length
        ? "REVIEW_REQUIRED"
        : null;
  return {
    repo: repoOfUrl(mr.web_url),
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    draft: !!(mr.draft ?? mr.work_in_progress),
    updatedAt: mr.updated_at,
    branch: mr.source_branch,
    author: mr.author?.username ?? "",
    review,
    checks: checksOf((more.pipeline ?? mr.head_pipeline)?.status),
    openThreads: more.discussions.filter((d) => d.notes.some((n) => n.resolvable && !n.resolved)).length,
    body: mr.description ?? "",
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    headSha: mr.sha,
    labels: mr.labels ?? [],
    files,
    reviews,
    requested,
    runs: more.jobs.map((j) => ({ name: j.name, state: jobState(j), url: j.web_url })).sort((a, b) => RANK[a.state] - RANK[b.state]),
  };
}

async function loadMr(gl: GitLab, mr: RawMr, slot: ReturnType<typeof limiter>): Promise<Pr> {
  const at = `/projects/${mr.project_id}/merge_requests/${mr.iid}`;
  const none = orElse;
  const get = <T>(path: string) => slot(() => gl.get<T>(path));
  const full = await get<RawMr>(at).catch(none(mr));
  const pipeline = full.head_pipeline ?? null;
  const [reviewers, approvals, discussions, jobs, diffs] = await Promise.all([
    get<RawReviewer[]>(`${at}/reviewers`).catch(none([])),
    get<RawApprovals>(`${at}/approvals`).catch(none({})),
    get<RawDiscussion[]>(`${at}/discussions?per_page=100`).catch(none([])),
    pipeline ? get<RawJob[]>(`/projects/${mr.project_id}/pipelines/${pipeline.id}/jobs?per_page=100`).catch(none([])) : Promise.resolve([]),
    get<RawDiff[]>(`${at}/diffs?per_page=100`).catch(none([])),
  ]);
  return toPr(full, { reviewers, approvals, discussions, jobs, diffs, pipeline });
}

export async function loadPrs(gl: GitLab, login: string, owners: string): Promise<{ mine: Pr[]; review: Pr[] }> {
  const groups = ownersList.of(owners);
  const [mine, review] = await Promise.all([
    gl.getAll<RawMr>(`/merge_requests?state=opened&scope=created_by_me&per_page=${PAGE_SIZE}`),
    gl.getAll<RawMr>(`/merge_requests?state=opened&scope=all&reviewer_username=${enc(login)}&per_page=${PAGE_SIZE}`),
  ]);
  const ours = (list: RawMr[]) => list.filter((m) => inOwners(repoOfUrl(m.web_url), groups));
  const slot = limiter(PARALLEL);
  return { mine: await Promise.all(ours(mine).map((m) => loadMr(gl, m, slot))), review: await Promise.all(ours(review).map((m) => loadMr(gl, m, slot))) };
}

/** "group/shop#3" → its state and title. */
export async function loadPrRefs(gl: GitLab, keys: Iterable<string>): Promise<Map<string, PrRef>> {
  const out = new Map<string, PrRef>();
  const STATE: Record<string, PrRef["state"]> = { opened: "OPEN", merged: "MERGED", closed: "CLOSED", locked: "CLOSED" };
  await Promise.all(
    [...new Set(keys)].slice(0, 50).map(async (key) => {
      const m = key.match(/^([\w.-]+(?:\/[\w.-]+)+)#(\d+)$/);
      if (!m) return;
      const mr = await gl.get<RawMr>(`/projects/${enc(m[1]!)}/merge_requests/${m[2]}`).catch(() => undefined);
      if (mr) out.set(key, { state: STATE[mr.state ?? ""] ?? "OPEN", title: mr.title, url: mr.web_url });
    }),
  );
  return out;
}

// ── Todos ─────────────────────────────────────────────────────────────────────

type RawTodo = { id: number; action_name: string; target_type: string; target_url: string; body?: string; updated_at: string; project?: { path_with_namespace: string } | null; target?: { title?: string } | null };

/** GitLab's todo actions, in the words Dovre's needs know (`mention`, `review_requested`, …). */
const REASON: Record<string, string> = { mentioned: "mention", directly_addressed: "mention", review_requested: "review_requested", approval_required: "review_requested", assigned: "assign", build_failed: "ci_activity", unmergeable: "state_change", marked: "manual" };
const TYPE: Record<string, string> = { MergeRequest: "PullRequest", Issue: "Issue", Commit: "Commit", Epic: "Epic" };

export function toNote(t: RawTodo): Note {
  return {
    id: String(t.id),
    reason: REASON[t.action_name] ?? t.action_name,
    type: TYPE[t.target_type] ?? t.target_type,
    title: t.target?.title ?? t.body ?? "",
    repo: t.project?.path_with_namespace ?? "",
    updatedAt: t.updated_at,
    url: t.target_url,
  };
}

export async function loadNotes(gl: GitLab): Promise<Note[]> {
  const todos = await gl.getAll<RawTodo>(`/todos?state=pending&per_page=${PAGE_SIZE}`);
  return todos.map(toNote).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Movement ──────────────────────────────────────────────────────────────────

type RawProject = { id: number; path_with_namespace: string; web_url: string };
type RawEvent = {
  action_name: string; target_type: string | null; target_iid?: number | null; target_title?: string | null; created_at: string;
  author_username?: string; author?: { username: string };
  push_data?: { ref?: string; ref_type?: string; commit_count?: number } | null;
  note?: { noteable_type?: string; noteable_iid?: number } | null;
};

export function describeEvent(e: RawEvent, p: Pick<RawProject, "path_with_namespace" | "web_url">): Move {
  const actor = e.author?.username ?? e.author_username ?? "";
  const base = { at: e.created_at, actor, bot: isBot(actor), repo: p.path_with_namespace };
  const mr = (iid: number) => ({ ref: `${p.path_with_namespace}#${iid}`, url: `${p.web_url}/-/merge_requests/${iid}` });
  const action = e.action_name;
  if (e.target_type === "MergeRequest" && e.target_iid) {
    const verb = action === "accepted" ? "merged" : action === "approved" ? "reviewed (approved)" : action;
    return { ...base, type: action === "approved" ? "PullRequestReviewEvent" : "PullRequestEvent", verb, title: e.target_title ?? undefined, ...mr(e.target_iid) };
  }
  if ((e.target_type === "Note" || e.target_type === "DiffNote" || e.target_type === "DiscussionNote") && e.note?.noteable_type === "MergeRequest" && e.note.noteable_iid)
    return { ...base, type: "PullRequestReviewCommentEvent", verb: "commented on", title: e.target_title ?? undefined, ...mr(e.note.noteable_iid) };
  if (e.target_type === "Issue" && e.target_iid)
    return { ...base, type: "IssuesEvent", verb: `${action} issue`, title: `#${e.target_iid} ${e.target_title ?? ""}`.trim(), url: `${p.web_url}/-/issues/${e.target_iid}` };
  if (e.push_data) {
    const ref = e.push_data.ref ?? "";
    if (e.push_data.ref_type === "tag") return { ...base, type: "CreateEvent", verb: action === "deleted" ? "deleted tag" : "created tag", title: ref, url: `${p.web_url}/-/tags` };
    if (action === "deleted") return { ...base, type: "DeleteEvent", verb: "deleted branch", title: ref, url: p.web_url };
    return { ...base, type: "PushEvent", verb: `pushed ${e.push_data.commit_count ?? ""} to`.replace("  ", " "), title: ref, url: `${p.web_url}/-/commits/${enc(ref)}` };
  }
  return { ...base, type: e.target_type ?? "Event", verb: action, title: e.target_title ?? undefined, url: p.web_url };
}

/** The owners' busiest projects lately, and what happened in each over the last `hours`. */
export async function loadMoves(gl: GitLab, owners: string, hours = 24, now = Date.now()): Promise<Move[]> {
  const since = now - hours * 3600e3;
  const after = new Date(since - 86400e3).toISOString().slice(0, 10);
  const out: Move[] = [];
  const slot = limiter(PARALLEL);
  for (const owner of ownersList.of(owners)) {
    const q = `?order_by=last_activity_at&sort=desc&per_page=20&archived=false&last_activity_after=${enc(new Date(since).toISOString())}`;
    const projects = await gl
      .get<RawProject[]>(`/groups/${enc(owner)}/projects${q}&include_subgroups=true`)
      .catch(() => gl.get<RawProject[]>(`/users/${enc(owner)}/projects${q}`).catch(() => [] as RawProject[]));
    const events = await Promise.all(projects.map((p) => slot(() => gl.get<RawEvent[]>(`/projects/${p.id}/events?after=${after}&per_page=100`)).then((es) => ({ p, es }), (e) => ({ p, es: orElse([] as RawEvent[])(e) }))));
    for (const { p, es } of events) out.push(...es.filter((e) => Date.parse(e.created_at) > since).map((e) => describeEvent(e, p)));
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ── Deploys ───────────────────────────────────────────────────────────────────

type RawDeployment = {
  id: number; ref: string; sha: string; created_at: string; user?: { username: string } | null;
  environment: { id: number; name: string }; deployable?: { name?: string; web_url?: string } | null;
};

/** Blocked deployments (waiting on an approval, GitLab Premium), newest per environment; older ones behind it are superseded. */
export function toDeploys(repo: string, projectUrl: string, raw: RawDeployment[]): Deploy[] {
  const byEnv = new Map<number, RawDeployment[]>();
  for (const d of [...raw].sort((a, b) => b.created_at.localeCompare(a.created_at))) byEnv.set(d.environment.id, [...(byEnv.get(d.environment.id) ?? []), d]);
  const run = (d: RawDeployment) => ({
    id: d.id,
    name: d.deployable?.name ?? "deploy",
    title: `Deploy ${d.ref} to ${d.environment.name}`,
    actor: d.user?.username ?? "",
    createdAt: d.created_at,
    url: d.deployable?.web_url ?? `${projectUrl}/-/environments/${d.environment.id}`,
    sha: d.sha.slice(0, 7),
    headSha: d.sha,
    branch: d.ref,
  });
  return [...byEnv.values()].map(([top, ...older]) => ({ ...run(top!), repo, envs: [top!.environment], superseded: older.map(run), more: false }));
}

export async function loadDeploys(gl: GitLab, repos: string[]): Promise<Deploy[]> {
  const out: Deploy[] = [];
  await Promise.all(
    [...new Set(repos)].map(async (repo) => {
      const raw = await gl.get<RawDeployment[]>(`/projects/${enc(repo)}/deployments?status=blocked&order_by=created_at&sort=desc&per_page=20`).catch(() => []);
      out.push(...toDeploys(repo, `https://${gl.host}/${repo}`, raw));
    }),
  );
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Issues (the core Issues pack, bergaaberg/dovre#36) ───────────────────────

type RawIssue = {
  iid: number; project_id: number; title: string; web_url: string; state: string; created_at: string; updated_at: string;
  author: { username: string } | null; assignees?: { username: string }[] | null; labels?: string[]; user_notes_count?: number;
  milestone?: { title: string } | null; issue_type?: string | null;
};
type RawTodo2 = { action_name: string; target_type: string; target: RawIssue | null };
type RawClosedBy = { iid: number; state: string; web_url: string };

const mrState = (s: string): Issue["prs"][number]["state"] => (s === "merged" ? "MERGED" : s === "opened" ? "OPEN" : "CLOSED");

export function toIssue(r: RawIssue, prs: RawClosedBy[] = []): Issue {
  return {
    repo: repoOfUrl(r.web_url),
    number: r.iid,
    title: r.title,
    url: r.web_url,
    state: r.state === "opened" ? "OPEN" : "CLOSED",
    labels: r.labels ?? [],
    author: r.author?.username ?? "ghost",
    assignees: (r.assignees ?? []).map((a) => a.username),
    comments: r.user_notes_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.milestone ? { milestone: r.milestone.title } : {}),
    ...(r.issue_type && r.issue_type !== "issue" ? { type: r.issue_type[0]!.toUpperCase() + r.issue_type.slice(1) } : {}),
    prs: prs.flatMap((m) => (repoOfUrl(m.web_url) ? [{ key: `${repoOfUrl(m.web_url)}#${m.iid}`, state: mrState(m.state) }] : [])),
  };
}

const REPO_PATH = /^[\w.-]+(\/[\w.-]+)+$/;
/** Merge requests looked up for "closed by", at most: one call each. */
const MAX_CLOSED_BY = 40;

/**
 * My open issues: assigned (scope=assigned_to_me), opened by me (created_by_me), mentioning me
 * (pending todos for a mention), and triage (open, no assignee, no label) in the `triage` projects.
 * In the owners' groups only; newest first.
 */
export async function loadIssues(gl: GitLab, owners: string, opts: { triage?: string[] } = {}): Promise<IssueSets> {
  const groups = ownersList.of(owners);
  const ours = (list: RawIssue[]) => list.filter((i) => i.state === "opened" && inOwners(repoOfUrl(i.web_url), groups));
  const triage = [...new Set(opts.triage ?? [])].filter((r) => REPO_PATH.test(r) && !r.split("/").some((p) => p === "." || p === "..") && inOwners(r, groups));
  const [assigned, authored, todos, ...waiting] = await Promise.all([
    gl.getAll<RawIssue>(`/issues?state=opened&scope=assigned_to_me&per_page=${PAGE_SIZE}`),
    gl.getAll<RawIssue>(`/issues?state=opened&scope=created_by_me&per_page=${PAGE_SIZE}`),
    gl.getAll<RawTodo2>(`/todos?state=pending&type=Issue&per_page=${PAGE_SIZE}`),
    ...triage.map((r) => gl.get<RawIssue[]>(`/projects/${enc(r)}/issues?state=opened&assignee_id=None&labels=None&per_page=30`)),
  ]);
  const mentioned = todos.flatMap((t) => (t.target_type === "Issue" && t.target && /^(mentioned|directly_addressed)$/.test(t.action_name) ? [t.target] : []));
  const raw = { assigned: ours(assigned), mentioned: ours(mentioned), authored: ours(authored), triage: ours(waiting.flat()) };
  // Each issue once, by key; then what closes it, for the first few.
  const keyOf = (i: RawIssue) => `${i.project_id}#${i.iid}`;
  const unique = new Map<string, RawIssue>();
  for (const list of Object.values(raw)) for (const i of list) unique.set(keyOf(i), i);
  const closedBy = new Map<string, RawClosedBy[]>();
  await Promise.all(
    [...unique.values()].slice(0, MAX_CLOSED_BY).map(async (i) => {
      closedBy.set(keyOf(i), await gl.get<RawClosedBy[]>(`/projects/${i.project_id}/issues/${i.iid}/closed_by`).catch(() => []));
    }),
  );
  const seen = (list: RawIssue[]) => {
    const once = new Set<string>();
    return list
      .filter((i) => (once.has(keyOf(i)) ? false : (once.add(keyOf(i)), true)))
      .map((i) => toIssue(i, closedBy.get(keyOf(i))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  return { assigned: seen(raw.assigned), mentioned: seen(raw.mentioned), authored: seen(raw.authored), triage: seen(raw.triage) };
}

// ── Shipped (Forge.shipped, pack API 2.6) ─────────────────────────────────────

/** The most merged merge requests given, the newest: as many as GitHub's forge gives. */
export const MAX_SHIPPED_PRS = 3000;
/** Projects read per owner (the last active first), and the releases read of each. */
const SHIP_PROJECTS = 100;
const SHIP_RELEASES = 20;
/** Pages of 100 tags read of a project, at most, while they still fall on or after the day. */
const TAG_PAGES = 10;

type Loose = Record<string, any>;
const str = (v: unknown, max = 255) => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown): Loose[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
/** A time as GitLab wrote it (in the instance's or the tagger's offset), in UTC; "" when it isn't one. */
const utc = (v: unknown): string => {
  const t = typeof v === "string" && v.length <= 40 ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().replace(".000Z", "Z") : "";
};
/** A UTC time on or after the day. */
const sinceDay = (at: string, since: string) => !!at && at.slice(0, 10) >= since;
const newest = <T>(items: T[], at: (x: T) => string) => items.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
/** A link GitLab gave, when it's on this host; "" otherwise. */
const onHost = (url: unknown, host: string) => (str(url, 500).startsWith(`https://${host}/`) ? str(url, 500) : "");
/** An annotated tag's own time; a plain tag has none, so its commit's. The order GitLab lists them in. */
const tagAt = (t: Loose | undefined) => utc(t?.created_at) || utc(t?.commit?.committed_date);
const notFound = <T>(v: T) => (e: unknown): T => {
  if (e instanceof GitLabError && e.status === 404) return v;
  throw e;
};

/** A project's tags, newest first, read on a page at a time while the page ends on or after the day. */
async function tagsSince(gl: GitLab, id: number, since: string, slot: ReturnType<typeof limiter>): Promise<Loose[]> {
  const out: Loose[] = [];
  for (let page = 1; page <= TAG_PAGES; page++) {
    const got = list(await slot(() => gl.get<unknown>(`/projects/${id}/repository/tags?order_by=updated&sort=desc&per_page=${PAGE_SIZE}&page=${page}`)).catch(orElse<unknown>([])));
    out.push(...got);
    if (got.length < PAGE_SIZE || !sinceDay(tagAt(got.at(-1)), since)) break;
  }
  return out;
}

type Shipped = { prs: ForgeShipped["prs"]; more: boolean; releases: ForgeShipped["releases"]; tags: ForgeShipped["tags"] };

/**
 * One owner's part: a group's merged merge requests in one paged list (its subgroups come along), or,
 * when the owner is a user, each of their projects'. Releases and tags are read per project, and only
 * of projects with activity on or after the day: a tag or a release made since then is activity.
 */
async function ownerShipped(gl: GitLab, owner: string, since: string, slot: ReturnType<typeof limiter>): Promise<Shipped> {
  const after = enc(`${since}T00:00:00Z`);
  // merged_after is the filter; updated_after says the same to a GitLab too old to know it (merged_at is checked below either way).
  const merged = `merge_requests?state=merged&merged_after=${after}&updated_after=${after}&order_by=updated_at&sort=desc&per_page=${PAGE_SIZE}`;
  const projectsQ = `?order_by=last_activity_at&sort=desc&archived=false&per_page=${SHIP_PROJECTS}`;
  const active = (raw: unknown) =>
    list(raw).flatMap((p) => {
      const repo = str(p.path_with_namespace);
      const last = utc(p.last_activity_at);
      if (!Number.isSafeInteger(p.id) || !REPO_PATH.test(repo) || !inOwners(repo, [owner]) || (last && !sinceDay(last, since))) return [];
      return [{ id: p.id as number, repo }];
    });
  let projects: { id: number; repo: string }[];
  let mrs: Loose[];
  try {
    const [p, m] = await Promise.all([gl.get<unknown>(`/groups/${enc(owner)}/projects${projectsQ}&include_subgroups=true`), gl.getAll<Loose>(`/groups/${enc(owner)}/${merged}`, MAX_SHIPPED_PRS + 1)]);
    projects = active(p);
    mrs = list(m);
  } catch (e) {
    // Not a group: a user, whose merge requests are listed per project.
    notFound(undefined)(e);
    projects = active(await gl.get<unknown>(`/users/${enc(owner)}/projects${projectsQ}`).catch(notFound<unknown>([])));
    mrs = (await Promise.all(projects.map((p) => slot(() => gl.getAll<Loose>(`/projects/${p.id}/${merged}`, MAX_SHIPPED_PRS + 1)).catch(orElse<Loose[]>([]))))).flatMap(list);
  }
  const prs = mrs.flatMap((m) => {
    const url = onHost(m.web_url, gl.host);
    const repo = repoOfUrl(url);
    const mergedAt = utc(m.merged_at);
    if (!REPO_PATH.test(repo) || !inOwners(repo, [owner]) || !Number.isSafeInteger(m.iid) || m.iid < 1 || !sinceDay(mergedAt, since)) return [];
    return [{ repo, number: m.iid as number, title: str(m.title, 300), url, mergedAt, author: str(m.author?.username, 100) }];
  });
  const releases: ForgeShipped["releases"] = [];
  const tags: ForgeShipped["tags"] = [];
  await Promise.all(
    projects.map(async ({ id, repo }) => {
      const [rels, refs] = await Promise.all([slot(() => gl.get<unknown>(`/projects/${id}/releases?per_page=${SHIP_RELEASES}`)).catch(orElse<unknown>([])), tagsSince(gl, id, since, slot)]);
      const released = new Set<string>();
      for (const x of list(rels)) {
        const tag = str(x.tag_name);
        if (!tag) continue;
        // A release speaks for its tag, in the window or not; one dated ahead hasn't shipped yet.
        released.add(tag);
        const at = utc(x.released_at) || utc(x.created_at);
        if (x.upcoming_release === true || !sinceDay(at, since)) continue;
        releases.push({ repo, tag, name: str(x.name, 300) || tag, url: onHost(x._links?.self, gl.host) || `https://${gl.host}/${repo}/-/releases/${enc(tag)}`, at });
      }
      for (const t of refs) {
        const tag = str(t.name);
        const at = tagAt(t);
        if (!tag || released.has(tag) || t.release || !sinceDay(at, since)) continue;
        tags.push({ repo, tag, url: `https://${gl.host}/${repo}/-/tags/${tag.split("/").map(enc).join("/")}`, at });
      }
    }),
  );
  return { prs, more: mrs.length > MAX_SHIPPED_PRS, releases, tags };
}

/**
 * What shipped in the owners' groups since a day (YYYY-MM-DD): merge requests merged, releases
 * published and tags with no release, each newest first. Titles, names, usernames, times and links only.
 */
export async function loadShipped(gl: GitLab, owners: string, since: string): Promise<ForgeShipped> {
  const slot = limiter(PARALLEL);
  const parts = await Promise.all(ownersList.of(owners).map((o) => ownerShipped(gl, o, since, slot)));
  const prs = newest(parts.flatMap((p) => p.prs), (p) => p.mergedAt);
  return {
    prs: prs.slice(0, MAX_SHIPPED_PRS),
    ...(parts.some((p) => p.more) || prs.length > MAX_SHIPPED_PRS ? { more: true as const } : {}),
    releases: newest(parts.flatMap((p) => p.releases), (r) => r.at),
    tags: newest(parts.flatMap((p) => p.tags), (t) => t.at),
  };
}

// ── The forge ─────────────────────────────────────────────────────────────────

export function gitlabForge(gl: GitLab): Forge {
  return {
    id: "gitlab",
    name: "GitLab",
    host: gl.host,
    can: [],
    viewer: async () => {
      const u = await gl.get<{ username: string; name: string | null }>("/user");
      return { login: u.username, name: u.name };
    },
    prs: (login, owners) => loadPrs(gl, login, owners),
    notes: () => loadNotes(gl),
    moves: (_login, owners) => loadMoves(gl, owners),
    prRefs: (keys) => loadPrRefs(gl, keys),
    prKeyOfUrl: (url) => {
      const m = url.match(MR_PATH);
      return m && hostOf(url.split("/")[2]) === gl.host ? `${m[1]}#${m[2]}` : undefined;
    },
    deploys: (repos) => loadDeploys(gl, repos),
    issues: (_login, owners, opts) => loadIssues(gl, owners, opts),
    shipped: (owners, since) => loadShipped(gl, owners, since),
  };
}
