/**
 * Topo in Dovre's attention flow (dovre-packs#68 step 4). Drift is a need: each thing a file
 * declares that isn't on Cloudflare, and each thing on Cloudflare no file claims, linked to its
 * place on the map. It rings as `topo-drift`, off until I switch it on. Today's opening line says
 * how many repos are out of line (drift, rules, files that don't parse) when any are.
 */
import type { Bit, PackNeed } from "dovre/packs/types.ts";
import { CF_NAMES, type Drift, type Missing, type Orphan } from "./drift.ts";
import { keyOf, orphanKey } from "./map.ts";
import type { Finding } from "./rules.ts";
import type { TopoRepo } from "./scan.ts";

export const RING = "topo-drift";

const named = (kind: Missing["kind"], name: string, worker?: string) => `${CF_NAMES[kind][0]} ${worker ? `${worker}/` : ""}${name}`;
const mapAt = (key: string) => `/topo?at=${encodeURIComponent(key)}`;

/** Drift as needs, as of the Cloudflare read at `at`. A key stays the same while the same thing is off. */
export function driftNeeds(d: Drift | undefined, at: number): PackNeed[] {
  if (!d) return [];
  const missing = d.missing.map(
    (m): PackNeed => ({
      key: `missing ${keyOf(m)} ${m.kind} ${m.worker ? `${m.worker}/` : ""}${m.name}`,
      title: `${m.repo} declares ${named(m.kind, m.name, m.worker)}, which isn't on Cloudflare`,
      line: `Drift · ${m.envs.join(", ")}`,
      href: mapAt(keyOf(m)),
      tone: "warn",
      rank: 2,
      at,
      ring: RING,
      label: "Topo",
    }),
  );
  const orphans = d.orphans.map(
    (o: Orphan): PackNeed => ({
      key: `orphan ${orphanKey(o)}`,
      title: `${named(o.kind, o.name, o.worker)} is on Cloudflare, in no peak.yaml`,
      line: "Drift · claim it in a repo's peak.yaml, or remove it",
      href: mapAt(orphanKey(o)),
      tone: "warn",
      rank: 3,
      at,
      ring: RING,
      label: "Topo",
    }),
  );
  return [...missing, ...orphans];
}

/**
 * Today's sentence: how many repos are out of line, linked to the first one on the map, and how
 * many things on Cloudflare no file claims. Empty when nothing is.
 */
export function topoBrief(o: { drift?: Drift; findings: Finding[]; problems: TopoRepo[] }): Bit[] {
  const repos = new Map<string, TopoRepo>();
  for (const r of [...o.problems, ...(o.drift?.missing ?? []), ...o.findings]) if (!repos.has(keyOf(r))) repos.set(keyOf(r), r);
  const orphans = o.drift?.orphans.length ?? 0;
  const bad = o.problems.length > 0 || (o.drift?.missing.length ?? 0) > 0;
  const out: Bit[] = [];
  if (repos.size) {
    const first = [...repos.keys()][0]!;
    const text = repos.size === 1 ? [...repos.values()][0]!.repo : `${repos.size} repos`;
    out.push({ text, href: mapAt(first), tone: bad ? "bad" : "warn" }, ` ${repos.size === 1 ? "is" : "are"} out of line on Topo`);
  }
  if (orphans) {
    const things = `${orphans} ${orphans === 1 ? "thing" : "things"} on Cloudflare`;
    if (out.length) out.push(", and ", { text: things, href: "/topo", tone: "warn" }, " no peak.yaml claims.");
    else out.push({ text: things, href: "/topo", tone: "warn" }, ` ${orphans === 1 ? "is" : "are"} in no peak.yaml.`);
  } else if (out.length) out.push(".");
  return out;
}
