/**
 * Drift (dovre-packs#68 step 2): what the peak.yaml files say runs on Cloudflare against what's
 * there (cloud.ts). **Missing**: a name a file declares, in any environment (peak's `runsIn`), that
 * doesn't exist. **Orphan**: something that exists and no file claims. A name ending in `*` claims
 * by prefix whatever no entry before it in the same list names (the spec), and is never missing
 * itself. Entries for another provider are skipped; no provider means Cloudflare. A worker's
 * `objects` are its Durable Object classes: declared ones it doesn't hold are missing, ones it
 * holds that no claiming entry names are orphans. Kinds the inventory couldn't read aren't judged.
 */
import { KINDS, type Kind, type Resource, runsIn } from "@bergaaberg/peak";
import type { CloudRead, CloudWhat } from "./cloud.ts";
import type { TopoEntry, TopoRepo } from "./scan.ts";

export type Missing = TopoRepo & {
  file: string;
  kind: CloudWhat;
  name: string;
  /** For `objects`: the worker that should hold the class. */
  worker?: string;
  /** The environments that declare it (production first). */
  envs: string[];
};

export type Orphan = { kind: CloudWhat; name: string; /** For `objects`: the worker that holds it. */ worker?: string };

export type Drift = { missing: Missing[]; orphans: Orphan[] };

const cloudflare = (r: Resource) => !r.provider || r.provider === "cloudflare";
const pattern = (name: string) => name.endsWith("*");

/** The entry in one list that names `name`: the first exact name or prefix that matches. */
export function claimer(list: Resource[], name: string): Resource | undefined {
  return list.find((r) => (pattern(r.name) ? name.startsWith(r.name.slice(0, -1)) : r.name === name));
}

type Declared = { entry: TopoEntry; env: string; kind: Kind; list: Resource[] };

export function drift(entries: TopoEntry[], cloud: CloudRead): Drift {
  const declared: Declared[] = [];
  for (const entry of entries) {
    for (const env of ["production", ...Object.keys(entry.peak.environments ?? {}).filter((e) => e !== "production")]) {
      const runs = runsIn(entry.peak, env);
      for (const kind of KINDS) {
        const list = (runs[kind] ?? []).filter(cloudflare);
        if (list.length) declared.push({ entry, env, kind, list });
      }
    }
  }

  const missing = new Map<string, Missing>();
  const miss = (d: Declared, kind: CloudWhat, name: string, worker?: string) => {
    const { repo, full, web, blob, dir, file } = d.entry;
    const k = `${repo}\n${kind}\n${worker ?? ""}\n${name}`;
    const m = missing.get(k);
    if (m) {
      if (!m.envs.includes(d.env)) m.envs.push(d.env);
    } else missing.set(k, { repo, full, web, blob, dir, file, kind, name, worker, envs: [d.env] });
  };
  const orphans: Orphan[] = [];

  for (const kind of KINDS) {
    const have = cloud.have[kind];
    if (!have) continue;
    const there = new Set(have);
    const lists = declared.filter((d) => d.kind === kind);
    for (const d of lists) for (const r of d.list) if (!pattern(r.name) && !there.has(r.name)) miss(d, kind, r.name);
    for (const name of have) if (!lists.some((d) => claimer(d.list, name))) orphans.push({ kind, name });
  }

  // Durable Object classes, on the workers that are there and claimed.
  if (cloud.objects && cloud.have.workers) {
    for (const worker of cloud.have.workers) {
      const claims = declared.filter((d) => d.kind === "workers").flatMap((d) => {
        const r = claimer(d.list, worker);
        return r ? [{ d, r }] : [];
      });
      if (!claims.length) continue;
      const holds = new Set(cloud.objects[worker] ?? []);
      const named = new Set<string>();
      for (const { d, r } of claims) {
        for (const cls of r.objects ?? []) {
          named.add(cls);
          if (!holds.has(cls)) miss(d, "objects", cls, worker);
        }
      }
      for (const cls of [...holds].sort()) if (!named.has(cls)) orphans.push({ kind: "objects", name: cls, worker });
    }
  }

  const order = (k: CloudWhat) => (k === "objects" ? KINDS.indexOf("workers") + 0.5 : KINDS.indexOf(k));
  return {
    missing: [...missing.values()].sort((a, b) => a.repo.localeCompare(b.repo) || order(a.kind) - order(b.kind) || (a.worker ?? "").localeCompare(b.worker ?? "") || a.name.localeCompare(b.name)),
    orphans: orphans.sort((a, b) => order(a.kind) - order(b.kind) || (a.worker ?? "").localeCompare(b.worker ?? "") || a.name.localeCompare(b.name)),
  };
}

/** What each kind is called on Cloudflare, for people. */
export const CF_NAMES: Record<CloudWhat, [one: string, many: string]> = {
  workers: ["worker", "Workers"],
  objects: ["Durable Object class", "Durable Object classes"],
  databases: ["D1 database", "D1 databases"],
  stores: ["KV namespace", "KV namespaces"],
  buckets: ["R2 bucket", "R2 buckets"],
  queues: ["queue", "Queues"],
};

/** Some file declares something to run on Cloudflare (so drift is worth setting up). */
export const declaresCloudflare = (entries: TopoEntry[]) =>
  entries.some((e) => ["production", ...Object.keys(e.peak.environments ?? {})].some((env) => KINDS.some((k) => (runsIn(e.peak, env)[k] ?? []).some(cloudflare))));
