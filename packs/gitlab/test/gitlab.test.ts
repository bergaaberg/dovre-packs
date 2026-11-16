/** The GitLab pack: GitLab's API as Dovre's forge, against a fake GitLab. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE, testForge } from "dovre/pack-testing.ts";
import { GitLabError, MAX_SHIPPED_PRS, checksOf, createGitLab, describeEvent, diffCounts, gitlabForge, hostOf, isBot, jobState, loadShipped, toDeploys, toNote } from "../forge.ts";
import { createGitlabPack } from "../index.ts";

const HOST = "git.example.com";
const MR = {
  iid: 3, project_id: 42, title: "Faster checkout", description: "Caches the cart.", draft: false,
  web_url: `https://${HOST}/northwind/web/shop/-/merge_requests/3`, updated_at: "2026-10-25T08:00:00Z",
  source_branch: "feat/cache", sha: "abc1234def5678", author: { username: "kari" }, labels: ["perf"], state: "opened",
};
const ELSEWHERE = { ...MR, iid: 9, project_id: 7, web_url: `https://${HOST}/someone-else/tool/-/merge_requests/9` };

/** A fake GitLab: answers by path (query left out), records what was asked and with which headers. */
function fakeGitLab(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.host, HOST);
    const path = url.pathname.replace(/^\/api\/v4/, "");
    asked.push(path + url.search);
    headers.push(init?.headers as Record<string, string>);
    const key = Object.keys(routes).find((k) => (k.includes("?") ? path + url.search === k || (path + url.search).startsWith(k) : path === k));
    if (!key) return new Response("not found", { status: 404 });
    return Response.json(routes[key]);
  }) as typeof fetch;
  return { fetchFn, asked, headers, gl: createGitLab({ host: HOST, token: "glpat-test", fetchFn }) };
}

test("the pack brings GitLab as a forge; FORGE=gitlab picks it, and without a token it says so", async () => {
  const { fetchFn } = fakeGitLab({ "/user": { username: "kari", name: "Kari Nordmann" } });
  const pack = createGitlabPack({ fetchFn });
  assert.equal(pack.forge?.id, "gitlab");
  const forge = testForge(pack, { GITLAB_HOST: `https://${HOST}/`, GITLAB_TOKEN: "glpat-test" });
  assert.equal(forge.host, HOST);
  assert.deepEqual(forge.can, []);
  assert.deepEqual(await forge.viewer(), { login: "kari", name: "Kari Nordmann" });

  const missing = testForge(pack);
  await assert.rejects(missing.prs("kari", "northwind"), /GITLAB_TOKEN isn't set/);
  assert.equal(hostOf(undefined), "gitlab.com");
});

test("the token goes in GitLab's own header, and never in a URL", async () => {
  const { gl, asked, headers } = fakeGitLab({ "/user": { username: "kari", name: null } });
  await gitlabForge(gl).viewer();
  assert.equal(headers[0]!["private-token"], "glpat-test");
  assert.ok(asked.every((a) => !a.includes("glpat")));
});

test("merge requests in the owners' groups become PRs: reviews, approvals, threads, jobs and diffs", async () => {
  const { gl, asked } = fakeGitLab({
    "/merge_requests?state=opened&scope=created_by_me": [MR, ELSEWHERE],
    "/merge_requests?state=opened&scope=all&reviewer_username=kari": [],
    "/projects/42/merge_requests/3": { ...MR, head_pipeline: { id: 77, status: "failed" } },
    "/projects/42/merge_requests/3/reviewers": [{ user: { username: "per" }, state: "requested_changes" }, { user: { username: "ola" }, state: "unreviewed" }],
    "/projects/42/merge_requests/3/approvals": { approved: true, approved_by: [{ user: { username: "lise" } }] },
    "/projects/42/merge_requests/3/discussions": [{ notes: [{ resolvable: true, resolved: false }] }, { notes: [{ resolvable: true, resolved: true }] }, { notes: [{ resolvable: false }] }],
    "/projects/42/pipelines/77/jobs": [{ name: "lint", status: "success", web_url: "https://x/1" }, { name: "test", status: "failed", web_url: "https://x/2" }, { name: "flaky", status: "failed", web_url: null, allow_failure: true }],
    "/projects/42/merge_requests/3/diffs": [{ new_path: "src/cart.ts", diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same" }],
  });
  const { mine, review } = await gitlabForge(gl).prs("kari", "northwind");
  assert.equal(review.length, 0);
  assert.equal(mine.length, 1, "the MR outside the owners' groups is left out");
  const pr = mine[0]!;
  assert.equal(pr.repo, "northwind/web/shop");
  assert.equal(pr.number, 3);
  assert.equal(pr.review, "CHANGES_REQUESTED");
  assert.equal(pr.checks, "FAILURE");
  assert.equal(pr.openThreads, 1);
  assert.deepEqual(pr.requested, ["ola"]);
  assert.deepEqual(pr.reviews, [{ login: "per", state: "CHANGES_REQUESTED" }, { login: "lise", state: "APPROVED" }]);
  assert.deepEqual(pr.runs.map((r) => `${r.name}:${r.state}`), ["test:bad", "lint:ok", "flaky:skipped"]);
  assert.deepEqual(pr.files, [{ path: "src/cart.ts", additions: 2, deletions: 1 }]);
  assert.equal(pr.additions, 2);
  assert.ok(!asked.some((a) => a.startsWith("/projects/7/")), "nothing read about the MR outside");
});

test("a PR's review decision, checks and job states", () => {
  assert.equal(checksOf("success"), "SUCCESS");
  assert.equal(checksOf("running"), "PENDING");
  assert.equal(checksOf("manual"), "PENDING");
  assert.equal(checksOf(null), "NONE");
  assert.equal(jobState({ status: "canceled" }), "skipped");
  assert.equal(jobState({ status: "waiting_for_resource" }), "pending");
  assert.deepEqual(diffCounts("+++ b/x\n--- a/x\n+a\n-b\n c"), { additions: 1, deletions: 1 });
});

test("todos become notes in the words Dovre's needs know", () => {
  const n = toNote({ id: 5, action_name: "directly_addressed", target_type: "MergeRequest", target_url: MR.web_url, updated_at: "2026-10-25T07:00:00Z", project: { path_with_namespace: "northwind/web/shop" }, target: { title: "Faster checkout" } });
  assert.deepEqual(n, { id: "5", reason: "mention", type: "PullRequest", title: "Faster checkout", repo: "northwind/web/shop", updatedAt: "2026-10-25T07:00:00Z", url: MR.web_url });
  assert.equal(toNote({ ...{ id: 6, target_url: "", updated_at: "" }, action_name: "review_requested", target_type: "MergeRequest" }).reason, "review_requested");
});

test("project events become movement: merged, approved, commented, pushed, tagged", () => {
  const p = { path_with_namespace: "northwind/web/shop", web_url: `https://${HOST}/northwind/web/shop` };
  const at = "2026-10-25T07:00:00Z";
  const merged = describeEvent({ action_name: "accepted", target_type: "MergeRequest", target_iid: 3, target_title: "Faster checkout", created_at: at, author: { username: "per" } }, p);
  assert.equal(merged.verb, "merged");
  assert.equal(merged.ref, "northwind/web/shop#3");
  assert.equal(merged.url, `${p.web_url}/-/merge_requests/3`);
  assert.equal(describeEvent({ action_name: "approved", target_type: "MergeRequest", target_iid: 3, created_at: at, author_username: "lise" }, p).verb, "reviewed (approved)");
  assert.equal(describeEvent({ action_name: "commented on", target_type: "DiffNote", note: { noteable_type: "MergeRequest", noteable_iid: 3 }, created_at: at, author_username: "ola" }, p).ref, "northwind/web/shop#3");
  const push = describeEvent({ action_name: "pushed to", target_type: null, push_data: { ref: "main", ref_type: "branch", commit_count: 2 }, created_at: at, author_username: "project_42_bot_abc" }, p);
  assert.equal(push.verb, "pushed 2 to");
  assert.equal(push.bot, true);
  assert.equal(describeEvent({ action_name: "pushed new", target_type: null, push_data: { ref: "v1.2.0", ref_type: "tag" }, created_at: at, author_username: "per" }, p).verb, "created tag");
  assert.ok(isBot("ghost") && !isBot("kari"));
});

test("movement: the owners' active projects, only the last day", async () => {
  const now = Date.parse("2026-10-25T09:00:00Z");
  const { gl } = fakeGitLab({
    "/groups/northwind/projects": [{ id: 42, path_with_namespace: "northwind/web/shop", web_url: `https://${HOST}/northwind/web/shop` }],
    "/projects/42/events": [
      { action_name: "accepted", target_type: "MergeRequest", target_iid: 3, target_title: "Faster checkout", created_at: "2026-10-25T08:00:00Z", author_username: "per" },
      { action_name: "opened", target_type: "MergeRequest", target_iid: 1, target_title: "Old", created_at: "2026-10-23T08:00:00Z", author_username: "per" },
    ],
  });
  const { loadMoves } = await import("../forge.ts");
  const moves = await loadMoves(gl, "northwind", 24, now);
  assert.deepEqual(moves.map((m) => m.verb), ["merged"]);
});

test("merge request links: the forge's own keys, and their state and title", async () => {
  const { gl } = fakeGitLab({ "/projects/northwind%2Fweb%2Fshop/merge_requests/3": { ...MR, state: "merged" } });
  const forge = gitlabForge(gl);
  assert.equal(forge.prKeyOfUrl(MR.web_url), "northwind/web/shop#3");
  assert.equal(forge.prKeyOfUrl("https://github.com/acme/shop/pull/3"), undefined);
  assert.equal(forge.prKeyOfUrl("https://gitlab.com/northwind/shop/-/merge_requests/3"), undefined, "another host's MR isn't this forge's");
  const refs = await forge.prRefs(["northwind/web/shop#3", "nope"]);
  assert.deepEqual(refs.get("northwind/web/shop#3"), { state: "MERGED", title: "Faster checkout", url: MR.web_url });
  assert.equal(refs.size, 1);
});

test("blocked deployments: the newest per environment waits, older ones are superseded", () => {
  const d = (id: number, env: number, at: string) => ({ id, ref: "main", sha: `sha${id}aaaaaaa`, created_at: at, user: { username: "per" }, environment: { id: env, name: env === 1 ? "production" : "staging" }, deployable: { name: "deploy", web_url: `https://${HOST}/jobs/${id}` } });
  const out = toDeploys("northwind/shop", `https://${HOST}/northwind/shop`, [d(1, 1, "2026-10-25T06:00:00Z"), d(2, 1, "2026-10-25T07:00:00Z"), d(3, 2, "2026-10-25T05:00:00Z")]);
  assert.equal(out.length, 2);
  const prod = out.find((x) => x.envs[0]!.name === "production")!;
  assert.equal(prod.id, 2);
  assert.deepEqual(prod.superseded.map((r) => r.id), [1]);
  assert.equal(prod.sha, "sha2aaa");
  assert.equal(prod.url, `https://${HOST}/jobs/2`);
});

test("issues(): assigned, opened by me, mentioned from todos, triage per project; the owners' groups only, each once, with what closes it", async () => {
  const issue = (iid: number, o: Record<string, unknown> = {}) => ({
    iid, project_id: 42, title: `Issue ${iid}`, web_url: `https://${HOST}/northwind/web/shop/-/issues/${iid}`, state: "opened",
    created_at: "2026-10-20T00:00:00Z", updated_at: `2026-10-2${iid % 10}T00:00:00Z`, author: { username: "kari" },
    assignees: [{ username: "kari" }], labels: ["bug"], user_notes_count: 2, milestone: { title: "Q4" }, issue_type: "issue", ...o,
  });
  const outside = issue(9, { project_id: 7, web_url: `https://${HOST}/someone-else/tool/-/issues/9` });
  const { gl, asked } = fakeGitLab({
    "/issues?state=opened&scope=assigned_to_me": [issue(1), issue(2, { issue_type: "incident" }), outside],
    "/issues?state=opened&scope=created_by_me": [issue(3, { assignees: [] })],
    "/todos?state=pending&type=Issue": [
      { action_name: "mentioned", target_type: "Issue", target: issue(1) },
      { action_name: "mentioned", target_type: "Issue", target: issue(1) },
      { action_name: "assigned", target_type: "Issue", target: issue(4) },
      { action_name: "directly_addressed", target_type: "Issue", target: issue(5) },
      { action_name: "mentioned", target_type: "MergeRequest", target: null },
    ],
    "/projects/northwind%2Fweb%2Fshop/issues?state=opened&assignee_id=None&labels=None": [issue(6, { assignees: [], labels: [] })],
    "/projects/42/issues/1/closed_by": [{ iid: 3, state: "merged", web_url: `https://${HOST}/northwind/web/shop/-/merge_requests/3` }],
  });
  const sets = await gitlabForge(gl).issues!("kari", "northwind", { triage: ["northwind/web/shop", "someone-else/tool", "northwind/../x"] });
  assert.deepEqual(sets.assigned.map((i) => i.number), [2, 1]);
  assert.deepEqual(sets.mentioned.map((i) => i.number), [5, 1], "a mention once; an assignment todo isn't one");
  assert.deepEqual(sets.authored.map((i) => i.number), [3]);
  assert.deepEqual(sets.triage.map((i) => i.number), [6]);
  const one = sets.assigned.find((i) => i.number === 1)!;
  assert.deepEqual(
    { repo: one.repo, labels: one.labels, assignees: one.assignees, comments: one.comments, milestone: one.milestone, prs: one.prs, type: one.type },
    { repo: "northwind/web/shop", labels: ["bug"], assignees: ["kari"], comments: 2, milestone: "Q4", prs: [{ key: "northwind/web/shop#3", state: "MERGED" }], type: undefined },
  );
  assert.equal(sets.assigned[0]!.type, "Incident");
  assert.ok(!asked.some((a) => a.includes("someone-else")), "a project outside the owners is never asked");
  assert.ok(!asked.some((a) => a.includes("/projects/7/")), "nor what closes an issue outside them");
});

// ── Timeouts, paging, fan-out, rate limits, hostile input ────────────────────

const json = (body: unknown, headers: Record<string, string> = {}) => Response.json(body, { headers });

test("a request that never answers fails after the timeout, naming the path without its query", async () => {
  const fetchFn = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))) as unknown as typeof fetch;
  const gl = createGitLab({ host: HOST, token: "glpat-test", fetchFn, timeoutMs: 20 });
  await assert.rejects(gl.get("/todos?state=pending&secret=1"), (e: Error) => /GitLab GET \/todos: timed out/.test(e.message) && !e.message.includes("secret"));
});

test("getAll follows x-next-page into one list, and stops at the cap", async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: string) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? 1);
    seen.push(String(page));
    const items = [page * 10, page * 10 + 1];
    return json(items, page < 3 ? { "x-next-page": String(page + 1) } : { "x-next-page": "" });
  }) as unknown as typeof fetch;
  const gl = createGitLab({ host: HOST, token: "t", fetchFn });
  assert.deepEqual(await gl.getAll<number>("/todos?per_page=2"), [10, 11, 20, 21, 30, 31]);
  assert.deepEqual(seen, ["1", "2", "3"]);
  seen.length = 0;
  assert.deepEqual(await gl.getAll<number>("/todos?per_page=2", 3), [10, 11, 20], "the cap holds");
  assert.deepEqual(seen, ["1", "2"], "and no page past it is read");
});

test("getAll stops when every page is empty but x-next-page never ends", async () => {
  let reads = 0;
  const fetchFn = (async () => {
    reads++;
    return json([], { "x-next-page": "2" });
  }) as unknown as typeof fetch;
  assert.deepEqual(await createGitLab({ host: HOST, token: "t", fetchFn }).getAll("/todos"), []);
  assert.ok(reads <= 6, `pages read: ${reads}`);
});

test("with 20 merge requests, no more than 4 detail reads are in flight", async () => {
  const mrs = Array.from({ length: 20 }, (_, i) => ({ ...MR, iid: i + 1, web_url: `https://${HOST}/northwind/shop/-/merge_requests/${i + 1}` }));
  let active = 0, peak = 0, detail = 0;
  const fetchFn = (async (input: string) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v4/, "");
    if (path === "/merge_requests") return json(url.searchParams.get("scope") === "created_by_me" ? mrs : []);
    detail++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return json(/merge_requests\/\d+$/.test(path) ? MR : path.endsWith("/approvals") ? {} : []);
  }) as unknown as typeof fetch;
  const { mine } = await gitlabForge(createGitLab({ host: HOST, token: "t", fetchFn })).prs("kari", "northwind");
  assert.equal(mine.length, 20);
  assert.ok(detail >= 80, `detail reads happened (${detail})`);
  assert.ok(peak <= 4 && peak > 1, `peak in flight: ${peak}`);
});

test("a 429 is a failure, not an empty list", async () => {
  const fetchFn = (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
  const gl = createGitLab({ host: HOST, token: "t", fetchFn });
  await assert.rejects(gitlabForge(gl).notes(), (e: unknown) => e instanceof GitLabError && e.status === 429);
  // …and one on a per-MR detail read reaches the caller too, instead of reading as "no reviewers".
  const limited = (async (input: string) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v4/, "");
    if (path === "/merge_requests") return json([MR]);
    return new Response("slow down", { status: 429 });
  }) as unknown as typeof fetch;
  await assert.rejects(gitlabForge(createGitLab({ host: HOST, token: "t", fetchFn: limited })).prs("kari", "northwind"), /429/);
});

test("hostile titles, branches and job names come out as data, and URLs are built with encodeURIComponent", async () => {
  const H = HOSTILE;
  const hostile = { ...MR, title: H, source_branch: H, description: H, labels: [H], head_pipeline: { id: 5, status: "failed" } };
  const { gl, asked } = fakeGitLab({
    "/merge_requests?state=opened&scope=created_by_me": [hostile],
    "/merge_requests?state=opened&scope=all&reviewer_username=kari": [],
    "/projects/42/merge_requests/3": hostile,
    "/projects/42/merge_requests/3/reviewers": [],
    "/projects/42/merge_requests/3/approvals": {},
    "/projects/42/merge_requests/3/discussions": [],
    "/projects/42/pipelines/5/jobs": [{ name: H, status: "failed", web_url: "https://x/1" }],
    "/projects/42/merge_requests/3/diffs": [],
  });
  const { mine } = await gitlabForge(gl).prs("kari", "northwind");
  assert.equal(mine[0]!.title, H);
  assert.equal(mine[0]!.branch, H);
  assert.equal(mine[0]!.runs[0]!.name, H);
  assert.deepEqual(mine[0]!.labels, [H]);
  assert.ok(asked.every((a) => !a.includes("<") && !a.includes('"')), "no raw markup in any request");
  const move = describeEvent({ action_name: "pushed to", target_type: null, created_at: "2026-10-25T08:00:00Z", author: { username: "kari" }, push_data: { ref: H, ref_type: "branch", commit_count: 1 } }, { path_with_namespace: "northwind/shop", web_url: `https://${HOST}/northwind/shop` });
  assert.equal(move.title, H);
  assert.ok(move.url!.endsWith(`/-/commits/${encodeURIComponent(H)}`) && !move.url!.includes("<"));
});

// ── Shipped (pack API 2.6) ────────────────────────────────────────────────────

const SINCE = "2026-10-20";
const SHOP = { id: 42, path_with_namespace: "northwind/web/shop", web_url: `https://${HOST}/northwind/web/shop`, last_activity_at: "2026-10-25T08:00:00Z" };
const merged = (iid: number, merged_at: string | null, over: Record<string, unknown> = {}) => ({ iid, title: `MR ${iid}`, web_url: `${SHOP.web_url}/-/merge_requests/${iid}`, merged_at, author: { username: "kari" }, ...over });

test("shipped: a group's merged merge requests, releases and tags with no release since a day, newest first", async () => {
  const { gl, asked } = fakeGitLab({
    "/groups/northwind/projects": [
      SHOP,
      { id: 43, path_with_namespace: "northwind/old", web_url: `https://${HOST}/northwind/old`, last_activity_at: "2026-09-01T00:00:00Z" },
      { id: 7, path_with_namespace: "someone-else/tool", web_url: `https://${HOST}/someone-else/tool`, last_activity_at: "2026-10-25T08:00:00Z" },
      { id: "44", path_with_namespace: "northwind/odd" },
      null,
    ],
    "/groups/northwind/merge_requests": [
      merged(5, "2026-10-24T10:00:00.000+02:00"),
      merged(6, "2026-10-26T09:30:00Z", { author: null }),
      merged(4, "2026-10-19T23:59:59Z"), // merged before the day, touched since
      merged(8, null),
      merged(9, "2026-10-25T00:00:00Z", { web_url: `https://${HOST}/someone-else/tool/-/merge_requests/9` }),
      merged(10, "2026-10-25T00:00:00Z", { web_url: `https://evil.example/northwind/web/shop/-/merge_requests/10` }),
      merged(0, "2026-10-25T00:00:00Z"),
    ],
    "/projects/42/releases": [
      { tag_name: "v3.0.0", name: "Three", released_at: "2026-12-01T00:00:00Z", created_at: "2026-10-25T00:00:00Z", upcoming_release: true, _links: { self: `${SHOP.web_url}/-/releases/v3.0.0` } },
      { tag_name: "v2.1.0", name: "Faster checkout", released_at: "2026-10-25T12:00:00.000Z", created_at: "2026-10-25T11:00:00Z", _links: { self: `${SHOP.web_url}/-/releases/v2.1.0` } },
      { tag_name: "v2.0.1", name: null, released_at: "2026-10-21T12:00:00Z", _links: { self: "javascript:alert(1)" } },
      { tag_name: "v2.0.0", name: "Two", released_at: "2026-09-01T12:00:00Z" },
    ],
    "/projects/42/repository/tags": [
      { name: "v3.0.0", created_at: "2026-10-25T00:00:00Z", commit: { committed_date: "2026-10-25T00:00:00Z" }, release: { tag_name: "v3.0.0" } },
      { name: "packs/shop/v1.0.0", created_at: "2026-10-23T08:00:00.000+02:00", commit: { committed_date: "2026-10-01T00:00:00Z" }, release: null },
      { name: "nightly", created_at: null, commit: { committed_date: "2026-10-22T03:00:00Z" }, release: null },
      { name: "v2.0.1", created_at: null, commit: { committed_date: "2026-10-21T11:00:00Z" }, release: null }, // its release is in the list
      { name: "v1.9.0", created_at: null, commit: { committed_date: "2026-08-01T00:00:00Z" }, release: null },
    ],
  });
  const s = await gitlabForge(gl).shipped!("northwind", SINCE);
  assert.deepEqual(s.prs, [
    { repo: "northwind/web/shop", number: 6, title: "MR 6", url: `${SHOP.web_url}/-/merge_requests/6`, mergedAt: "2026-10-26T09:30:00Z", author: "" },
    { repo: "northwind/web/shop", number: 5, title: "MR 5", url: `${SHOP.web_url}/-/merge_requests/5`, mergedAt: "2026-10-24T08:00:00Z", author: "kari" },
  ]);
  assert.equal(s.more, undefined);
  assert.deepEqual(s.releases, [
    { repo: "northwind/web/shop", tag: "v2.1.0", name: "Faster checkout", url: `${SHOP.web_url}/-/releases/v2.1.0`, at: "2026-10-25T12:00:00Z" },
    { repo: "northwind/web/shop", tag: "v2.0.1", name: "v2.0.1", url: `${SHOP.web_url}/-/releases/v2.0.1`, at: "2026-10-21T12:00:00Z" },
  ]);
  assert.deepEqual(s.tags, [
    { repo: "northwind/web/shop", tag: "packs/shop/v1.0.0", url: `${SHOP.web_url}/-/tags/packs/shop/v1.0.0`, at: "2026-10-23T06:00:00Z" },
    { repo: "northwind/web/shop", tag: "nightly", url: `${SHOP.web_url}/-/tags/nightly`, at: "2026-10-22T03:00:00Z" },
  ]);
  const mrs = asked.find((a) => a.startsWith("/groups/northwind/merge_requests"))!;
  assert.match(mrs, /state=merged&merged_after=2026-10-20T00%3A00%3A00Z&updated_after=2026-10-20T00%3A00%3A00Z/);
  assert.ok(asked.some((a) => a.startsWith("/groups/northwind/projects?") && a.includes("include_subgroups=true") && a.includes("archived=false")));
  assert.ok(!asked.some((a) => a.startsWith("/projects/43/") || a.startsWith("/projects/7/") || a.startsWith("/projects/44/")), "only the owners' projects with activity since the day are read");
  assert.equal(asked.filter((a) => a.startsWith("/projects/42/repository/tags")).length, 1, "a short page of tags is the last");
});

test("shipped: an owner that's a user is read per project; one that's neither gives nothing", async () => {
  const TOOL = { id: 7, path_with_namespace: "kari/tool", web_url: `https://${HOST}/kari/tool`, last_activity_at: "2026-10-25T08:00:00Z" };
  const { gl, asked } = fakeGitLab({
    "/users/kari/projects": [TOOL],
    "/projects/7/merge_requests": [merged(2, "2026-10-22T10:00:00Z", { web_url: `${TOOL.web_url}/-/merge_requests/2` })],
    "/projects/7/repository/tags": [{ name: "v0.1.0", created_at: null, commit: { committed_date: "2026-10-22T11:00:00Z" }, release: null }],
  });
  const s = await loadShipped(gl, "kari, nobody", SINCE);
  assert.deepEqual(s.prs.map((p) => `${p.repo}#${p.number}`), ["kari/tool#2"]);
  assert.deepEqual(s.releases, [], "a project with releases turned off answers 404: none");
  assert.deepEqual(s.tags.map((t) => t.tag), ["v0.1.0"]);
  assert.ok(asked.some((a) => a.startsWith("/users/nobody/projects")));
});

test("shipped: tags are read on while a full page ends inside the window, ten pages at most; more than the cap of merge requests says so", async () => {
  const pages: number[] = [];
  const tag = (i: number, day: string) => ({ name: `v0.${i}`, created_at: null, commit: { committed_date: `${day}T00:00:00Z` }, release: null });
  const fetchFn = (async (input: string) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v4/, "");
    const page = Number(url.searchParams.get("page") ?? 1);
    if (path === "/groups/northwind/projects") return json([SHOP, { ...SHOP, id: 45, path_with_namespace: "northwind/busy" }]);
    if (path === "/groups/northwind/merge_requests")
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => merged(page * 100 + i, "2026-10-25T00:00:00Z"))), { headers: { "content-type": "application/json", "x-next-page": String(page + 1) } });
    if (path === "/projects/42/repository/tags") {
      pages.push(page);
      // Page 1 is all inside the window; page 2 ends before it.
      return json(Array.from({ length: 100 }, (_, i) => tag(page * 100 + i, page === 1 || i < 50 ? "2026-10-21" : "2026-10-01")));
    }
    if (path === "/projects/45/repository/tags") return json(Array.from({ length: 100 }, (_, i) => tag(page * 100 + i, "2026-10-21")));
    return json([]);
  }) as unknown as typeof fetch;
  let busy = 0;
  const counting = (async (input: string) => {
    if (String(input).includes("/projects/45/repository/tags")) busy++;
    return fetchFn(input);
  }) as unknown as typeof fetch;
  const s = await loadShipped(createGitLab({ host: HOST, token: "t", fetchFn: counting }), "northwind", SINCE);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(s.tags.filter((t) => t.repo === "northwind/web/shop").length, 150);
  assert.equal(busy, 10, "ten pages at most");
  assert.equal(s.prs.length, MAX_SHIPPED_PRS);
  assert.equal(s.more, true);
});

test("shipped: a failure is a failure (a 500 on the group, a 429 on a project), not nothing shipped", async () => {
  const down = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(loadShipped(createGitLab({ host: HOST, token: "t", fetchFn: down }), "northwind", SINCE), /500/);
  const limited = (async (input: string) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v4/, "");
    if (path === "/groups/northwind/projects") return json([SHOP]);
    if (path === "/groups/northwind/merge_requests") return json([]);
    return new Response("slow down", { status: 429 });
  }) as unknown as typeof fetch;
  await assert.rejects(loadShipped(createGitLab({ host: HOST, token: "t", fetchFn: limited }), "northwind", SINCE), /429/);
});

test("shipped: hostile titles and names come out as data, capped; links are on the host and tags encoded into them", async () => {
  const H = HOSTILE;
  const { gl, asked } = fakeGitLab({
    "/groups/northwind/projects": [SHOP],
    "/groups/northwind/merge_requests": [merged(5, "2026-10-24T10:00:00Z", { title: H.repeat(40), author: { username: H } }), merged(6, H), { ...merged(7, "2026-10-24T10:00:00Z"), web_url: H }],
    "/projects/42/releases": [{ tag_name: H, name: H, released_at: "2026-10-25T12:00:00Z", _links: { self: H } }, { tag_name: 5, released_at: "2026-10-25T12:00:00Z" }],
    "/projects/42/repository/tags": [{ name: `a b/${H}`, created_at: "2026-10-23T08:00:00Z", release: null }, { name: "x", created_at: H, commit: { committed_date: H } }, "junk"],
  });
  const s = await loadShipped(gl, "northwind", SINCE);
  assert.equal(s.prs.length, 1);
  assert.equal(s.prs[0]!.title.length, 300);
  assert.equal(s.prs[0]!.author, H);
  assert.deepEqual(s.releases.map((r) => [r.tag, r.name, r.url]), [[H, H, `${SHOP.web_url}/-/releases/${encodeURIComponent(H)}`]]);
  assert.deepEqual(s.tags.map((t) => t.url), [`${SHOP.web_url}/-/tags/a%20b/${H.split("/").map(encodeURIComponent).join("/")}`]);
  assert.ok([...s.prs, ...s.releases, ...s.tags].every((x) => x.url.startsWith(`https://${HOST}/`) && !x.url.includes("<") && !x.url.includes('"')));
  assert.ok(asked.every((a) => !a.includes("<") && !a.includes('"')), "no raw markup in any request");
});

test("the pack declares pack API 2.6, which shipped came with", () => {
  assert.equal(createGitlabPack().manifest.api, "2.6");
});
