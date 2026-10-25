/** The GitLab pack: GitLab's API as Dovre's forge, against a fake GitLab. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickForge } from "dovre/forge/pick.ts";
import { checksOf, createGitLab, describeEvent, diffCounts, gitlabForge, hostOf, isBot, jobState, toDeploys, toNote } from "../forge.ts";
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
  const forge = pickForge("gitlab", [pack], () => assert.fail("not GitHub"), { GITLAB_HOST: `https://${HOST}/`, GITLAB_TOKEN: "glpat-test" });
  assert.equal(forge.host, HOST);
  assert.deepEqual(forge.can, []);
  assert.deepEqual(await forge.viewer(), { login: "kari", name: "Kari Nordmann" });

  const missing = pickForge("gitlab", [pack], () => assert.fail("not GitHub"), {});
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
