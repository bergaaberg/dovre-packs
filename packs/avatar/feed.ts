/**
 * Dovre's state as the avatar's signals (./mood.ts): counts only, read from what the pages
 * already have (the snapshot and its needs, the packs' pulse (what works, waits and is wrong, and
 * whether one says I'm on duty), My list). Pure.
 */
import type { Pulse } from "dovre/packs/types.ts";
import type { Snapshot } from "dovre/gather.ts";
import type { Need } from "dovre/home/needs.ts";
import type { Signals } from "./mood.ts";

export function signalsFrom(o: { snap: Snapshot; needs: Need[]; /** The packs' pulse (PackContext.pulse): agents working and waiting, troubles, on duty. */ pulse: Omit<Pulse, "busy">; doing: number; mergedToday: number; hour: number }): Signals {
  const s = o.snap;
  return {
    redBuilds: s.red.length,
    deploysWaiting: o.needs.filter((n) => n.kind === "deploy").length,
    agentsWorking: o.pulse.working,
    agentsAsking: o.pulse.asking,
    reviewsAsked: s.prs.ok ? s.prs.value.review.length : 0,
    mergedToday: o.mergedToday,
    doing: o.doing,
    hour: o.hour,
    ...(o.pulse.trouble.length ? { trouble: o.pulse.trouble } : {}),
    ...(o.pulse.onDuty ? { onCall: true } : {}),
  };
}
