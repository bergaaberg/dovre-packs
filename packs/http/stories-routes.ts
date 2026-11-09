/**
 * HTTP client (`http`): the stories' routes (dovre-packs#65 H-04). All of /http is behind
 * strictOrigin (index.ts). Nothing is sent on a GET. A run is one click on the page that showed it
 * (sending is the point), each request logged as `http.send` as any send is and the run as
 * `http.run`. The run re-checks every file it reads (the story, its setups, the .http files its
 * cases are in) against the hash they were shown with; a file that changed since is shown again.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { AppEnv, PackContext } from "dovre/pack.ts";
import { agentHref, MAX_ASK, storyAskPrompt } from "./agent.ts";
import { noticedIn, pipsOf, uncovered, usesOf, whoOf } from "./board.ts";
import { buildCatalog, endpointFor, endpointKey } from "./catalog.ts";
import { ENV_FILE, findSpec, hashOf, listFiles, listStories, notCommitted, readFile, readStoryFile, repoAgentEnvs, reposOf, rootOf, STORY_RE, uncommitted } from "./files.ts";
import { masker, parseHttp, type Req } from "./model.ts";
import type { QuickDeps } from "./quick-routes.ts";
import { createLiveRuns, keepRun, keptRun, keptRuns, type Lane, newRun, type RunIo, runStory, runSummary, type StoryRun } from "./runner.ts";
import { type CaseRef, type Plan, parseStory, planStory, type Send, setupFile, setupLoader, type Story, type StoryError } from "./story.ts";
import { type RailStep, type SetupRow, type Show, splitWhat, storiesHref, storiesPage, type StoryRow, storyPage, storyRunHref, storyRunPage } from "./stories-view.ts";
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
  // The paths it read, under .http/ (an agent's run checks they're committed).
  const paths = [`stories/${f.name}`];
  const parsed = parseStory(f.text);
  const planned = parsed.errors.length ? undefined : planStory(parsed.story, env, setupLoader(root, (file, hash) => {
    read.push(`setups/${file}:${hash}`);
    paths.push(`setups/${file}`);
  }));
  const plan = planned?.ok ? planned.plan : undefined;
  const cases = new Map<string, Found>();
  const files = new Map<string, { text: string; hash: string } | { error: string }>();
  const sends: Send[] = plan ? [...plan.steps.flatMap((s) => (s.t === "send" ? [s] : [])), ...plan.always] : [];
  for (const s of sends) {
    if (s.ask.t !== "case" || cases.has(caseKeyOf(s.ask.ref))) continue;
    const { file, name } = s.ask.ref;
    if (!files.has(file)) {
      paths.push(file);
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
    paths,
  };
}
export type Loaded = Extract<ReturnType<typeof loadStory>, { ok: true }>;

const secs = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

/** The plan's steps as the story page's rail draws them, and the methods its sends use ("?" for a case that can't be read). */
export function plannedSteps(plan: Plan, cases: Loaded["cases"]): { steps: RailStep[]; methods: string[] } {
  const taken: string[] = [];
  const methods: string[] = [];
  const send = (s: Send, lane: Lane, from: string): RailStep => {
    const found = s.ask.t === "case" ? cases.get(caseKeyOf(s.ask.ref)) : undefined;
    const req = s.ask.t === "req" ? s.ask.req : found && "req" in found ? found.req : undefined;
    methods.push(req?.method ?? "?");
    const how = [
      ...(from ? [`setup "${from}"`] : []),
      ...(s.ask.t === "case" ? [`case "${s.ask.ref.name}"${found && "error" in found ? ` (${found.error})` : ""}`] : []),
      ...(s.until ? [`until ${s.until.check}, every ${secs(s.until.everyMs)}, up to ${secs(s.until.maxMs)}`] : []),
    ];
    const text = req ? [req.url, ...req.headers.map(([k, v]) => `${k}: ${v}`), req.body].join("\n") : "";
    const takes = s.take.map((t) => t.name);
    taken.push(...takes);
    return {
      lane,
      from,
      title: s.title,
      kind: "send",
      ...(req ? { method: req.method } : {}),
      path: req ? splitWhat(`${req.method} ${req.url}`).path : "",
      how,
      uses: usesOf(text),
      takes,
      checks: [...(req && s.ask.t === "case" ? (req.expect ?? []) : []), ...s.expect].map((text) => ({ text })),
    };
  };
  const steps: RailStep[] = [
    ...plan.steps.map((s, i): RailStep => {
      const from = plan.stepFrom[i] ?? "";
      const lane: Lane = from ? "given" : "story";
      if (s.t === "send") return send(s, lane, from);
      const words = new Set(s.text.split(/[\s()]+/));
      return { lane, from, title: s.text, kind: "check", path: s.text, how: from ? [`setup "${from}"`] : [], uses: taken.filter((n, j) => words.has(n) && taken.indexOf(n) === j), takes: [], checks: [] };
    }),
    ...plan.always.map((s, i) => send(s, "always", plan.alwaysFrom[i] ?? "")),
  ];
  return { steps, methods };
}

/** Every request a story (and its setups) writes out itself, as method and URL: what "touches" an endpoint without a case. */
function ownRequests(story: Story): { method: string; url: string }[] {
  return [...story.steps.flatMap((s) => (s.t === "send" ? [s] : [])), ...story.always].flatMap((s) => (s.ask.t === "req" ? [{ method: s.ask.req.method, url: s.ask.req.url }] : []));
}

/** An environment to show first when none is asked for: one named local or dev, else the first. */
export const defaultEnv = (envs: string[]) => envs.find((e) => /^(local|dev)/i.test(e)) ?? envs[0] ?? "";
const SHOWS: Show[] = ["all", "failing", "agent"];

/** What a setup does, in a line: its first steps. */
function setupDoes(s: Story): string {
  const what = s.steps.map((st) => (st.t === "check" ? `check ${st.text}` : st.ask.t === "case" ? `case "${st.ask.ref.name}"` : `${st.ask.req.method} ${splitWhat(`${st.ask.req.method} ${st.ask.req.url}`).path}`));
  const takes = s.steps.flatMap((st) => (st.t === "send" ? st.take.map((t) => t.name) : []));
  const parts = [what.slice(0, 2).join(", ") + (what.length > 2 ? ` and ${what.length - 2} more` : ""), takes.length ? `takes ${takes.join(", ")}` : "", s.always.length ? "cleans up after" : ""];
  return parts.filter(Boolean).join("; ") || "no steps";
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

  /**
   * One run of a loaded story, in the background; it's kept and logged when done (`done`).
   * `agent`: an agent's run. Each send is held to `guard` once its URL is filled in (a refusal is
   * "Not sent"), shows in history as by an agent, and the run is logged as `http.agentRun`.
   */
  function start(ctx: PackContext, repo: string, env: string, got: Loaded & { plan: Plan }, agent?: { guard(method: string, url: string): string | undefined }): { run: StoryRun; done: Promise<void> } {
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
        const refused = agent?.guard(req.method, p.url);
        if (refused) return { ok: false, error: `Not sent: ${refused}`, url };
        const { s, settled } = d.start(ctx, req, w, p, agent ? "agent" : undefined);
        await settled;
        if (s.state !== "done" || !s.resp) return { ok: false, error: `Nothing came back: ${s.error ?? "it failed"}.`, sentId: s.id, url };
        return { ok: true, sentId: s.id, resp: s.resp, url };
      },
      wait,
      now: d.now,
      publish,
    };
    const done = runStory(run, got.plan, io)
      .catch((e) => {
        run.state = "failed";
        ctx.log(`http: a story run stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      })
      .then(async () => {
        await keepRun(ctx.db, run);
        const bad = run.state !== "passed";
        await ctx.logged({ kind: agent ? "agentRun" : "run", target: `${repo}/.http/stories/${got.name}`.slice(0, 300), detail: `${runSummary(run)}${env ? ` · ${env}` : ""}`.slice(0, 200), ok: !bad, error: bad ? runSummary(run).slice(0, 200) : undefined });
      })
      .catch((e) => ctx.log(`http: couldn't keep a story run: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
      .finally(publish);
    return { run, done };
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

  /** A repo's runs, newest first: the live ones (values and all), then the kept ones. */
  async function repoRuns(ctx: PackContext, repo: string): Promise<StoryRun[]> {
    const mem = live.list().filter((r) => r.repo === repo);
    const kept = (await keptRuns(ctx.db, repo, undefined, 300)).filter((r) => !mem.some((m) => m.id === r.id));
    return [...mem, ...kept].sort((a, b) => b.at - a.at);
  }

  /** Everything the overview shows for a checkout, in one environment. */
  async function board(ctx: PackContext, repo: string, root: string, asked: string | undefined) {
    const envs = d.varsFor(ctx, { ...noWhere(), repo }).envs;
    const env = asked === undefined ? defaultEnv(envs) : asked.slice(0, 64);
    const agentEnvs = (await repoAgentEnvs(root)).envs;
    const git = await uncommitted(root, ["."]);
    // Committed as an agent's run checks it (git that can't tell counts as not committed).
    const committed = (paths: string[]) => git.ok && !notCommitted(git.changed, [...paths, ENV_FILE]).length;
    const runs = await repoRuns(ctx, repo);
    const files = listFiles(root);
    const catalog = buildCatalog(findSpec(root)?.text, files.filter((f) => !f.error));
    const touched = new Set<string>();
    const touch = (st: Story) => {
      for (const r of ownRequests(st)) {
        const ep = endpointFor(catalog.endpoints, r.method, r.url);
        if (ep) touched.add(endpointKey(ep));
      }
    };
    // Who uses each setup: the stories whose plan has it (or that name it, when they can't be planned here).
    const users = new Map<string, number>();
    const pipEnvs = [env, ...new Set(runs.map((r) => r.env))].filter((e, i, all) => all.indexOf(e) === i).slice(0, 3);
    const stories: StoryRow[] = listStories(root, "stories").map((file) => {
      const mine = runs.filter((r) => r.story === file);
      const base = { file, pips: pipEnvs.map((e) => pipsOf(mine, file, e)), ...(mine[0] ? { last: mine[0] } : {}) };
      try {
        const got = loadStory(root, file, env);
        if (!got.ok) return { ...base, title: "", given: [], error: got.error };
        touch(got.story);
        for (const g of got.plan?.setups ?? got.story.given) users.set(`${setupFile(g)}.story`, (users.get(`${setupFile(g)}.story`) ?? 0) + 1);
        const row = { ...base, title: got.story.title, given: got.story.given };
        if (got.errors.length) return { ...row, error: `line ${got.errors[0]!.line}: ${got.errors[0]!.message}` };
        if (!got.plan) return { ...row, problem: got.problem ?? "It can't run here." };
        return { ...row, who: whoOf(plannedSteps(got.plan, got.cases).methods, agentEnvs.has(env), committed(got.paths)), hash: got.hash };
      } catch (e) {
        return { ...base, title: "", given: [], error: (e as Error).message };
      }
    });
    const setups: SetupRow[] = listStories(root, "setups").map((file) => {
      try {
        const f = readStoryFile(root, "setups", file);
        const p = f ? parseStory(f.text) : undefined;
        if (!p) return { file, title: "", used: users.get(file) ?? 0, does: "", only: [], error: "it's gone" };
        touch(p.story);
        return { file, title: p.story.title, used: users.get(file) ?? 0, does: setupDoes(p.story), only: p.story.only, ...(p.errors.length ? { error: `line ${p.errors[0]!.line}: ${p.errors[0]!.message}` } : {}) };
      } catch (e) {
        return { file, title: "", used: 0, does: "", only: [], error: (e as Error).message };
      }
    });
    return {
      repo,
      env,
      envs,
      counts: { setups: setups.length, cases: files.reduce((n, f) => n + f.reqs.length, 0) },
      stories,
      pipEnvs,
      gaps: uncovered(catalog, touched),
      noticed: noticedIn(runs),
      setups,
      recent: runs.slice(0, 6),
    };
  }

  /** Who may run a story now, as an agent's run checks it. */
  async function whoNow(root: string, methods: string[], env: string, paths: string[]) {
    const git = await uncommitted(root, [...paths, ENV_FILE]);
    return whoOf(methods, (await repoAgentEnvs(root)).envs.has(env), git.ok && !notCommitted(git.changed, [...paths, ENV_FILE]).length);
  }

  async function renderStory(ctx: PackContext, c: Context<AppEnv>, o: { repo: string; story: string; env: string; flash?: string; status?: number }) {
    const root = rootOf(ctx, o.repo);
    const w: Where = { ...noWhere(), env: o.env, repo: o.repo };
    let got: ReturnType<typeof loadStory> | { ok: false; error: string };
    try {
      got = root ? (STORY_RE.test(o.story) ? loadStory(root, o.story, o.env) : { ok: false, error: "A story is a lowercase name ending in .story." }) : { ok: false, error: "That repo isn't a checkout in your code folder." };
    } catch (e) {
      got = { ok: false, error: (e as Error).message };
    }
    const errors: StoryError[] = got.ok ? got.errors : [];
    const parsed: Story | undefined = got.ok ? got.story : undefined;
    const planned = got.ok && got.plan ? plannedSteps(got.plan, got.cases) : undefined;
    const body = storyPage({
      repo: o.repo,
      story: o.story,
      title: parsed?.title ?? "",
      about: parsed?.about ?? [],
      given: parsed?.given ?? [],
      errors,
      env: o.env,
      envs: d.varsFor(ctx, w).envs,
      problem: got.ok ? got.problem : got.error,
      flash: o.flash,
      steps: planned?.steps ?? [],
      hash: got.ok ? got.hash : "",
      ...(planned && root && got.ok ? { who: await whoNow(root, planned.methods, o.env, got.paths) } : {}),
      runs: o.repo && STORY_RE.test(o.story) ? await runsOf(ctx, o.repo, o.story) : [],
      now: d.now(),
    });
    c.header("Cache-Control", "no-store");
    const res = await ctx.page(c, { title: parsed?.title || o.story || "Story", body, current: "/http", head: html`<meta name="u-topics" content="http">` });
    return o.status && o.status !== 200 ? new Response(res.body, { status: o.status, headers: res.headers }) : res;
  }

  function mount(app: Hono<AppEnv>, ctx: PackContext) {
    app.get("/http/stories", async (c) => {
      const repo = str(c.req.query("repo"), 100);
      const show = SHOWS.find((v) => v === c.req.query("show")) ?? "all";
      const root = repo ? rootOf(ctx, repo) : null;
      const page = (body: Parameters<typeof storiesPage>[0]) => {
        c.header("Cache-Control", "no-store");
        return ctx.page(c, { title: "Stories", current: "/http", head: html`<meta name="u-topics" content="http">`, body: storiesPage(body) });
      };
      const empty = { repos: reposOf(ctx), repo, env: "", envs: [], show, counts: { setups: 0, cases: 0 }, stories: [], pipEnvs: [], gaps: [], noticed: [], setups: [], recent: [], now: d.now() };
      if (!root) return page({ ...empty, ...(repo ? { repo: "", flash: "That repo isn't a checkout in your code folder." } : {}) });
      return page({ ...empty, show, ...(await board(ctx, repo, root, c.req.query("env"))) });
    });

    // A question typed on the overview: an agent session with the prompt drafted. Nothing starts until I press Start there.
    app.get("/http/stories/ask", (c) => {
      const repo = str(c.req.query("repo"), 100);
      const ask = str(c.req.query("ask"), MAX_ASK).trim();
      const known = repo && rootOf(ctx, repo) ? repo : "";
      if (!ask) return c.redirect(storiesHref({ repo: known }), 303);
      return c.redirect(agentHref(known, storyAskPrompt(ask)), 303);
    });

    // What a run will do: nothing is sent here.
    app.get("/http/story", (c) => renderStory(ctx, c, { repo: str(c.req.query("repo"), 100), story: str(c.req.query("story"), 80), env: str(c.req.query("env"), 64) }));

    app.post("/http/story/run", async (c) => {
      const f = await c.req.parseBody();
      const o = { repo: str(f.repo, 100), story: str(f.story, 80), env: str(f.env, 64) };
      const refuse = (flash: string, status = 400) => renderStory(ctx, c, { ...o, flash, status });
      const root = rootOf(ctx, o.repo);
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
      const { run } = start(ctx, o.repo, o.env, { ...got, plan: got.plan });
      return c.redirect(storyRunHref(run.id), 303);
    });

    app.get("/http/story/run/:id", async (c) => {
      const run = await runOf(ctx, c.req.param("id"));
      if (!run) return c.redirect("/http/stories", 303);
      c.header("Cache-Control", "no-store");
      const runs = await runsOf(ctx, run.repo, run.story);
      return ctx.page(c, { title: run.title || run.story, current: "/http", head: html`<meta name="u-topics" content="http http-story:${run.id}">`, body: storyRunPage(run, { hasSent: (id) => !!d.history.get(id), runs, now: d.now() }) });
    });
  }

  return { mount, live, runsOf, start, board };
}
