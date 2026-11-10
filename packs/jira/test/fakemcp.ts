/** A made-up `ctx.mcp` for the jira tests: what the agent's calls were for a job, matched as core matches them. */
import type { PackMcp, PackMcpCall, PackMcpResult } from "dovre/pack.ts";

/** A call as the agent made it, and what its tool answered. */
export type Made = { tool: string; input: Record<string, unknown>; result: string; error?: boolean };
export type Job = { calls: PackMcpCall[]; write: boolean };

const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function resultOf(made: Made[], c: PackMcpCall): PackMcpResult {
  const of = made.filter((m) => m.tool === c.tool);
  const hit = of.find((m) => same(m.input, c.input));
  if (!hit) return { ok: false, why: of.length ? `${c.tool} was called with other arguments than asked` : `the ${c.tool} call wasn't made` };
  return hit.error ? { ok: false, why: `${c.tool}: ${hit.result.split("\n")[0]}` } : { ok: true, text: hit.result };
}

/** The error core throws when Claude Code isn't there, or isn't signed in. */
export const setupError = (setup: "no-claude" | "sign-in", message: string) => Object.assign(new Error(message), { setup });

/** `answer`: the calls the agent made for a job (default: none), or the error the job ends in. `allowed` false: not ticked on Settings. */
export function fakeMcp(answer: (job: Job) => Made[] | Error, o: { allowed?: boolean; cost?: number } = {}): { mcp: PackMcp; jobs: Job[] } {
  const jobs: Job[] = [];
  const run = (job: Job): Made[] => {
    jobs.push(job);
    const a = answer(job);
    if (a instanceof Error) throw a;
    return a;
  };
  const cost = o.cost ?? 0.004;
  return {
    jobs,
    mcp: {
      can: () => (o.allowed === false ? { ok: false, why: "not allowed: Settings → Packs → this pack" } : { ok: true, reads: [], writes: [] }),
      async call(calls) {
        const made = run({ calls, write: false });
        return { results: calls.map((c) => resultOf(made, c)), cost };
      },
      async write(_kind, call) {
        const made = run({ calls: [call], write: true });
        return { result: resultOf(made, call), cost, times: made.filter((m) => m.tool === call.tool).length };
      },
    },
  };
}
