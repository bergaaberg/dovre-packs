/**
 * HTTP client (`http`): running a story (dovre-packs#65 H-04). The plan (story.ts `planStory`) runs
 * in order: its setups' steps, then the story's. Each send step is an ordinary send (in history,
 * logged as `http.send`) whose answer is held to its checks; `until:` sends it again until its check
 * passes; `take:` keeps values for later steps (`${name}`); `check:` compares values. The first step
 * that fails stops the rest, and then every `always:` step runs, whatever happened.
 *
 * A run in memory has everything (values, what each check got) for the newest MAX_LIVE runs. What's
 * kept in Dovre's database is less: the last MAX_KEPT runs per story, each step as written, its
 * state, status and time, and its checks' text and outcome; never a value, a URL as sent or a
 * response (the pack keeps responses in memory only). Tables are made on first use,
 * prefixed `http_`, so the pack needs no core migration.
 */
import type { D1 } from "dovre/pack.ts";
import type { Refs } from "./chain.ts";
import { type Outcome, runCheck, runChecks } from "./checks.ts";
import type { Req } from "./model.ts";
import type { Resp } from "./send.ts";
import { type CaseRef, fillValues, type Plan, runValueCheck, type Send, takeValue, type Values } from "./story.ts";

/** Runs kept whole in memory, and runs kept per story in the database. */
export const MAX_LIVE = 20;
export const MAX_KEPT = 50;
/** Most sends one `until:` makes before it gives up, whatever its max says. */
export const MAX_TRIES = 100;

export type Lane = "given" | "story" | "always";
export type StepState = "waiting" | "sending" | "passed" | "failed" | "skipped";

export type StepRun = {
  lane: Lane;
  /** The setup it comes from ("" for the story's own). */
  from: string;
  title: string;
  kind: "send" | "check";
  /** What it does in a line: `POST {{baseUrl}}/orders`, `case: orders.http#Happy path`, or the check. */
  what: string;
  state: StepState;
  method?: string;
  /** Where it went last: origin and path, masked. */
  url?: string;
  status?: number;
  ms?: number;
  /** Sends it made (more than one with until:). */
  tries?: number;
  /** The newest send in history, while it's still there. */
  sentId?: string;
  error?: string;
  checks: Outcome[];
  /** The names it took. */
  took: string[];
};

export type StoryRun = {
  id: string;
  at: number;
  repo: string;
  /** The story's file name (`checkout.story`) and title. */
  story: string;
  title: string;
  env: string;
  state: "running" | "passed" | "failed";
  /** How long it took, once done. */
  ms?: number;
  steps: StepRun[];
  /** Values taken so far, in order (from masked responses). Memory only. */
  values: [string, string][];
};

export type Sent1 = { ok: true; sentId: string; resp: Resp; url: string } | { ok: false; error: string; sentId?: string; url?: string };

export type RunIo = {
  /** A case a step names, as it was read when the run was shown and checked. */
  caseOf(ref: CaseRef): { req: Req; file: string; n: number } | { error: string };
  /** One send: prepared (refused → ok false, "Not sent: …"), started, settled. */
  send(req: Req, from: { file: string; n: number }, refs: Refs): Promise<Sent1>;
  wait(ms: number): Promise<void>;
  now(): number;
  publish(): void;
};

const whatOf = (s: Send) => (s.ask.t === "case" ? `case: ${s.ask.ref.file}#${s.ask.ref.name}` : `${s.ask.req.method} ${s.ask.req.url}`);

/** A run's steps before anything is sent: every one waiting. */
export function newRun(o: { id: string; at: number; repo: string; story: string; title: string; env: string }, plan: Plan): StoryRun {
  const send = (s: Send, lane: Lane, from: string): StepRun => ({ lane, from, title: s.title, kind: "send", what: whatOf(s), state: "waiting", checks: [], took: [] });
  return {
    ...o,
    state: "running",
    values: [],
    steps: [
      ...plan.steps.map((s, i): StepRun => {
        const from = plan.stepFrom[i] ?? "";
        const lane: Lane = from ? "given" : "story";
        return s.t === "check" ? { lane, from, title: s.text, kind: "check", what: s.text, state: "waiting", checks: [], took: [] } : send(s, lane, from);
      }),
      ...plan.always.map((s, i) => send(s, "always", plan.alwaysFrom[i] ?? "")),
    ],
  };
}

/** Runs the plan into `run` (one made by newRun from the same plan), publishing as each step moves. */
export async function runStory(run: StoryRun, plan: Plan, io: RunIo): Promise<StoryRun> {
  const started = io.now();
  const values: Values = new Map();
  // What came back so far in this run, by request name, for `{{name.response…}}`.
  const back = new Map<string, Resp>();
  const refs: Refs = (name) => back.get(name);

  async function sendStep(st: StepRun, s: Send): Promise<boolean> {
    const fail = (error: string) => {
      Object.assign(st, { state: "failed", error });
      io.publish();
      return false;
    };
    let req: Req;
    let from = { file: "", n: 0 };
    let expect = s.expect;
    if (s.ask.t === "case") {
      const c = io.caseOf(s.ask.ref);
      if ("error" in c) return fail(`Not sent: ${c.error}`);
      req = c.req;
      from = { file: c.file, n: c.n };
      expect = [...(c.req.expect ?? []), ...s.expect];
    } else req = s.ask.req;
    st.method = req.method;
    const filled = fillValues(req, values);
    if (!filled.ok) return fail(`Not sent: ${filled.error}`);
    const t0 = io.now();
    let tries = 0;
    for (;;) {
      st.state = "sending";
      io.publish();
      const got = await io.send(filled.req, from, refs);
      tries++;
      Object.assign(st, { tries, ...(got.sentId ? { sentId: got.sentId } : {}), ...(got.url ? { url: got.url } : {}) });
      if (!got.ok) return fail(got.error);
      Object.assign(st, { status: got.resp.status, ms: got.resp.ms });
      const checks = runChecks(expect, got.resp);
      if (s.until) {
        const u = runCheck(s.until.check, got.resp);
        if (!u.ok) {
          const spent = io.now() - t0;
          if (spent + s.until.everyMs <= s.until.maxMs && tries < MAX_TRIES) {
            st.checks = [{ ...u, text: `until ${u.text}` }];
            io.publish();
            await io.wait(s.until.everyMs);
            continue;
          }
          st.checks = [...checks, { ...u, text: `until ${u.text}` }];
          return fail(`Still not ${s.until.check} after ${tries} ${tries === 1 ? "try" : "tries"} (${Math.round((io.now() - t0) / 100) / 10} s).`);
        }
        checks.push({ ...u, text: `until ${u.text}` });
      }
      st.checks = checks;
      if (!checks.every((k) => k.ok)) return fail(`${checks.filter((k) => !k.ok).length} of ${checks.length} checks failed.`);
      if (req.name) back.set(req.name, got.resp);
      for (const t of s.take) {
        const v = takeValue(t.from, got.resp);
        if ("error" in v) return fail(`Couldn't take ${t.name}: ${v.error}.`);
        values.set(t.name, v.value);
        st.took.push(t.name);
      }
      run.values = [...values];
      st.state = "passed";
      io.publish();
      return true;
    }
  }

  let ok = true;
  const sends = [...plan.steps, ...plan.always.map((s) => ({ t: "send" as const, ...s }))];
  for (const [i, st] of run.steps.entries()) {
    const step = sends[i]!;
    if (!ok && st.lane !== "always") {
      st.state = "skipped";
      continue;
    }
    if (step.t === "check") {
      const out = runValueCheck(step.text, values);
      Object.assign(st, { checks: [out], state: out.ok ? "passed" : "failed" });
      io.publish();
      if (!out.ok) ok = false;
      continue;
    }
    if (!(await sendStep(st, step))) ok = false;
  }
  run.state = ok ? "passed" : "failed";
  run.ms = io.now() - started;
  io.publish();
  return run;
}

/** How a run went in a few words: `5 of 7 passed`, `failed at Cancel it`. */
export function runSummary(r: StoryRun): string {
  const done = r.steps.filter((s) => s.state === "passed").length;
  const bad = r.steps.find((s) => s.state === "failed");
  if (r.state === "running") return `${done} of ${r.steps.length} done`;
  return bad ? `failed at ${bad.title || bad.what}` : `all ${r.steps.length} passed`;
}

/** The newest runs whole, in memory (values and what each check got included). */
export function createLiveRuns(max = MAX_LIVE) {
  const list: StoryRun[] = [];
  return {
    add(r: StoryRun) {
      list.unshift(r);
      list.length = Math.min(list.length, max);
    },
    get: (id: string) => list.find((r) => r.id === id),
    list: () => [...list],
  };
}
export type LiveRuns = ReturnType<typeof createLiveRuns>;

// ── Kept runs ──────────────────────────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS http_story_runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, story TEXT NOT NULL, title TEXT NOT NULL, env TEXT NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL, record TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS http_story_runs_story ON http_story_runs (repo, story, at)`,
];
const made = new WeakSet<object>();

async function ensureSchema(db: D1): Promise<void> {
  if (made.has(db)) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  made.add(db);
}

/** A run as it's kept: no values, no URL as sent (a value can be in its path: `what` has it as written), and no check says what it got. */
export function keptOf(r: StoryRun): StoryRun {
  return {
    ...r,
    values: [],
    steps: r.steps.map(({ sentId: _s, url: _u, ...st }) => ({ ...st, checks: st.checks.map((k) => ({ text: k.text, ok: k.ok })) })),
  };
}

/** Keeps a finished run, and drops that story's runs beyond the newest MAX_KEPT. */
export async function keepRun(db: D1, r: StoryRun): Promise<void> {
  await ensureSchema(db);
  const k = keptOf(r);
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO http_story_runs (id, repo, story, title, env, at, ms, ok, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(k.id, k.repo, k.story, k.title, k.env, k.at, k.ms ?? 0, k.state === "passed" ? 1 : 0, JSON.stringify(k.steps)),
    db.prepare("DELETE FROM http_story_runs WHERE repo = ? AND story = ? AND id NOT IN (SELECT id FROM http_story_runs WHERE repo = ? AND story = ? ORDER BY at DESC, id DESC LIMIT ?)").bind(k.repo, k.story, k.repo, k.story, MAX_KEPT),
  ]);
}

type Row = { id: string; repo: string; story: string; title: string; env: string; at: number; ms: number; ok: number; record: string };

function fromRow(row: Row): StoryRun {
  let steps: StepRun[] = [];
  try {
    const got = JSON.parse(row.record) as unknown;
    if (Array.isArray(got)) steps = got as StepRun[];
  } catch {
    // A record that can't be read is a run with no steps.
  }
  return { id: row.id, at: row.at, repo: row.repo, story: row.story, title: row.title, env: row.env, ms: row.ms, state: row.ok ? "passed" : "failed", steps, values: [] };
}

/** A repo's kept runs, newest first: one story's, or all of them. */
export async function keptRuns(db: D1, repo: string, story?: string, limit = MAX_KEPT): Promise<StoryRun[]> {
  await ensureSchema(db);
  const q = story
    ? db.prepare("SELECT * FROM http_story_runs WHERE repo = ? AND story = ? ORDER BY at DESC, id DESC LIMIT ?").bind(repo, story, limit)
    : db.prepare("SELECT * FROM http_story_runs WHERE repo = ? ORDER BY at DESC, id DESC LIMIT ?").bind(repo, limit);
  return (await q.all<Row>()).results.map(fromRow);
}

export async function keptRun(db: D1, id: string): Promise<StoryRun | undefined> {
  await ensureSchema(db);
  const row = await db.prepare("SELECT * FROM http_story_runs WHERE id = ?").bind(id).first<Row>();
  return row ? fromRow(row) : undefined;
}
