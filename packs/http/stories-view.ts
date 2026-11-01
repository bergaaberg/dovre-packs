/**
 * HTTP client (`http`): the stories' pages (dovre-packs#65 H-04; H-05 draws them as designed). The
 * story page shows what a run will do and sends nothing; the run page fills in over the hub. What a
 * step or check shows came from a response or a file: it's only interpolated into html`…`.
 */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Empty, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import type { Lane, StepRun, StoryRun } from "./runner.ts";
import { runSummary } from "./runner.ts";
import { sentHref } from "./view.ts";
import type { Story, StoryError } from "./story.ts";

type Html = ReturnType<typeof html>;
const qs = (q: Record<string, string | undefined>) => new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();

export const storiesHref = (q: { repo?: string; env?: string } = {}) => safeUrl(`/http/stories${qs(q) ? `?${qs(q)}` : ""}`);
export const storyHref = (q: { repo: string; story: string; env?: string }) => safeUrl(`/http/story?${qs(q)}`);
export const storyRunHref = (id: string) => safeUrl(`/http/story/run/${encodeURIComponent(id)}`);

const crumbs = (repo?: string) => [{ href: "/http", label: "HTTP" }, ...(repo ? [{ href: storiesHref({ repo }), label: "Stories" }] : [])];
const clock = (at: number) => `${new Date(at).toISOString().replace("T", " ").slice(0, 19)} UTC`;
const options = (all: string[], at: string) => all.map((e) => html`<option value="${e}"${e === at ? " selected" : ""}>${e}</option>`);
const LANES: Record<Lane, string> = { given: "Given", story: "Story", always: "Always" };

const runPill = (r: Pick<StoryRun, "state">) => (r.state === "passed" ? Pill({ tone: "ok", children: "passed" }) : r.state === "failed" ? Pill({ tone: "bad", children: "failed" }) : Pill({ tone: "neutral", children: "running" }));
const stepPill = (s: StepRun) =>
  s.state === "passed"
    ? Pill({ tone: "ok", children: "passed" })
    : s.state === "failed"
      ? Pill({ tone: "bad", children: "failed" })
      : Pill({ tone: "neutral", children: s.state === "sending" ? "sending" : s.state === "skipped" ? "skipped" : "waiting" });

/** A story's steps by lane, before a run: what each does. */
export type PlannedStep = { lane: Lane; from: string; title: string; what: string; checks: string[]; takes: string[]; until?: string };

export function storyPage(o: {
  repo: string;
  story: string;
  title: string;
  parsed?: Story;
  errors: StoryError[];
  env: string;
  envs: string[];
  /** Why it can't run in this environment (a pin, a missing setup), or undefined. */
  problem?: string;
  /** Set when a run was refused (changed since shown, say). */
  flash?: string;
  steps: PlannedStep[];
  hash: string;
  runs: StoryRun[];
}): Html {
  const writes = o.steps.filter((s) => /^(POST|PUT|PATCH|DELETE) /.test(s.what)).length;
  const can = !o.errors.length && !o.problem && o.steps.length > 0;
  return html`${PageHeader({ title: o.title || o.story, sub: html`<span class="mono">${o.repo}/.http/stories/${o.story}</span>${o.parsed?.about.length ? html`: ${o.parsed.about.join(" ")}` : ""}`, crumbs: crumbs(o.repo) })}
${o.flash ? Notice({ tone: "warn", children: o.flash }) : ""}
${o.errors.length ? Notice({ tone: "bad", children: html`It can't run: ${o.errors.length === 1 ? "a line" : `${o.errors.length} lines`} can't be read.<ul class="list">${o.errors.slice(0, 10).map((e) => html`<li class="item">line ${e.line}: ${e.message}</li>`)}</ul>` }) : ""}
${o.problem ? Notice({ tone: "warn", children: o.problem }) : ""}
${Panel({
  title: "Run",
  children: html`<form method="get" action="/http/story" class="fields"><input type="hidden" name="repo" value="${o.repo}"><input type="hidden" name="story" value="${o.story}"><label class="field"><span class="label">Environment</span><select name="env"><option value="">None</option>${options(o.envs, o.env)}</select></label><div class="buttons"><button type="submit">Show it with this</button></div></form>
${can ? html`<form method="post" action="/http/story/run"><input type="hidden" name="repo" value="${o.repo}"><input type="hidden" name="story" value="${o.story}"><input type="hidden" name="env" value="${o.env}"><input type="hidden" name="hash" value="${o.hash}"><div class="buttons"><button type="submit" class="primary" data-busy="Running">Run the story</button></div></form>` : ""}
<p class="notes">Each step goes out from this machine as a send does, shows in history and is logged. The first step that fails stops the rest; then the always steps run.${writes ? html` <strong>${writes} ${writes === 1 ? "step isn't a read" : "steps aren't reads"}</strong>: they change things wherever they go.` : ""}</p>`,
})}
${Panel({
  title: "Steps",
  children: o.steps.length
    ? html`<ol class="list">${o.steps.map(
        (s) =>
          html`<li class="item"><span class="t3">${LANES[s.lane]}${s.from ? ` · ${s.from}` : ""}</span> <strong>${s.title}</strong> <span class="mono t3">${s.what}</span>${s.until ? html` <span class="t3">· until ${s.until}</span>` : ""}${s.checks.length ? html`<ul class="list">${s.checks.map((c) => html`<li class="item mono">${c}</li>`)}</ul>` : ""}${s.takes.length ? html`<p class="notes">Takes ${s.takes.join(", ")}</p>` : ""}</li>`,
      )}</ol>`
    : Empty({ title: "No steps to show." }),
})}
${runsPanel(o.runs)}`;
}

function runsPanel(runs: StoryRun[]): Html {
  return Panel({
    title: "Earlier runs",
    children: runs.length
      ? html`<ul class="list">${runs.map((r) => html`<li class="item">${runPill(r)} <a href="${storyRunHref(r.id)}">${clock(r.at)}</a> <span class="t3">· ${r.env || "no environment"} · ${runSummary(r)}${r.ms !== undefined ? ` · ${r.ms} ms` : ""}</span></li>`)}</ul>`
      : Empty({ title: "Not run yet." }),
  });
}

/** A run's steps, swapped in place as each one moves. */
export function storyRunRegion(r: StoryRun, hasSent: (id: string) => boolean): Html {
  const summary = r.state === "running" ? html`<p class="notes" data-pending><span class="spinner"></span> Running: ${runSummary(r)}…</p>` : Notice({ tone: r.state === "passed" ? "ok" : "bad", children: `It ${r.state === "passed" ? "passed" : "failed"}: ${runSummary(r)}${r.ms !== undefined ? ` in ${r.ms} ms` : ""}.` });
  return html`<div data-live id="http-story-${r.id}">${summary}${Panel({
    title: "Steps",
    meta: html`<span class="t3">${r.env ? `environment ${r.env}` : "no environment"}</span>`,
    children: html`<ol class="list">${r.steps.map(
      (s) =>
        html`<li class="item">${stepPill(s)} <span class="t3">${LANES[s.lane]}${s.from ? ` · ${s.from}` : ""}</span> ${s.sentId && hasSent(s.sentId) ? html`<a href="${sentHref(s.sentId)}">${s.title || s.what}</a>` : html`<strong>${s.title || s.what}</strong>`}${s.url ? html` <span class="t3 mono">${s.method} ${s.url}</span>` : ""}${s.status !== undefined ? html` <span class="t3">· ${s.status} · ${s.ms} ms${s.tries && s.tries > 1 ? ` · ${s.tries} tries` : ""}</span>` : ""}
${s.error ? html`<p class="notes">${s.error}</p>` : ""}${s.checks.length ? html`<ul class="list">${s.checks.map((c) => html`<li class="item">${Pill({ tone: c.ok ? "ok" : "bad", children: c.ok ? "ok" : "no" })} <span class="mono">${c.text}</span>${c.got !== undefined ? html` <span class="t3">got ${c.got}</span>` : ""}</li>`)}</ul>` : ""}${s.took.length ? html`<p class="notes">Took ${s.took.join(", ")}</p>` : ""}</li>`,
    )}</ol>`,
  })}${r.values.length ? Panel({ title: "Values", children: html`<table class="data"><tbody>${r.values.map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td class="mono">${v}</td></tr>`)}</tbody></table>` }) : ""}</div>`;
}

export function storyRunPage(r: StoryRun, hasSent: (id: string) => boolean): Html {
  return html`${PageHeader({ title: r.title || r.story, sub: html`<span class="mono">${r.repo}/.http/stories/${r.story}</span> · ${clock(r.at)}`, crumbs: crumbs(r.repo) })}
${storyRunRegion(r, hasSent)}
<div class="buttons"><a class="btn sm" href="${storyHref({ repo: r.repo, story: r.story, env: r.env })}">Run it again</a></div>`;
}

/** A repo's stories with their newest run (H-05 makes this the overview). */
export function storiesPage(o: { repos: string[]; repo: string; flash?: string; stories: { file: string; title: string; error?: string; last?: StoryRun }[] }): Html {
  return html`${PageHeader({ title: "Stories", sub: "Chains of requests that carry values from step to step, saved in .http/stories/", crumbs: crumbs() })}
${o.flash ? Notice({ tone: "warn", children: o.flash }) : ""}
<form method="get" action="/http/stories" class="fields"><label class="field"><span class="label">Repo</span><select name="repo"><option value="">Pick one</option>${options(o.repos, o.repo)}</select></label><div class="buttons"><button type="submit">Show</button></div></form>
${o.repo
  ? Panel({
      title: "Stories",
      children: o.stories.length
        ? html`<ul class="list">${o.stories.map((s) => html`<li class="item">${s.last ? runPill(s.last) : Pill({ tone: "neutral", children: "not run" })} <a href="${storyHref({ repo: o.repo, story: s.file })}">${s.title || s.file}</a> <span class="t3 mono">${s.file}</span>${s.error ? html` <span class="t3">· ${s.error}</span>` : ""}</li>`)}</ul>`
        : Empty({ title: "No stories yet", children: html` in <code>.http/stories/</code>.` }),
    })
  : ""}`;
}
