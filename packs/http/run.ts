/**
 * HTTP client (`http`): running a `.http` file as a smoke test. Its requests go out one after the
 * other, each an ordinary send (in history, logged as `http.send`), and each response is held to the
 * request's checks (checks.ts). A run is one click on a page that showed what it will send; it keeps
 * only what the checks found (masked, as the responses are), in memory, the newest MAX_RUNS.
 */
import type { Outcome } from "./checks.ts";

/** Most requests one run sends, and runs kept in memory. */
export const MAX_RUN = 50;
export const MAX_RUNS = 10;

export type Step = {
  n: number;
  name: string;
  method: string;
  /** Where it went, masked (or the URL as written when it couldn't be prepared). */
  url: string;
  state: "waiting" | "sending" | "passed" | "failed";
  /** The send in history, while it's still there. */
  sentId?: string;
  status?: number;
  ms?: number;
  /** Why it wasn't sent or nothing came back. */
  error?: string;
  checks: Outcome[];
};

export type Run = {
  id: string;
  at: number;
  repo: string;
  file: string;
  env: string;
  state: "running" | "done";
  steps: Step[];
};

export const passed = (r: Run) => r.steps.filter((s) => s.state === "passed").length;
export const failedSteps = (r: Run) => r.steps.filter((s) => s.state === "failed").length;

export function createRuns() {
  const list: Run[] = [];
  return {
    add(r: Run) {
      list.unshift(r);
      list.length = Math.min(list.length, MAX_RUNS);
    },
    get: (id: string) => list.find((r) => r.id === id),
    list: () => [...list],
  };
}
export type Runs = ReturnType<typeof createRuns>;
