/**
 * HTTP client (`http`): the stories' pages (dovre-packs#65 H-05, from canvases E and F). The
 * overview lists a repo's stories with who can run them and their last runs, and around it what's
 * worth doing next: an ask for an agent, endpoints nothing covers, what the kept runs show, setups,
 * recent runs. The story page draws its steps as a rail (Given, Story, Always) with what each uses,
 * takes and checks, and sends nothing; the run page is the same rail, filled in over the hub.
 *
 * One button per card for its main action; the rest are text links. Everything a story file, a
 * spec or a response brings is hostile: it's only interpolated into html`…`, and links go through
 * safeUrl (agentHref does too).
 */
import { html } from "hono/html";
import { type Child, Dot, Empty, Notice, PageHeader, Panel, safeUrl, Tabs, type Tone } from "dovre/pack.ts";
import { agentHref, coverPrompt, MAX_ASK, noticedPrompt, storyAskPrompt, storyDebugPrompt } from "./agent.ts";
import { failedAt, type Noticed, type Pip, usesOf, type Who } from "./board.ts";
import type { Endpoint } from "./catalog.ts";
import type { Lane, StepState, StoryRun } from "./runner.ts";
import { runSummary } from "./runner.ts";
import type { StoryError } from "./story.ts";
import { quickHref } from "./quick-view.ts";
import { sentHref } from "./view.ts";

type Html = ReturnType<typeof html>;
const qs = (q: Record<string, string | undefined>) => new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();

export type Show = "all" | "failing" | "agent";
export const storiesHref = (q: { repo?: string; env?: string; show?: Show } = {}) => {
  const p = qs({ ...q, show: q.show === "all" ? undefined : q.show });
  return safeUrl(`/http/stories${p ? `?${p}` : ""}`);
};
export const storyHref = (q: { repo: string; story: string; env?: string }) => safeUrl(`/http/story?${qs(q)}`);
export const storyRunHref = (id: string) => safeUrl(`/http/story/run/${encodeURIComponent(id)}`);

const crumbs = (repo?: string) => [{ href: "/http", label: "HTTP" }, ...(repo ? [{ href: storiesHref({ repo }), label: "Stories" }] : [])];
const options = (all: string[], at: string) => all.map((e) => html`<option value="${e}"${e === at ? html` selected` : ""}>${e}</option>`);
const hidden = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);
const LANES: Record<Lane, string> = { given: "Given", story: "Story", always: "Always, last" };
const runTone = (s: StoryRun["state"]): Tone => (s === "passed" ? "ok" : s === "failed" ? "bad" : "neutral");

/** When, in words that don't need my time zone: `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function ago(at: number, now: number): string {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const whoChip = (who: Who) =>
  who === "agent"
    ? html`<span class="http-who agent" title="Its sends only read, or the environment lets an agent write">agent can run</span>`
    : who === "commit"
      ? html`<span class="http-who" title="An agent runs only committed files: the story, its setups, its cases' files and the env file">agent can run once committed</span>`
      : html`<span class="http-who you" title="It writes: it runs when you click Run">needs your click</span>`;

const PIP: Record<Pip, string> = { passed: "http-pip-ok", failed: "http-pip-bad", running: "http-pip-run", none: "" };

function pips(env: string, list: Pip[]): Html {
  const ok = list.filter((p) => p === "passed").length;
  const bad = list.filter((p) => p === "failed").length;
  const label = ok + bad ? `${env || "no environment"}, last ${list.length}: ${ok} passed, ${bad} failed` : `${env || "no environment"}: not run`;
  return html`<span class="http-pips" role="img" aria-label="${label}" title="${label}">${list.map((p) => html`<span class="http-pip ${PIP[p]}"></span>`)}</span>`;
}

// ── The step rail ──────────────────────────────────────────────────────────────────────────────

/** A step as the rail draws it, planned or run. */
export type RailStep = {
  lane: Lane;
  /** The setup it comes from ("" for the story's own). */
  from: string;
  title: string;
  kind: "send" | "check";
  method?: string;
  /** The URL as written (`{{baseUrl}}` dropped), a check's text, or empty (a case not sent yet). */
  path: string;
  how: string[];
  uses: string[];
  takes: string[];
  checks: { text: string; ok?: boolean; got?: string }[];
  state?: StepState;
  result?: string;
  error?: string;
  /** Its response, while history has it. */
  href?: string;
};

/** `POST {{baseUrl}}/orders` → method and path; `{{baseUrl}}` left out, as every story URL starts with it. */
export function splitWhat(what: string): { method?: string; path: string } {
  const m = /^([A-Z]+) (.*)$/.exec(what);
  return m ? { method: m[1], path: m[2]!.replace(/^\{\{\s*baseUrl\s*\}\}/, "") } : { path: what };
}

const checkCls = (ok: boolean | undefined) => (ok === true ? "http-chip-ok" : ok === false ? "http-chip-bad" : "");
const MARK: Record<StepState, string> = { waiting: "", sending: "http-st-now", passed: "http-st-ok", failed: "http-st-bad", skipped: "http-st-skip" };

function rail(steps: RailStep[]): Html {
  const lanes: { lane: Lane; start: number; list: RailStep[] }[] = [];
  steps.forEach((s, i) => {
    const at = lanes[lanes.length - 1];
    if (at && at.lane === s.lane) at.list.push(s);
    else lanes.push({ lane: s.lane, start: i + 1, list: [s] });
  });
  if (!steps.length) return Empty({ title: "No steps to show." });
  return html`<div class="http-rail-wrap">${lanes.map(
    (l) => html`<h3 class="http-lane">${LANES[l.lane]}</h3><ol class="http-rail" start="${l.start}">${l.list.map((s, j) => {
      const n = l.start + j;
      const cls = s.state ? MARK[s.state] : "";
      const stepCls = !s.state || s.state === "waiting" ? "http-st-wait" : cls;
      const mark = s.state === "passed" ? "✓" : s.state === "failed" ? "✗" : s.state === "skipped" ? "–" : String(n);
      const title = s.href ? html`<a href="${s.href}">${s.title || s.path}</a>` : s.title || s.path;
      return html`<li class="http-step ${stepCls}"><span class="http-track"><span class="http-mark ${cls}" aria-hidden="true">${mark}</span></span>
<div class="http-step-card"><div class="http-step-head"><span class="http-step-title">${title}</span>${s.state === "sending" ? html`<span class="t3" data-pending><span class="spinner"></span> sending…</span>` : s.result ? html`<span class="t3">${s.result}</span>` : ""}</div>
${s.kind === "check" ? "" : html`<div class="http-step-what">${s.method ? html`<span class="http-m">${s.method}</span> ` : ""}${s.path}${s.how.length ? html`<span class="t3"> · ${s.how.join(" · ")}</span>` : ""}</div>`}
${s.uses.length || s.takes.length || s.checks.length ? html`<div class="http-chips">${s.uses.map((u) => html`<span class="http-chip http-chip-in">uses ${u}</span>`)}${s.takes.map((t) => html`<span class="http-chip http-chip-out">takes ${t}</span>`)}${s.checks.map((c) => html`<span class="http-chip ${checkCls(c.ok)}">${c.ok === false ? "✗ " : ""}${c.text}${c.got !== undefined && c.ok === false ? html` <span class="t3">got ${c.got}</span>` : ""}</span>`)}</div>` : ""}
${s.error ? html`<p class="notes">${s.error}</p>` : ""}</div></li>`;
    })}</ol>`,
  )}</div>`;
}

/** A run's steps on the rail: what's kept (or live) of each. */
export function railOfRun(r: StoryRun, hasSent: (id: string) => boolean): RailStep[] {
  return r.steps.map((s) => {
    const caseRef = /^case: ([^#]*)#(.*)$/.exec(s.what);
    let path = caseRef ? "" : splitWhat(s.what).path;
    if (caseRef && s.url) {
      try {
        path = new URL(s.url).pathname;
      } catch {
        path = s.url;
      }
    }
    const result =
      s.kind === "check" || s.state === "skipped" || s.state === "waiting"
        ? s.state === "skipped"
          ? "skipped"
          : ""
        : s.status !== undefined
          ? `${s.status} · ${s.ms} ms${s.tries && s.tries > 1 ? ` · ${s.tries} tries` : ""}`
          : "";
    return {
      lane: s.lane,
      from: s.from,
      title: s.title,
      kind: s.kind,
      ...(s.kind === "send" ? { method: s.method ?? splitWhat(s.what).method } : {}),
      path: s.kind === "check" ? s.what : path,
      how: [...(s.from ? [`setup "${s.from}"`] : []), ...(caseRef ? [`case "${caseRef[2]}"`] : [])],
      uses: usesOf(s.what),
      takes: s.took,
      checks: s.checks,
      state: s.state,
      result,
      ...(s.error && !(s.checks.some((c) => !c.ok) && /checks failed\.$/.test(s.error)) ? { error: s.error } : {}),
      ...(s.sentId && hasSent(s.sentId) ? { href: sentHref(s.sentId) } : {}),
    };
  });
}

function runsAside(o: { runs: StoryRun[]; repo: string; now: number; current?: string }): Html {
  const newest = o.runs.find((r) => r.state !== "running");
  return Panel({
    title: "Earlier runs",
    children: o.runs.length
      ? html`<ul class="http-runs">${o.runs.map(
          (r) =>
            html`<li>${Dot({ tone: runTone(r.state), label: r.state })}${r.id === o.current ? html`<span class="http-grow">${r.env || "no environment"} · ${runSummary(r)} <span class="t3">(this one)</span></span>` : html`<a class="http-grow" href="${storyRunHref(r.id)}">${r.env || "no environment"} · ${runSummary(r)}</a>`}<span class="t3">${r.ms !== undefined ? `${secs(r.ms)} · ` : ""}${ago(r.at, o.now)}</span></li>`,
        )}</ul>${newest?.state === "failed" ? html`<p class="hint"><a href="${agentHref(o.repo, storyDebugPrompt(newest))}" title="Start an agent session with what the run kept (steps, statuses, checks; no values): you read the prompt first">Debug the failed run with an agent</a></p>` : ""}`
      : Empty({ title: "Not run yet." }),
  });
}

const valCls = (v: string | undefined) => (v === undefined ? "t3" : "");

function valuesAside(rows: { name: string; value?: string; from: string }[], live: boolean): Html {
  return Panel({
    title: live ? "Values in this run" : "Values it takes",
    children: rows.length
      ? html`<ul class="http-vals">${rows.map((v) => html`<li><span class="http-val-name">${v.name}</span><span class="http-val ${valCls(v.value)}">${v.value ?? "—"}</span><span class="t3">${v.from}</span></li>`)}</ul><p class="hint">What one step takes, a later step uses as <code>\${name}</code>. Secrets stay ••••.${live ? " Values stay in memory: a kept run has none." : ""}</p>`
      : Empty({ title: "It takes no values." }),
  });
}

// ── The story page ─────────────────────────────────────────────────────────────────────────────

export type StoryOpts = {
  repo: string;
  story: string;
  title: string;
  about: string[];
  given: string[];
  errors: StoryError[];
  env: string;
  envs: string[];
  /** Why it can't run in this environment (a pin, a missing setup), or undefined. */
  problem?: string;
  /** Set when a run was refused (changed since shown, say). */
  flash?: string;
  steps: RailStep[];
  hash: string;
  who?: Who;
  runs: StoryRun[];
  now: number;
};

export function storyPage(o: StoryOpts): Html {
  const writes = o.steps.filter((s) => s.method && !["GET", "HEAD"].includes(s.method)).length;
  const can = !o.errors.length && !o.problem && o.steps.length > 0;
  const waits = o.steps.filter((s) => s.how.some((h) => h.startsWith("until "))).length;
  const always = o.steps.filter((s) => s.lane === "always").length;
  const shape = [o.given.length ? `Given ${o.given.join(", ")}.` : "", o.steps.length ? `${plural(o.steps.length - always, "step")}${waits ? `, ${plural(waits, "wait")}` : ""}${always ? `, ${always} always ${always === 1 ? "runs" : "run"} last` : ""}.` : ""].filter(Boolean).join(" ");
  const actions = html`<form method="get" action="/http/story" class="http-env">${hidden({ repo: o.repo, story: o.story })}<label class="field"><span class="label">Environment</span><select name="env"><option value="">None</option>${options(o.envs, o.env)}</select></label><button type="submit" class="btn sm ghost">Show</button></form>${can ? html`<form method="post" action="/http/story/run" class="inline">${hidden({ repo: o.repo, story: o.story, env: o.env, hash: o.hash })}<button type="submit" class="primary" data-busy="Running">Run the story</button></form>` : ""}`;
  const takes = o.steps.flatMap((s, i) => s.takes.map((t) => ({ name: t, from: `step ${i + 1}` })));
  return html`${PageHeader({
    title: o.title || o.story,
    sub: html`<span class="mono">${o.repo}/.http/stories/${o.story}</span>${o.who ? html` ${whoChip(o.who)}` : ""}${o.about.length ? html`<br>${o.about.join(" ")}` : ""}${shape ? html`<br>${shape}` : ""}`,
    crumbs: crumbs(o.repo),
    actions,
  })}
${o.flash ? Notice({ tone: "warn", children: o.flash }) : ""}
${o.errors.length ? Notice({ tone: "bad", children: html`It can't run: ${o.errors.length === 1 ? "a line" : `${o.errors.length} lines`} can't be read.<ul class="list">${o.errors.slice(0, 10).map((e) => html`<li class="item">line ${e.line}: ${e.message}</li>`)}</ul>` }) : ""}
${o.problem ? Notice({ tone: "warn", children: o.problem }) : ""}
<p class="hint">Nothing is sent from this page. A run sends each step from this machine as a send does (in history, logged); the first step that fails stops the rest, then the always steps run.${writes ? html` <strong>${writes} ${writes === 1 ? "step isn't a read" : "steps aren't reads"}</strong>: ${writes === 1 ? "it changes" : "they change"} things wherever ${writes === 1 ? "it goes" : "they go"}.` : ""}</p>
<div class="http-story">
${rail(o.steps)}
<aside class="http-aside">${valuesAside(takes, false)}${runsAside({ runs: o.runs, repo: o.repo, now: o.now })}</aside>
</div>`;
}

// ── A run ──────────────────────────────────────────────────────────────────────────────────────

/** A run's rail and values, swapped in place as each step moves. */
export function storyRunRegion(r: StoryRun, o: { hasSent: (id: string) => boolean; runs: StoryRun[]; now: number }): Html {
  const summary =
    r.state === "running"
      ? html`<p class="notes" data-pending><span class="spinner"></span> Running: ${runSummary(r)}…</p>`
      : Notice({ tone: r.state === "passed" ? "ok" : "bad", children: `It ${r.state === "passed" ? "passed" : "failed"}: ${runSummary(r)}${r.ms !== undefined ? ` in ${secs(r.ms)}` : ""}.` });
  const steps = railOfRun(r, o.hasSent);
  const values = r.values.map(([name, value]) => {
    const i = r.steps.findIndex((s) => s.took.includes(name));
    return { name, value, from: i < 0 ? "" : `step ${i + 1}` };
  });
  // Values not taken yet still show, as dashes, so the panel doesn't jump while it runs.
  const planned = steps.flatMap((s, i) => s.takes.map((t) => ({ name: t, from: `step ${i + 1}` })));
  const kept = r.values.length === 0 && r.state !== "running";
  return html`<div data-live id="http-story-${r.id}">${summary}<div class="http-story">${rail(steps)}<aside class="http-aside">${kept ? (planned.length ? valuesAside(planned, false) : "") : valuesAside(values.length ? values : planned, true)}${runsAside({ runs: o.runs, repo: r.repo, now: o.now, current: r.id })}</aside></div></div>`;
}

export function storyRunPage(r: StoryRun, o: { hasSent: (id: string) => boolean; runs: StoryRun[]; now: number }): Html {
  return html`${PageHeader({
    title: r.title || r.story,
    sub: html`<span class="mono">${r.repo}/.http/stories/${r.story}</span> · ${r.env || "no environment"} · ${ago(r.at, o.now)}`,
    crumbs: crumbs(r.repo),
    actions: html`<a class="btn sm" href="${storyHref({ repo: r.repo, story: r.story, env: r.env })}">Run it again</a>`,
  })}
${storyRunRegion(r, o)}`;
}

// ── The overview ───────────────────────────────────────────────────────────────────────────────

export type StoryRow = {
  file: string;
  title: string;
  given: string[];
  /** It can't be read: the first bad line. */
  error?: string;
  /** It can't run in this environment. */
  problem?: string;
  who?: Who;
  /** Set when it can run here: what Run posts. */
  hash?: string;
  /** Its newest run, any environment. */
  last?: StoryRun;
  /** Its last runs per environment shown. */
  pips: Pip[][];
};
export type SetupRow = { file: string; title: string; used: number; does: string; only: string[]; error?: string };

export type BoardOpts = {
  repos: string[];
  repo: string;
  env: string;
  envs: string[];
  show: Show;
  flash?: string;
  counts: { setups: number; cases: number };
  stories: StoryRow[];
  /** The environments with a pips column, in order. */
  pipEnvs: string[];
  gaps: { ep: Endpoint; inStory: boolean }[];
  noticed: Noticed[];
  setups: SetupRow[];
  recent: StoryRun[];
  now: number;
};

const lastCls = (r: StoryRun) => (r.state === "failed" ? "http-bad" : "t3");
const isFailing = (s: StoryRow) => s.last?.state === "failed";

function storyRow(s: StoryRow, o: BoardOpts): Html {
  const f = s.last && isFailing(s) ? failedAt(s.last) : undefined;
  const run = s.hash
    ? html`<form method="post" action="/http/story/run" class="inline">${hidden({ repo: o.repo, story: s.file, env: o.env, hash: s.hash })}<button type="submit" class="btn sm" data-busy="Running" aria-label="Run ${s.title || s.file} on ${o.env || "no environment"}">Run</button></form>`
    : html`<span class="t3" title="${s.error ?? s.problem ?? ""}">${s.error ? "can't be read" : "not here"}</span>`;
  return html`<tr><td class="http-story-cell"><a href="${storyHref({ repo: o.repo, story: s.file, env: o.env })}">${s.title || s.file}</a><span class="t3">${s.given.length ? `given ${s.given.join(", ")}` : "given nothing"}</span>${s.error ? html`<span class="http-why"><span class="http-bad">${s.error}</span></span>` : s.problem ? html`<span class="http-why t3">${s.problem}</span>` : ""}${f && s.last ? html`<span class="http-why"><span class="http-bad">step ${f.n}: ${f.why}</span><a href="${agentHref(o.repo, storyDebugPrompt(s.last))}" title="Start an agent session with what the run kept: you read the prompt first">debug with an agent</a></span>` : ""}</td>
<td>${s.who ? whoChip(s.who) : ""}</td>${s.pips.map((p, i) => html`<td>${pips(o.pipEnvs[i]!, p)}</td>`)}<td>${s.last ? html`<span class="${lastCls(s.last)}">${s.last.state} ${ago(s.last.at, o.now)}</span>` : html`<span class="t3">not run</span>`}</td><td>${run}</td></tr>`;
}

function askPanel(o: BoardOpts): Html {
  const ideas = o.gaps.slice(0, 3).map((g) => `A story for ${g.ep.method} ${g.ep.path}`);
  return Panel({
    title: "Ask for a story, cases or a setup",
    children: html`<form method="get" action="/http/stories/ask" class="http-ask">${hidden({ repo: o.repo })}<label class="field"><span class="label">What should it do?</span><input name="ask" maxlength="${MAX_ASK}" required autocomplete="off" placeholder="A customer who orders twice in a day gets 10% off the second order"></label><div class="buttons"><button type="submit">Draft with an agent</button></div></form>
${ideas.length ? html`<p class="http-ideas"><span class="t3">Ideas from this repo:</span>${ideas.map((i) => html`<a href="${agentHref(o.repo, storyAskPrompt(i))}">${i}</a>`)}</p>` : ""}
<p class="hint">It opens an agent session with the prompt filled in: you read it and press Start. The agent reads the handlers and the spec and writes <code>.story</code> files on a branch, which you review like code. It can run a story once it's committed (Dovre's <code>http_run</code> tool, to this machine and the hosts in HTTP_AGENT_HOSTS); a story that writes runs only when you click Run, unless its environment says <code>"$agent": "writes"</code> in the env file on the default branch (merged, so an agent can't grant it to itself).</p>`,
  });
}

function boardCards(o: BoardOpts): Html {
  const cards: Html[] = [];
  if (o.gaps.length) {
    const shown = o.gaps.slice(0, 8);
    cards.push(
      Panel({
        title: "Not covered yet",
        meta: html`<span class="t3">in the spec, no case</span>`,
        children: html`<ul class="http-rows">${shown.map((g) => html`<li><span class="http-m">${g.ep.method}</span><a class="http-grow mono" href="${quickHref({ repo: o.repo, env: o.env, ep: `${g.ep.method} ${g.ep.path}` })}">${g.ep.path}</a><span class="t3">${g.inStory ? "only in a story" : "no cases"}</span></li>`)}</ul>${o.gaps.length > shown.length ? html`<p class="hint">And ${o.gaps.length - shown.length} more.</p>` : ""}
<div class="buttons"><a class="btn sm" href="${agentHref(o.repo, coverPrompt(shown.map((g) => g.ep)))}" title="Start an agent session that drafts cases for these: you read the prompt first">Draft cases for these</a></div>`,
      }),
    );
  }
  if (o.noticed.length)
    cards.push(
      Panel({
        title: "Seen in the runs",
        meta: html`<span class="t3">from kept runs: no values</span>`,
        children: html`<ul class="http-rows">${o.noticed.map((n) => html`<li class="http-col"><span class="t3">${n.kind === "flaky" ? "Flaky" : "Getting slower"}</span><span>${n.text} <a href="${agentHref(o.repo, noticedPrompt(n))}">${n.kind === "flaky" ? "look into it" : "find the change"}</a></span></li>`)}</ul>`,
      }),
    );
  if (o.setups.length)
    cards.push(
      Panel({
        title: "Setups",
        meta: html`<span class="t3">the Given of a story</span>`,
        children: html`<ul class="http-rows">${o.setups.map((u) => html`<li class="http-col"><span class="http-row-head"><span class="mono">${u.title || u.file}</span><span class="t3">${u.used ? `used by ${plural(u.used, "story", "stories")}` : "not used"}</span></span><span class="t3">${u.error ?? u.does}${u.only.length ? ` · only ${u.only.join(", ")}` : ""}</span></li>`)}</ul>`,
      }),
    );
  if (o.recent.length)
    cards.push(
      Panel({
        title: "Recent runs",
        children: html`<ul class="http-runs">${o.recent.map((r) => html`<li>${Dot({ tone: runTone(r.state), label: r.state })}<a class="http-grow" href="${storyRunHref(r.id)}">${r.title || r.story}</a><span class="t3">${r.env || "no environment"} · ${runSummary(r)} · ${ago(r.at, o.now)}</span></li>`)}</ul>`,
      }),
    );
  return cards.length ? html`<div class="http-board">${cards}</div>` : html``;
}

/** A repo's stories: who can run each and how its last runs went, and what's worth doing next. */
export function storiesPage(o: BoardOpts): Html {
  const failing = o.stories.filter(isFailing).length;
  const agent = o.stories.filter((s) => s.who === "agent").length;
  const rows = o.stories.filter((s) => o.show === "all" || (o.show === "failing" && isFailing(s)) || (o.show === "agent" && s.who === "agent"));
  const sub: Child = o.repo
    ? `${plural(o.stories.length, "story", "stories")}, ${plural(o.counts.setups, "setup")}, ${plural(o.counts.cases, "case")} in .http/. Agents draft them on a branch; you review them like code.`
    : "Chains of requests that carry values from step to step, saved in .http/stories/";
  const tabs = o.repo
    ? Tabs({
        label: "Show",
        items: [
          { href: storiesHref({ repo: o.repo, env: o.env }), label: "All", n: o.stories.length, current: o.show === "all" },
          { href: storiesHref({ repo: o.repo, env: o.env, show: "failing" }), label: "Failing", n: failing, current: o.show === "failing" },
          { href: storiesHref({ repo: o.repo, env: o.env, show: "agent" }), label: "Agent can run", n: agent, current: o.show === "agent" },
        ],
      })
    : undefined;
  return html`${PageHeader({ title: "Stories", sub, crumbs: crumbs(), ...(tabs ? { tabs } : {}) })}
${o.flash ? Notice({ tone: "warn", children: o.flash }) : ""}
<form method="get" action="/http/stories" class="fields"><label class="field"><span class="label">Repo</span><select name="repo"><option value="">Pick one</option>${options(o.repos, o.repo)}</select></label>${o.repo ? html`<label class="field"><span class="label">Run in</span><select name="env"><option value="">No environment</option>${options(o.envs, o.env)}</select></label>` : ""}${o.show !== "all" ? hidden({ show: o.show }) : ""}<div class="buttons"><button type="submit">Show</button></div></form>
${o.repo ? askPanel(o) : ""}
${
  o.repo
    ? Panel({
        title: "Stories",
        meta: html`<span class="t3"><a href="${quickHref({ repo: o.repo, env: o.env })}">Quick view</a></span>`,
        flush: true,
        children: !o.stories.length
          ? Empty({ title: "No stories yet", children: html`<p>Ask for one above, or write one in <code>.http/stories/</code>.</p>` })
          : !rows.length
            ? Empty({ title: o.show === "failing" ? "Nothing failing." : "None an agent can run here." })
            : html`<div class="sheet"><table class="data"><thead><tr><th scope="col">Story</th><th scope="col">Who can run it</th>${o.pipEnvs.map((e) => html`<th scope="col">${e || "no environment"}, last 10</th>`)}<th scope="col">Last run</th><th scope="col"><span class="sr-only">Run</span></th></tr></thead><tbody>${rows.map((s) => storyRow(s, o))}</tbody></table></div>`,
      })
    : ""
}
${o.repo ? boardCards(o) : ""}`;
}

export const storiesStyles = `
.http-story { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 380px); gap: 1.25rem; align-items: start; }
.http-rail-wrap { display: flex; flex-direction: column; min-width: 0; }
.http-lane { margin: .5rem 0 .35rem 2.75rem; font-size: var(--fs-xs); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); }
.http-rail { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.http-step { display: flex; gap: .85rem; align-items: stretch; }
.http-track { flex: none; width: 1.9rem; display: flex; flex-direction: column; align-items: center; }
.http-track::after { content: ""; flex: 1; width: 2px; min-height: .75rem; background: var(--line); }
.http-mark { width: 1.75rem; height: 1.75rem; border-radius: 50%; border: 2px solid var(--line-2); box-sizing: border-box; display: flex; align-items: center; justify-content: center; font: 600 var(--fs-xs)/1 var(--mono); color: var(--text-3); background: var(--bg); }
.http-mark.http-st-ok { border-color: var(--ok); color: var(--ok); background: var(--ok-soft); }
.http-mark.http-st-bad { border-color: var(--bad); color: var(--bad); background: var(--bad-soft); }
.http-mark.http-st-now { border-color: var(--accent); color: var(--accent); }
.http-step-card { flex: 1; min-width: 0; margin-bottom: .75rem; padding: .7rem 1rem; display: flex; flex-direction: column; gap: .4rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); }
.http-step.http-st-now .http-step-card { border-color: var(--accent-line); }
.http-step.http-st-bad .http-step-card { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
.http-step-head { display: flex; justify-content: space-between; gap: .6rem; flex-wrap: wrap; align-items: baseline; }
.http-step-title { font-weight: 600; overflow-wrap: anywhere; }
.http-step.http-st-wait .http-step-title, .http-step.http-st-skip .http-step-title { color: var(--text-2); }
.http-step-what { font: var(--fs-sm)/1.45 var(--mono); color: var(--text-2); overflow-wrap: anywhere; }
.http-chips { display: flex; flex-wrap: wrap; gap: .35rem; }
.http-chip { font-size: var(--fs-xs); line-height: 1.5; padding: 1px .55rem; border-radius: 999px; border: 1px solid var(--line); background: var(--surface-2); color: var(--text-2); overflow-wrap: anywhere; }
.http-chip-in { background: var(--bg); }
.http-chip-out { border-color: var(--accent-line); background: var(--accent-soft); color: var(--text); }
.http-chip-ok { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
.http-chip-bad { border-color: color-mix(in srgb, var(--bad) 55%, var(--line)); color: var(--bad); }
.http-aside { display: flex; flex-direction: column; gap: .75rem; min-width: 0; }
.http-vals { list-style: none; margin: 0; padding: 0; }
.http-vals li { display: flex; flex-wrap: wrap; gap: .25rem .6rem; padding: .35rem 0; border-top: 1px solid var(--line); font-size: var(--fs-sm); }
.http-vals li:first-child { border-top: 0; }
.http-val-name { min-width: 8rem; font-family: var(--mono); color: var(--accent); }
.http-val { flex: 1; min-width: 6rem; font-family: var(--mono); overflow-wrap: anywhere; }
.http-runs, .http-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.http-runs li, .http-rows li { display: flex; flex-wrap: wrap; gap: .25rem .6rem; align-items: baseline; padding: .4rem 0; border-top: 1px solid var(--line); font-size: var(--fs-sm); }
.http-runs li:first-child, .http-rows li:first-child { border-top: 0; }
.http-rows li.http-col { flex-direction: column; align-items: stretch; }
.http-row-head { display: flex; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
.http-grow { flex: 1; min-width: 8rem; overflow-wrap: anywhere; }
.http-pips { display: inline-flex; gap: 3px; vertical-align: middle; }
.http-pip { width: 9px; height: 14px; border-radius: 2px; background: var(--line); }
.http-pip-ok { background: var(--ok); }
.http-pip-bad { background: var(--bad); }
.http-pip-run { background: var(--accent); }
.http-who { display: inline-block; font-size: var(--fs-xs); line-height: 1.5; padding: 1px .55rem; border-radius: 999px; border: 1px solid var(--line-2); background: var(--surface-2); color: var(--text-2); white-space: nowrap; }
.http-who.agent { border-color: var(--accent-line); background: var(--accent-soft); color: var(--text); }
.http-story-cell { min-width: 16rem; }
.http-story-cell > * { display: block; }
.http-story-cell > .http-why { display: flex; }
.http-why { display: flex; flex-wrap: wrap; gap: .25rem .6rem; font-size: var(--fs-xs); }
.http-bad { color: var(--bad); }
.http-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; align-items: start; }
.http-ask { display: flex; flex-wrap: wrap; gap: .6rem; align-items: end; }
.http-ask .field { flex: 1; min-width: 240px; }
.http-ask input { width: 100%; }
.http-ideas { display: flex; flex-wrap: wrap; gap: .3rem .9rem; align-items: baseline; font-size: var(--fs-sm); }
.http-env { display: flex; gap: .5rem; align-items: end; }
@media (max-width: 860px) { .http-story { grid-template-columns: 1fr; } }
`;
