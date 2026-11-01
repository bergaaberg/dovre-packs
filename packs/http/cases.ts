/**
 * HTTP client (`http`): cases (dovre-packs#65, H-03). A case is a saved request on one endpoint,
 * with its `# @expect` checks: run one or all of an endpoint's, and see ticks and crosses.
 *
 * Results stay in memory like history (the newest per case, MAX_RESULTS cases), never stored: what
 * a case gave last is a session's working memory, and run records (H-04) are the stories' to keep.
 */
import type { Outcome } from "./checks.ts";
import type { Req } from "./model.ts";

export const MAX_RESULTS = 200;
/** At most this many cases in one Run all. */
export const MAX_RUN_ALL = 30;

/** A case as an endpoint lists it: where it's saved (file, its index there) and the request. */
export type Case = { file: string; n: number; req: Req };

export type CaseResult = {
  at: number;
  env: string;
  state: "running" | "passed" | "failed";
  sentId?: string;
  status?: number;
  ms?: number;
  checks: Outcome[];
  /** Why it wasn't sent, or why nothing came back. */
  error?: string;
};

/** A case's key: its repo, file and name (its index when it has none, so renaming it starts afresh). */
export const caseKey = (repo: string, c: Pick<Case, "file" | "n" | "req">) => `${repo}\0${c.file}\0${c.req.name || `#${c.n}`}`;

export function createResults(max = MAX_RESULTS) {
  const m = new Map<string, CaseResult>();
  return {
    get: (key: string) => m.get(key),
    set(key: string, r: CaseResult) {
      m.delete(key);
      m.set(key, r);
      while (m.size > max) m.delete(m.keys().next().value!);
    },
    clear: () => m.clear(),
  };
}
export type Results = ReturnType<typeof createResults>;

/** What a case's checks say in a few characters: `201`, `status 2xx · 2 more`, or `< 400` with none. */
export function expectsText(r: Req): string {
  const e = r.expect ?? [];
  if (!e.length) return "< 400";
  const status = e.find((x) => /^status\s/.test(x))?.replace(/^status\s+/, "");
  const head = status ?? e[0]!;
  return e.length > 1 ? `${head} · ${e.length - 1} more` : head;
}
