/**
 * HTTP client (`http`): the stories' routes (dovre-packs#65 H-04). All of /http is behind
 * strictOrigin (index.ts). Nothing is sent on a GET. A run is one click on the page that showed it
 * (sending is the point), each request logged as `http.send` as any send is and the run as
 * `http.run`. The run re-checks every file it reads (the story, its setups, the .http files its
 * cases are in) against the hash they were shown with; a file that changed since is shown again.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { logAction } from "dovre/actions/deploys.ts";
import type { AppEnv } from "dovre/env.ts";
import type { PackContext } from "dovre/packs/types.ts";
import { codeDirOf, hashOf, listRepos, listStories, readFile, readStoryFile, repoRoot, STORY_RE } from "./files.ts";
import { masker, parseHttp, type Req } from "./model.ts";
import type { QuickDeps } from "./quick-routes.ts";
import { createLiveRuns, keepRun, keptRun, keptRuns, newRun, type RunIo, runStory, runSummary, type StoryRun } from "./runner.ts";
import { type CaseRef, type Plan, parseStory, planStory, type Send, setupLoader, type Story, type StoryError } from "./story.ts";
import { type PlannedStep, storiesPage, storyPage, storyRunHref, storyRunPage } from "./stories-view.ts";
import { noWhere, type Where } from "./view.ts";

export type StoriesDeps = Pick<QuickDeps, "history" | "now" | "secretsOf" | "varsFor" | "prepare" | "start"> & { wait?: (ms: number) => Promise<void> };

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const caseKeyOf = (r: CaseRef) => `${r.file}#${r.name}`;
type Found = { req: Req; file: string; n: number } | { error: string };

/** Everything a story's run reads, read once: the story, its plan in `env`, its cases, and one hash over all the files. */
export function loadStory(root: string, story: string, env: string) {
  const f = readStoryFile(root, "stories", story);
  if (!f) return { ok: false as const, error: `There's no .http/stories/${story}.` };
  const read = [`stories/${f.name}:${f.hash}`];
  const parsed = parseStory(f.text);
  const planned = parsed.errors.length ? undefined : planStory(parsed.story, env, setupLoader(root, (file, hash) => read.push(`setups/${file}:${hash}`)));
  const plan = planned?.ok ? planned.plan : undefined;
  const cases = new Map<string, Found>();
  const files = new Map<string, { text: string; hash: string } | { error: string }>();
  const sends: Send[] = plan ? [...plan.steps.flatMap((s) => (s.t === "send" ? [s] : [])), ...plan.always] : [];
  for (const s of sends) {
    if (s.ask.t !== "case" || cases.has(caseKeyOf(s.ask.ref))) continue;
    const { file, name } = s.ask.ref;
    if (!files.has(file)) {
      try {
        const got = readFile(root, file);
        files.set(file, got);
        read.push(`${file}:${got.hash}`);
      } catch (e) {
        files.set(file, { error: (e as Error).message });
        read.push(`${file}:missing`);
      }
    }
    const got = files.get(file)!;
    if ("error" in got) cases.set(caseKeyOf(s.ask.ref), { error: got.error });
    else {
      const reqs = parseHttp(got.text).reqs;
      const n = reqs.findIndex((r) => r.name === name);
      if (n < 0) cases.set(caseKeyOf(s.ask.ref), { error: `${file} has no request named ${name}` });
      else {
        const { span: _span, ...req } = reqs[n]!;
        cases.set(caseKeyOf(s.ask.ref), { req, file, n });
      }
    }
  }
  return {
    ok: true as const,
    name: f.name,
    story: parsed.story,
    errors: parsed.errors,
    plan,
    problem: planned && !planned.ok ? planned.error : undefined,
    cases,
    hash: hashOf(read.sort().join("\n")),
  };
}
type Loaded = Extract<ReturnType<typeof loadStory>, { ok: true }>;

/** The plan's steps as the story page lists them. */
function plannedSteps(plan: Plan, cases: Loaded["cases"]): PlannedStep[] {
  const send = (s: Send, lane: PlannedStep["lane"], from: string): PlannedStep => {
    const found = s.ask.t === "case" ? cases.get(caseKeyOf(s.ask.ref)) : undefined;
    const what = s.ask.t === "case" ? (found && "req" in found ? `${found.req.method} ${found.req.url}` : `case: ${s.ask.ref.file}#${s.ask.ref.name}${found && "error" in found ? ` (${found.error})` : ""}`) : `${s.ask.req.method} ${s.ask.req.url}`;
    const checks = [...(found && "req" in found ? (found.req.expect ?? []) : []), ...s.expect];
    return { lane, from, title: s.title, what, checks, takes: s.take.map((t) => t.name), ...(s.until ? { until: s.until.check } : {}) };
  };
  return [
    ...plan.steps.map((s, i) => {
      const from = plan.stepFrom[i] ?? "";
      return s.t === "check" ? { lane: from ? ("given" as const) : ("story" as const), from, title: "Check", what: s.text, checks: [], takes: [] } : send(s, from ? "given" : "story", from);
    }),
    ...plan.always.map((s, i) => send(s, "always", plan.alwaysFrom[i] ?? "")),
  ];
}

/** Where a send went, for the record: origin and path of the masked URL. */
function originPath(masked: string): string {
  try {
    const u = new URL(masked);
    return `${u.origin}${u.pathname}`;
  } catch {
    return masked.split(/[?#]/, 1)[0]!.slice(0, 300);
  }
}

export function createStories(d: StoriesDeps) {
  const live = createLiveRuns();
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** One run of a loaded story, in the background; it's kept and logged when done. */
  function start(ctx: PackContext, repo: string, env: string, got: Loaded & { plan: Plan }): StoryRun {
    const run = newRun({ id: crypto.randomUUID(), at: d.now(), repo, story: got.name, title: got.story.title, env }, got.plan);
    live.add(run);
    const publish = () => ctx.publish(["http", `http-story:${run.id}`]);
    const mask = masker(d.secretsOf(ctx));
    const io: RunIo = {
      caseOf: (ref) => got.cases.get(caseKeyOf(ref)) ?? { error: `${ref.file}#${ref.name} wasn't read` },
      async send(req, from, refs) {
        const w: Where = { ...noWhere(), env, repo, file: from.file, opened: from.file, n: from.file ? String(from.n) : "" };
        const p = d.prepare(ctx, req, w, refs);
        if (!p.ok) return { ok: false, error: `Not sent: ${p.error}` };
        const url = originPath(mask(p.url));
        const { s, settled } = d.start(ctx, req, w, p);
        await settled;
        if (s.state !== "done" || !s.resp) return { ok: false, error: `Nothing came back: ${s.error ?? "it failed"}.`, sentId: s.id, url };
        return { ok: true, sentId: s.id, resp: s.resp, url };
      },
      wait,
      now: d.now,
      publish,
    };
    void runStory(run, got.plan, io)
      .catch((e) => {
        run.state = "failed";
        ctx.log(`http: a story run stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      })
      .then(async () => {
        await keepRun(ctx.db, run);
        const bad = run.state !== "passed";
        await logAction(ctx.db, { kind: "http.run", target: `${repo}/.http/stories/${got.name}`.slice(0, 300), detail: `${runSummary(run)}${env ? ` · ${env}` : ""}`.slice(0, 200), ok: !bad, error: bad ? runSummary(run).slice(0, 200) : undefined });
      })
      .catch((e) => ctx.log(`http: couldn't keep a story run: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
      .finally(publish);
    return run;
  }

  /** A run by id: the live one, else the kept one. */
  async function runOf(ctx: PackContext, id: string): Promise<StoryRun | undefined> {
    return live.get(id) ?? (id.length <= 64 ? await keptRun(ctx.db, id) : undefined);
  }

  /** A repo's runs of one story, newest first: those still in memory (values and all), then the kept ones. */
  async function runsOf(ctx: PackContext, repo: string, story: string, limit = 10): Promise<StoryRun[]> {
    const mem = live.list().filter((r) => r.repo === repo && r.story === story);
    const kept = (await keptRuns(ctx.db, repo, story, limit)).filter((r) => !mem.some((m) => m.id === r.id));
    return [...mem, ...kept].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async function renderStory(ctx: PackContext, c: Context<AppEnv>, o: { repo: string; story: string; env: string; flash?: string; status?: number }) {
    const root = repoRoot(codeDirOf(ctx.env), o.repo);
    const w: Where = { ...noWhere(), env: o.env, repo: o.repo };
    let got: ReturnType<typeof loadStory> | { ok: false; error: string };
    try {
      got = root ? (STORY_RE.test(o.story) ? loadStory(root, o.story, o.env) : { ok: false, error: "A story is a lowercase name ending in .story." }) : { ok: false, error: "That repo isn't a checkout in your code folder." };
    } catch (e) {
      got = { ok: false, error: (e as Error).message };
    }
    const errors: StoryError[] = got.ok ? got.errors : [];
    const parsed: Story | undefined = got.ok ? got.story : undefined;
    const body = storyPage({
      repo: o.repo,
      story: o.story,
      title: parsed?.title ?? "",
      parsed,
      errors,
      env: o.env,
      envs: d.varsFor(ctx, w).envs,
      problem: got.ok ? got.problem : got.error,
      flash: o.flash,
      steps: got.ok && got.plan ? plannedSteps(got.plan, got.cases) : [],
      hash: got.ok ? got.hash : "",
      runs: o.repo && STORY_RE.test(o.story) ? await runsOf(ctx, o.repo, o.story) : [],
    });
    c.header("Cache-Control", "no-store");
    const res = await ctx.page(c, { title: parsed?.title || o.story || "Story", body, current: "/http", head: html`<meta name="u-topics" content="http">` });
    return o.status && o.status !== 200 ? new Response(res.body, { status: o.status, headers: res.headers }) : res;
  }

  function mount(app: Hono<AppEnv>, ctx: PackContext) {
    app.get("/http/stories", async (c) => {
      const repo = str(c.req.query("repo"), 100);
      const codeDir = codeDirOf(ctx.env);
      const root = repo ? repoRoot(codeDir, repo) : null;
      const kept = root ? await keptRuns(ctx.db, repo, undefined, 200) : [];
      const stories = root
        ? listStories(root, "stories").map((file) => {
            try {
              const t = readStoryFile(root, "stories", file);
              const p = t ? parseStory(t.text) : undefined;
              const last = live.list().find((r) => r.repo === repo && r.story === file) ?? kept.find((r) => r.story === file);
              return { file, title: p?.story.title ?? "", ...(p?.errors.length ? { error: `line ${p.errors[0]!.line}: ${p.errors[0]!.message}` } : {}), ...(last ? { last } : {}) };
            } catch (e) {
              return { file, title: "", error: (e as Error).message };
            }
          })
        : [];
      c.header("Cache-Control", "no-store");
      return ctx.page(c, { title: "Stories", current: "/http", head: html`<meta name="u-topics" content="http">`, body: storiesPage({ repos: listRepos(codeDir), repo, stories, ...(repo && !root ? { flash: "That repo isn't a checkout in your code folder." } : {}) }) });
    });

    // What a run will do: nothing is sent here.
    app.get("/http/story", (c) => renderStory(ctx, c, { repo: str(c.req.query("repo"), 100), story: str(c.req.query("story"), 80), env: str(c.req.query("env"), 64) }));

    app.post("/http/story/run", async (c) => {
      const f = await c.req.parseBody();
      const o = { repo: str(f.repo, 100), story: str(f.story, 80), env: str(f.env, 64) };
      const refuse = (flash: string, status = 400) => renderStory(ctx, c, { ...o, flash, status });
      const root = repoRoot(codeDirOf(ctx.env), o.repo);
      if (!root) return refuse("That repo isn't a checkout in your code folder: nothing was sent.");
      if (!STORY_RE.test(o.story)) return refuse("A story is a lowercase name ending in .story: nothing was sent.");
      let got: ReturnType<typeof loadStory>;
      try {
        got = loadStory(root, o.story, o.env);
      } catch (e) {
        return refuse(`${(e as Error).message} Nothing was sent.`);
      }
      if (!got.ok) return refuse(`${got.error} Nothing was sent.`);
      if (got.errors.length || !got.plan) return refuse(`${got.problem ?? "It has lines that can't be read."} Nothing was sent.`);
      if (got.hash !== str(f.hash, 64)) return refuse("The story or a file it reads changed since it was shown: nothing was sent. This is what's there now.", 409);
      const run = start(ctx, o.repo, o.env, { ...got, plan: got.plan });
      return c.redirect(storyRunHref(run.id), 303);
    });

    app.get("/http/story/run/:id", async (c) => {
      const run = await runOf(ctx, c.req.param("id"));
      if (!run) return c.redirect("/http/stories", 303);
      c.header("Cache-Control", "no-store");
      return ctx.page(c, { title: run.title || run.story, current: "/http", head: html`<meta name="u-topics" content="http http-story:${run.id}">`, body: storyRunPage(run, (id) => !!d.history.get(id)) });
    });
  }

  return { mount, live, runsOf };
}
