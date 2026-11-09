/** The Storybook pack's pages in the app (dovre#160, #166): hostile input inert, frames only for its origins, building only from Dovre. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE as H, assertInert, assertScoped, packApp } from "dovre/pack-testing.ts";
import type { BuildState } from "../build.ts";
import { createStorybookPack } from "../index.ts";

type Pr = { head: { ref: string; sha: string }; base: { ref: string; sha: string }; files: { path: string; status: string }[] };
/** A forge that answers a PR, folders and files at a commit (pack API 1.21). */
function forgeOf(o: { prs: Record<string, Pr>; dirs?: Record<string, string[]>; files?: Record<string, string> }) {
  return {
    id: "github",
    name: "GitHub",
    can: [] as const,
    host: "github.com",
    pr: async (repo: string, n: number) => o.prs[`${repo}#${n}`],
    dir: async (repo: string, path: string, at: string) => o.dirs?.[`${repo}:${path}@${at}`] ?? [],
    file: async (repo: string, path: string, at?: string) => o.files?.[`${repo}:${path}@${at}`],
  };
}

const HEAD = "1".repeat(40), BASE = "2".repeat(40);

test("storybook: hostile stories files, titles and branches stay inert; frames only on its own page, for its origins; off and unknown repos 404", async () => {
  const env = { STORYBOOK: "ACME/web https://acme.example.io/web/pr-{pr}/ https://acme.example.io/web/{base}/; OTHER/x https://other.example.io/{pr}/ https://other.example.io/main/" };
  const path = "src/ui/Button.stories.tsx";
  const src = `const meta = { title: "<script>x</script>/Button", component: Button };\nexport default meta;\nexport const Primary = {};\nexport const WithIcon = { args: { title: "${H}" } };`;
  const forge = forgeOf({
    prs: { "ACME/web#7": { head: { ref: H, sha: HEAD }, base: { ref: "main", sha: BASE }, files: [{ path, status: "modified" }, { path: "src/ui/Button.tsx", status: "modified" }, { path: `src/${H}/Odd.stories.tsx`, status: "added" }] } },
    dirs: { [`ACME/web:src/ui@${HEAD}`]: [path, "src/ui/Other.stories.tsx"] },
    files: { [`ACME/web:${path}@${HEAD}`]: src, [`ACME/web:src/ui/Other.stories.tsx@${HEAD}`]: "export default {};\nexport const Big = {};" },
  });
  const pack = createStorybookPack({ build: () => undefined });
  assertScoped(pack);
  const { get } = packApp([pack], { env, forge });
  const res = await get("/storybook/ACME/web/7");
  assert.equal(res.status, 200);
  const out = await res.text();
  assertInert("/storybook", out);
  assert.ok(!out.includes('href="javascript:') && !out.includes('src="javascript:'));
  assert.match(out, /iframe\.html\?id=script-x-script-button--primary&amp;viewMode=story/);
  assert.match(out, /https:\/\/acme\.example\.io\/web\/main\/iframe\.html/);
  assert.match(out, /https:\/\/acme\.example\.io\/web\/pr-7\/iframe\.html/);
  assert.ok(out.includes("other--big") || out.includes("Big"), "the stories beside a changed file are found too");
  assert.doesNotMatch(out, /Odd\.stories/, "a path the pack API won't read (not plain) is left out, quietly");
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-src 'self' https:\/\/acme\.example\.io https:\/\/other\.example\.io/);
  // Core pages never frame them.
  assert.doesNotMatch((await get("/settings")).headers.get("content-security-policy") ?? "", /example\.io/);
  // A repo STORYBOOK doesn't name, or one outside the owners: not found.
  assert.equal((await get("/storybook/ACME/api/7")).status, 404);
  assert.equal((await get("/storybook/OTHER/x/7")).status, 404);
  // Without STORYBOOK the pack is off: no page.
  const off = packApp([createStorybookPack({ build: () => undefined })], { forge });
  assert.equal((await off.get("/storybook/ACME/web/7")).status, 404);
});

test("storybook built here: Build here starts the PR's build (from Dovre only, logged), a failure's output stays inert, a build is framed from the other host", async () => {
  const env = { STORYBOOK: "ACME/web https://acme.example.io/web/" };
  const forge = forgeOf({
    prs: { "ACME/web#7": { head: { ref: "feat/x", sha: HEAD }, base: { ref: "main", sha: BASE }, files: [{ path: "src/b/Button.stories.ts", status: "modified" }] } },
    files: { [`ACME/web:src/b/Button.stories.ts@${HEAD}`]: "export default {};\nexport const Primary = {};" },
  });
  let state: BuildState = { status: "none" };
  const started: [string, string[]][] = [];
  const builds = { outDir: "x", state: () => state, start: (repo: string, shas: string[]) => (started.push([repo, shas]), true), url: (o: string, _r: string, sha: string) => `${o}/acme__web/${sha}/` };
  const pack = createStorybookPack({ build: () => ({ builds, port: 4849, ensure: () => {} }) });
  const { get, post, db } = packApp([pack], { env, forge });
  const page = async () => {
    await get("/storybook/ACME/web/7");
    return (await get("/storybook/ACME/web/7")).text();
  };
  let out = await page();
  assert.match(out, /action="\/storybook\/ACME\/web\/7\/build"/);
  assert.match(out, /Not built yet/);
  assert.match(out, /https:\/\/acme\.example\.io\/web\/iframe\.html/, "the published base is framed");
  // Only Dovre's own pages start a build.
  assert.equal((await post("/storybook/ACME/web/7/build", {}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/storybook/ACME/web/7/build", {}, { "sec-fetch-site": "same-site" })).status, 404, "a sibling site (a build on the other host) can't either");
  assert.equal(started.length, 0);
  const res = await post("/storybook/ACME/web/7/build", {}, { "sec-fetch-site": "same-origin" });
  assert.equal(res.status, 303);
  assert.deepEqual(started, [["ACME/web", [HEAD]]], "only the side CI doesn't publish");
  const logged = await db.DB.prepare("SELECT kind, target FROM actions WHERE kind = 'storybook.build'").all<{ kind: string; target: string }>();
  assert.deepEqual(logged.results.map((r) => r.target), ["ACME/web#7"]);
  state = { status: "building", step: "Installing packages", startedAt: 1 };
  out = await page();
  assert.match(out, /data-pending/);
  assert.match(out, /Installing packages/);
  state = { status: "failed", why: `storybook build failed: ${H}`, tail: H, at: 1 };
  out = await page();
  assertInert("/storybook build failed", out);
  assert.match(out, /Build again/);
  state = { status: "ready" };
  const ready = await get("/storybook/ACME/web/7");
  out = await ready.text();
  assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:4849/acme__web/${HEAD}/iframe\\.html`), "Dovre on localhost: the build from 127.0.0.1");
  assert.match(ready.headers.get("content-security-policy") ?? "", /frame-src 'self' https:\/\/acme\.example\.io http:\/\/localhost:4849 http:\/\/127\.0\.0\.1:4849/);
  assert.doesNotMatch(out, /action="\/storybook\/ACME\/web\/7\/build"/, "nothing left to build");
});
