/**
 * HTTP client (`http`): what the stories overview works out (dovre-packs#65 H-05). Pure: who may run
 * a story (an agent, or only me with a click), the pips of its last runs, what the kept runs show
 * (flaky, getting slower), and which of the spec's endpoints nothing covers yet.
 *
 * It reads kept runs only as they're kept (runner.ts `keptOf`): states, statuses, times and check
 * text. No values, no URL as sent, no response.
 */
import { type Catalog, type Endpoint, endpointKey } from "./catalog.ts";
import type { StoryRun } from "./runner.ts";

/** What an agent may send in any environment: reading only. Writes need the env's `"$agent": "writes"` on origin's default branch (H-06 checks the rest). */
export const READS = ["GET", "HEAD"];

/** Who can run a story whose sends use these methods: an agent, or me (a click). A method we can't tell counts as a write. */
export const whoRuns = (methods: string[], agentWrites: boolean): "agent" | "you" => (agentWrites || methods.every((m) => READS.includes(m)) ? "agent" : "you");

/** Who may run a story, as an agent's run checks it: an agent, an agent once the files it reads are committed, or only me. */
export type Who = "agent" | "commit" | "you";
export const whoOf = (methods: string[], agentWrites: boolean, committed: boolean): Who => (whoRuns(methods, agentWrites) === "you" ? "you" : committed ? "agent" : "commit");

/** `${name}` values a step's text uses, once each, in order. */
export function usesOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{\s*([A-Za-z_][\w.]{0,320})\s*\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

export type Pip = StoryRun["state"] | "none";

/** A story's last `n` runs in one environment, oldest first, padded in front with "none". */
export function pipsOf(runs: StoryRun[], story: string, env: string, n = 10): Pip[] {
  const got = runs
    .filter((r) => r.story === story && r.env === env)
    .sort((a, b) => b.at - a.at)
    .slice(0, n)
    .map((r) => r.state)
    .reverse();
  return [...Array<Pip>(n - got.length).fill("none"), ...got];
}

/** The step a failed run failed at, with its number and the check (or error) that failed. */
export function failedAt(r: StoryRun): { n: number; title: string; why: string } | undefined {
  const i = r.steps.findIndex((s) => s.state === "failed");
  if (i < 0) return undefined;
  const s = r.steps[i]!;
  const bad = s.checks.find((c) => !c.ok);
  return { n: i + 1, title: s.title || s.what, why: bad ? bad.text : (s.error ?? "it failed") };
}

export type Noticed = { kind: "flaky" | "slower"; story: string; title: string; env: string; text: string; step: string };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
};

/**
 * What a repo's kept runs show, per story and environment over its last 10 finished runs: it's flaky
 * (2 or more of each, passed and failed), or a step got slower (the newer half's median time at least
 * twice the older half's, and 100 ms more). At most `max`, flaky first.
 */
export function noticedIn(runs: StoryRun[], max = 5): Noticed[] {
  const groups = new Map<string, StoryRun[]>();
  for (const r of runs) {
    if (r.state === "running") continue;
    const k = `${r.story}\0${r.env}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const flaky: Noticed[] = [];
  const slower: Noticed[] = [];
  for (const list of groups.values()) {
    const last = list.sort((a, b) => b.at - a.at).slice(0, 10);
    const { story, title, env } = last[0]!;
    const name = title || story;
    const where = env || "no environment";
    const failed = last.filter((r) => r.state === "failed");
    if (failed.length >= 2 && last.length - failed.length >= 2) {
      const at = new Map<string, number>();
      for (const r of failed) {
        const f = failedAt(r);
        if (f) at.set(f.title, (at.get(f.title) ?? 0) + 1);
      }
      const [step, times] = [...at].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      flaky.push({
        kind: "flaky",
        story,
        title: name,
        env,
        step,
        text: `${name} failed ${failed.length} of its last ${last.length} runs on ${where}${step ? `, ${times === failed.length ? "each time" : "most often"} at "${step}"` : ""}.`,
      });
    }
    if (last.length < 6) continue;
    // A step by what it does, across runs (the story may have changed in between).
    const byStep = new Map<string, { title: string; ms: number[] }>();
    for (const r of [...last].reverse())
      for (const s of r.steps) {
        if (s.kind !== "send" || s.state !== "passed" || s.ms === undefined) continue;
        const k = `${s.title}\0${s.what}`;
        const e = byStep.get(k) ?? { title: s.title || s.what, ms: [] };
        e.ms.push(s.ms);
        byStep.set(k, e);
      }
    for (const { title: step, ms } of byStep.values()) {
      if (ms.length < 6) continue;
      const half = Math.floor(ms.length / 2);
      const before = median(ms.slice(0, half));
      const now = median(ms.slice(ms.length - half));
      if (now >= before * 2 && now - before >= 100) {
        slower.push({ kind: "slower", story, title: name, env, step, text: `"${step}" in ${name} went from about ${before} ms to ${now} ms over its last ${ms.length} runs on ${where}.` });
        break;
      }
    }
  }
  return [...flaky, ...slower].slice(0, max);
}

/** The spec's endpoints no saved case covers: each says whether a story's own request touches it. */
export function uncovered(catalog: Catalog, touched: Set<string>): { ep: Endpoint; inStory: boolean }[] {
  return catalog.endpoints.filter((e) => e.fromSpec && !e.cases.length).map((ep) => ({ ep, inStory: touched.has(endpointKey(ep)) }));
}
