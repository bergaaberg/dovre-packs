/**
 * HTTP client (`http`): the stories' tools for agents, on Dovre's MCP server (dovre-packs#65 H-06).
 * Both are there only while HTTP_AGENT_HOSTS isn't "off", and both work in the turn's own checkout.
 *  - `catalog`: the repo's endpoints, cases, stories and setups, and who may run each story.
 *  - `run`: runs a story by name in an environment and says how it went, step by step.
 *
 * An agent runs a story without my click only when all of this holds:
 *  - every file the run reads (the story, its setups, the .http files of its cases, and
 *    .http/http-client.env.json) is committed: what's on disk is HEAD, so what it runs I can review;
 *  - a story that writes (any method but GET and HEAD) runs only in an environment the env file on
 *    origin's default branch marks `"$agent": "writes"` (repoAgentEnvs): an agent can't open that by
 *    committing it in its own checkout; anywhere else an agent's run reads only;
 *  - each send, once its URL is filled in, goes only to this machine or a host in HTTP_AGENT_HOSTS,
 *    with only the methods allowed above (checked again at the send, not just from the plan);
 *  - `only:` pins hold (planStory), at most MAX_AGENT_RUNS runs a turn, each MAX_STEPS steps at most;
 *  - it's logged as `http.agentRun`, its sends as `http.send` by an agent, and kept like any run.
 * What goes back is what a page shows: statuses, times, the masked URL and what each check got
 * (from masked responses). A secret's value never goes back.
 */
import type { PackContext, PackTool, ToolCall, ToolResult } from "dovre/pack.ts";
import { agentMayReach } from "./agent.ts";
import { READS, whoOf, whoRuns } from "./board.ts";
import { buildCatalog } from "./catalog.ts";
import { ENV_FILE, findSpec, listFiles, listStories, notCommitted, readStoryFile, repoAgentEnvs, rootOf, STORY_RE, uncommitted } from "./files.ts";
import { masker, type Secret } from "./model.ts";
import type { StepRun, StoryRun } from "./runner.ts";
import { type createStories, defaultEnv, loadStory, plannedSteps } from "./stories-routes.ts";
import { storyRunHref } from "./stories-view.ts";
import { parseStory, MAX_STEPS } from "./story.ts";
import { noWhere, type Where } from "./view.ts";

/** How many stories one agent turn may run. */
export const MAX_AGENT_RUNS = 10;
/** How long `run` waits for a run to finish before answering with where it got to. */
export const AGENT_WAIT = 300_000;
/** How long the catalog's answer may be. */
const MAX_CATALOG = 24_000;

export type AgentToolDeps = {
  stories: ReturnType<typeof createStories>;
  secretsOf(ctx: PackContext): Secret[];
  varsFor(ctx: PackContext, w: Where): { vars: Record<string, string>; envs: string[] };
};

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const fail = (text: string): ToolResult => ({ text, error: true });

/** A story's name as an agent may write it: `checkout`, `checkout.story` or `stories/checkout.story`. */
export const storyName = (v: unknown) => {
  const s = str(v, 100).trim().replace(/^(\.http\/)?stories\//, "");
  return s.endsWith(".story") ? s : `${s}.story`;
};

/** A step of a run, for the agent: its state, what it did, what came back, and its checks. */
function stepLines(st: StepRun, i: number): string[] {
  const head = [st.state, ...(st.from ? [`setup "${st.from}"`] : []), ...(st.lane === "always" ? ["always"] : []), st.title || st.what].join(" · ");
  const sent = st.kind === "send" ? ` — ${st.url ? `${st.method ?? ""} ${st.url}`.trim() : st.what}${st.status !== undefined ? ` → ${st.status}` : ""}${st.ms !== undefined ? ` · ${st.ms} ms` : ""}${st.tries && st.tries > 1 ? ` · ${st.tries} tries` : ""}` : "";
  return [
    `${i + 1}. ${head}${sent}`,
    ...st.checks.map((c) => `   ${c.ok ? "ok" : "FAILED"}: ${c.text}${!c.ok && c.got ? ` (got ${c.got})` : ""}`),
    ...(st.took.length ? [`   took ${st.took.join(", ")}`] : []),
    ...(st.error ? [`   ${st.error}`] : []),
  ];
}

/** How a run went, for the agent. */
export function runReport(r: StoryRun, finished: boolean): string {
  const where = `${r.story}${r.title ? ` ("${r.title}")` : ""} in ${r.env || "no environment"}`;
  const done = r.steps.filter((s) => s.state === "passed").length;
  const top = !finished || r.state === "running" ? `${where}: still running after ${AGENT_WAIT / 60_000} min, ${done} of ${r.steps.length} steps done. It goes on; the page shows the rest.` : r.state === "passed" ? `${where}: passed, all ${r.steps.length} steps${r.ms !== undefined ? ` in ${r.ms} ms` : ""}.` : `${where}: FAILED${r.steps.some((s) => s.state === "failed") ? ` at step ${r.steps.findIndex((s) => s.state === "failed") + 1}` : ""}.`;
  return [top, "", ...r.steps.flatMap(stepLines), "", `Responses are in the HTTP client's history; the run is at ${storyRunHref(r.id)} (kept without values).`].join("\n");
}

export function createAgentTools(d: AgentToolDeps) {
  // Runs started per turn (by its run id), newest turns last.
  const turns = new Map<string, number>();

  /** The turn's checkout, or why there isn't one. */
  const turnRoot = (ctx: PackContext, call: ToolCall) => rootOf(ctx, call.repo);

  async function catalog(ctx: PackContext, a: Record<string, unknown>, call: ToolCall): Promise<ToolResult> {
    const root = turnRoot(ctx, call);
    if (!root) return fail(`This turn's folder (${call.repo}) isn't a checkout directly in the code folder, so there's no catalog here.`);
    const envs = d.varsFor(ctx, { ...noWhere(), repo: call.repo }).envs;
    const env = typeof a.env === "string" && a.env ? str(a.env, 64) : defaultEnv(envs);
    if (env && !envs.includes(env)) return fail(`There's no environment ${env}. There are: ${envs.join(", ") || "none"}.`);
    const { envs: writes, branch } = await repoAgentEnvs(root);
    const git = await uncommitted(root, ["."]);
    const changed = git.ok ? git.changed : undefined;
    const files = listFiles(root);
    const cat = buildCatalog(findSpec(root)?.text, files.filter((f) => !f.error));
    const out: string[] = [
      `Repo ${call.repo}${cat.title ? ` (${cat.title})` : ""}. Environments: ${envs.join(", ") || "none"}; agents may write in: ${[...writes].filter((e) => envs.includes(e)).join(", ") || "none"} (the env file's "$agent": "writes" on ${branch ?? "origin's default branch, which this checkout doesn't have"}). Who may run a story is for ${env || "no environment"}.`,
      ...(git.ok ? [] : [`(${git.error}; agents can't run stories until it can.)`]),
      "",
      `Endpoints (${cat.endpoints.length}):`,
      ...cat.endpoints.map((e) => `  ${e.method} ${e.path}${e.summary ? ` — ${e.summary}` : ""} · ${e.cases.length ? `cases: ${e.cases.map((c) => `${c.file}#${c.name}`).join(", ")}` : "no cases"}${e.fromSpec ? "" : " (not in the spec)"}`),
      ...files.filter((f) => f.error).map((f) => `  (${f.name}: ${f.error})`),
      "",
    ];
    const stories = listStories(root, "stories");
    out.push(`Stories (${stories.length}), in .http/stories/:`);
    for (const file of stories) {
      try {
        const got = loadStory(root, file, env);
        if (!got.ok) out.push(`  ${file} — ${got.error}`);
        else if (got.errors.length) out.push(`  ${file} — can't be read: line ${got.errors[0]!.line}: ${got.errors[0]!.message}`);
        else if (!got.plan) out.push(`  ${file}${got.story.title ? ` "${got.story.title}"` : ""} — can't run in ${env || "no environment"}: ${got.problem ?? "it can't be planned"}`);
        else {
          const { methods } = plannedSteps(got.plan, got.cases);
          const open = changed ? notCommitted(changed, [...got.paths, ENV_FILE]) : got.paths;
          const who = whoOf(methods, writes.has(env), changed !== undefined && !open.length);
          const says = who === "agent" ? "you can run it" : who === "commit" ? `you can run it once these are committed: ${open.join(", ")}` : `it writes (${[...new Set(methods.filter((m) => !READS.includes(m)))].join(", ")}) and ${env || "no environment"} isn't open to agents' writes: only I run it`;
          out.push(`  ${file}${got.story.title ? ` "${got.story.title}"` : ""}${got.plan.setups.length ? ` · given ${got.plan.setups.join(", ")}` : ""} · ${got.plan.steps.length + got.plan.always.length} steps (${methods.join(" ")}) · ${says}`);
        }
      } catch (e) {
        out.push(`  ${file} — ${(e as Error).message}`);
      }
    }
    const setups = listStories(root, "setups");
    out.push("", `Setups (${setups.length}), in .http/setups/ (a story names one with given:):`);
    for (const file of setups) {
      try {
        const f = readStoryFile(root, "setups", file);
        const p = f ? parseStory(f.text) : undefined;
        out.push(`  ${file}${p?.story.title ? ` "${p.story.title}"` : ""}${p?.story.only.length ? ` · only ${p.story.only.join(", ")}` : ""}${p?.errors.length ? ` · can't be read: line ${p.errors[0]!.line}: ${p.errors[0]!.message}` : ""}`);
      } catch (e) {
        out.push(`  ${file} — ${(e as Error).message}`);
      }
    }
    const text = out.join("\n");
    return { text: text.length > MAX_CATALOG ? `${text.slice(0, MAX_CATALOG)}\n…(cut)` : text };
  }

  async function run(ctx: PackContext, a: Record<string, unknown>, call: ToolCall, listed: string[]): Promise<ToolResult> {
    const root = turnRoot(ctx, call);
    if (!root) return fail(`This turn's folder (${call.repo}) isn't a checkout directly in the code folder. Nothing was sent.`);
    const story = storyName(a.story);
    if (!STORY_RE.test(story)) return fail("A story is named by its file in .http/stories/ (checkout or checkout.story). Nothing was sent.");
    const envs = d.varsFor(ctx, { ...noWhere(), repo: call.repo }).envs;
    const env = typeof a.env === "string" && a.env ? str(a.env, 64) : defaultEnv(envs);
    if (env && !envs.includes(env)) return fail(`There's no environment ${env}. There are: ${envs.join(", ") || "none"}. Nothing was sent.`);
    const count = turns.get(call.run) ?? 0;
    if (count >= MAX_AGENT_RUNS) return fail(`This turn has run ${MAX_AGENT_RUNS} stories already, the most it may. Nothing was sent.`);
    let got: ReturnType<typeof loadStory>;
    try {
      got = loadStory(root, story, env);
    } catch (e) {
      return fail(`${(e as Error).message} Nothing was sent.`);
    }
    if (!got.ok) return fail(`${got.error} Nothing was sent.`);
    if (got.errors.length) return fail(`.http/stories/${story} can't be read: ${got.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join("; ")}. Nothing was sent.`);
    if (!got.plan) return fail(`${got.problem ?? "It can't be planned."}. Nothing was sent.`);
    const git = await uncommitted(root, [...got.paths, ENV_FILE]);
    if (!git.ok) return fail(`${git.error}. Nothing was sent.`);
    const open = notCommitted(git.changed, [...got.paths, ENV_FILE]);
    if (open.length) return fail(`An agent runs only what's committed, and these aren't: ${open.map((p) => `.http/${p}`).join(", ")}. Commit them (on your branch is fine) and run it again. Nothing was sent.`);
    const { envs: agentEnvs, branch } = await repoAgentEnvs(root);
    const writes = agentEnvs.has(env);
    const { methods } = plannedSteps(got.plan, got.cases);
    if (whoRuns(methods, writes) !== "agent") {
      const w = [...new Set(methods.filter((m) => !READS.includes(m)))];
      return fail(`It ${w.includes("?") ? "has a step whose method can't be told" : `sends ${w.join(", ")}`}, and ${env || "no environment"} isn't open to agents' writes ("$agent": "writes" in .http/${ENV_FILE} on ${branch ?? "origin's default branch"}; committing it here doesn't count). Only I run it, from its page. Nothing was sent.`);
    }
    turns.delete(call.run);
    turns.set(call.run, count + 1);
    for (const k of turns.keys()) if (turns.size > 200) turns.delete(k);
    const mask = masker(d.secretsOf(ctx));
    const guard = (method: string, url: string) => {
      if (!writes && !READS.includes(method)) return `only ${READS.join(" and ")} in ${env || "no environment"} for an agent`;
      if (!agentMayReach(url, listed)) {
        let host = url;
        try {
          host = new URL(url).host;
        } catch {}
        return `an agent may only send to this machine (localhost) or the hosts in HTTP_AGENT_HOSTS, and ${mask(host)} isn't one`;
      }
      return undefined;
    };
    const { run: r, done } = d.stories.start(ctx, call.repo, env, { ...got, plan: got.plan }, { guard });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([done.then(() => true), new Promise<boolean>((res) => (timer = setTimeout(() => res(false), AGENT_WAIT)))]);
    clearTimeout(timer);
    return { text: runReport(r, finished), error: finished && r.state !== "passed" };
  }

  /** The tools, given the hosts an agent may reach besides this machine (core offers them as http_catalog and http_run). */
  function tools(listed: string[]): PackTool[] {
    const where = ["this machine (localhost)", ...listed].join(", ");
    return [
      {
        name: "catalog",
        description: "The HTTP stories of this turn's repo: its endpoints (from the OpenAPI spec and the requests saved in .http/), the saved cases of each, its stories and setups, and whether you may run each story with http_run. Sends nothing.",
        input: { type: "object", properties: { env: { type: "string", description: "The environment to say who may run each story in (default: one named local or dev)." } }, additionalProperties: false },
        run: (args, c, call) => catalog(c, args, call),
      },
      {
        name: "run",
        description: `Run one of this repo's HTTP stories (.http/stories/<name>.story) with its setups, and get back how each step went: status, time, checks and what they got. You may run a story only when every file it reads is committed; a story that writes (POST, PUT, PATCH, DELETE) runs only in an environment marked "$agent": "writes" in .http/${ENV_FILE} on origin's default branch (merged, not just committed), and each request goes only to ${where}. At most ${MAX_AGENT_RUNS} runs a turn, ${MAX_STEPS} steps each. Secrets never come back (shown as ••••). http_catalog says which stories you may run.`,
        input: {
          type: "object",
          properties: {
            story: { type: "string", description: "The story's file name in .http/stories/ (checkout or checkout.story)." },
            env: { type: "string", description: "The environment to run it in (default: one named local or dev)." },
          },
          required: ["story"],
          additionalProperties: false,
        },
        run: (args, c, call) => run(c, args, call, listed),
      },
    ];
  }

  return { catalog, run, tools };
}
