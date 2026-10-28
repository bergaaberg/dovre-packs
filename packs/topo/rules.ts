/**
 * Topo's rules (dovre-packs#68 step 3): policy and dependency checks over the peak.yaml files,
 * each on unless named in the TOPO_RULES_OFF setting. A file with problems isn't checked (its
 * coverage finding says why), and nothing here reads the cloud.
 *  - `owner`: an active repo names an owner.
 *  - `component`: in a repo with components, every `runs` entry names one.
 *  - `scratch-runs-nothing`: a scratch repo runs nothing in production.
 *  - `uses`: a used repo under a followed owner is followed, has a peak.yaml and isn't deprecated,
 *    and its `what` names one of its `runs` entries. Repos of other owners and services are skipped.
 */
import { KINDS, type Peak, type Resource, runsIn } from "@bergaaberg/peak";
import { claimer } from "./drift.ts";
import type { TopoEntry, TopoProblem, TopoRepo } from "./scan.ts";

export const RULES = [
  { id: "owner", about: "An active repo names an owner." },
  { id: "component", about: "In a repo with components, every runs entry names one." },
  { id: "scratch-runs-nothing", about: "A scratch repo runs nothing in production." },
  { id: "uses", about: "A used repo is followed, has a peak.yaml and isn't deprecated, and its what names one of its runs entries." },
] as const;

export type RuleId = (typeof RULES)[number]["id"];

/** One rule finding: which file, what's wrong, and what fixes it. */
export type Finding = TopoRepo & { file: string; rule: RuleId; why: string; fix: string };

/** The rules switched off by TOPO_RULES_OFF ("owner, component"), and any words in it that aren't rules. */
export function rulesOff(setting: string | undefined): { off: Set<RuleId>; unknown: string[] } {
  const ids = new Set<string>(RULES.map((r) => r.id));
  const off = new Set<RuleId>();
  const unknown: string[] = [];
  for (const w of (setting ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (ids.has(w)) off.add(w as RuleId);
    else if (!unknown.includes(w)) unknown.push(w);
  }
  return { off, unknown };
}

const lower = (s: string) => s.toLowerCase();
const short = (repo: string) => lower(repo.replace(/^.*\//, ""));
const envsOf = (peak: Peak) => ["production", ...Object.keys(peak.environments ?? {}).filter((e) => e !== "production")];

/** Every runs entry in every environment, once per kind and name, with the environments that list it. */
function allRuns(peak: Peak): { kind: (typeof KINDS)[number]; r: Resource; envs: string[] }[] {
  const seen = new Map<string, { kind: (typeof KINDS)[number]; r: Resource; envs: string[] }>();
  for (const env of envsOf(peak)) {
    const runs = runsIn(peak, env);
    for (const kind of KINDS) {
      for (const r of runs[kind] ?? []) {
        const k = `${kind}\n${r.name}`;
        const s = seen.get(k);
        if (s) {
          if (!s.envs.includes(env)) s.envs.push(env);
        } else seen.set(k, { kind, r, envs: [env] });
      }
    }
  }
  return [...seen.values()];
}

const named = (list: { kind: string; r: Resource }[]) => list.map(({ kind, r }) => `${kind} ${r.name}`).join(", ");

export type RulesInput = {
  entries: TopoEntry[];
  /** Files with problems: their repos are followed, but what they say can't be judged. */
  problems?: TopoProblem[];
  /** Followed repos without a peak.yaml. */
  bare?: TopoRepo[];
  /** Whose repos are followed (the forge's owners). Empty: `uses` judges nothing. */
  owners?: string[];
  /** The followed list is complete (the forge's last read worked), so "isn't followed" can be said. */
  followedKnown?: boolean;
  /** Repos the forge couldn't read this time (`owner/name`): not judged. */
  unread?: string[];
  off?: Set<RuleId>;
};

export function checkRules(o: RulesInput): Finding[] {
  const off = o.off ?? new Set<RuleId>();
  const out: Finding[] = [];
  const owners = new Set((o.owners ?? []).map(lower));
  const unread = new Set((o.unread ?? []).map(lower));
  /** A repo by `owner/name`: by its full name, else (a checkout the forge didn't name) by its own name. */
  const find = <T extends TopoRepo>(list: T[], full: string): T | undefined =>
    list.find((e) => e.full && lower(e.full) === lower(full)) ?? list.find((e) => !e.full && short(e.repo) === short(full));

  for (const e of o.entries) {
    const { peak } = e;
    const at = { repo: e.repo, full: e.full, web: e.web, blob: e.blob, dir: e.dir, file: e.file };
    const add = (rule: RuleId, why: string, fix: string) => out.push({ ...at, rule, why, fix });
    const tier = lower(peak.tier ?? "");

    if (!off.has("owner") && tier === "active" && !peak.owner) {
      add("owner", "It's active, but names no owner.", "Add owner: @user or @org/team at the top of the file.");
    }

    if (!off.has("component") && peak.components.length) {
      const bare = allRuns(peak).filter(({ r }) => !r.component);
      if (bare.length) add("component", `${bare.length === 1 ? "A runs entry names" : `${bare.length} runs entries name`} no component: ${named(bare)}.`, `Give each a component: one of ${peak.components.map((c) => c.name).join(", ")}.`);
    }

    if (!off.has("scratch-runs-nothing") && tier === "scratch") {
      const prod = runsIn(peak);
      const list = KINDS.flatMap((kind) => (prod[kind] ?? []).map((r) => ({ kind, r })));
      if (list.length) add("scratch-runs-nothing", `It's scratch, but runs ${named(list)} in production.`, "Raise its tier, or move them under an environment other than production.");
    }

    if (!off.has("uses")) {
      for (const u of peak.uses) {
        if (!("repo" in u)) continue;
        const target = u.repo;
        if (!owners.has(lower(target.split("/")[0]!)) || unread.has(lower(target))) continue;
        if (e.full && lower(e.full) === lower(target)) continue;
        const used = find(o.entries, target);
        if (!used) {
          if (find(o.problems ?? [], target)) continue;
          if (find(o.bare ?? [], target)) add("uses", `It uses ${target}, which has no peak.yaml.`, `Write a peak.yaml in ${target}, or drop it from uses.`);
          else if (o.followedKnown) add("uses", `It uses ${target}, which isn't followed (archived, renamed or gone).`, `Point uses at the repo's current name, or drop it.`);
          continue;
        }
        if (lower(used.peak.tier ?? "") === "deprecated") add("uses", `It uses ${target}, which is deprecated.`, `Move off ${target}, then drop it from uses.`);
        if (u.what) {
          const theirs = allRuns(used.peak).map(({ r }) => r);
          if (!theirs.some((r) => r.name === u.what) && !claimer(theirs, u.what)) {
            add("uses", `It uses ${u.what} from ${target}, which runs no such thing.`, theirs.length ? `Name one of its runs entries (${theirs.slice(0, 6).map((r) => r.name).join(", ")}${theirs.length > 6 ? ", …" : ""}), or drop what.` : `Add it under runs in ${target}, or drop what.`);
          }
        }
      }
    }
  }
  const order = (id: RuleId) => RULES.findIndex((r) => r.id === id);
  return out.sort((a, b) => a.repo.localeCompare(b.repo, "en", { sensitivity: "base" }) || order(a.rule) - order(b.rule));
}
