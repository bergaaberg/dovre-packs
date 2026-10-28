/**
 * Fix PRs (dovre-packs#68 step 5): the peak.yaml edits Topo proposes through core's
 * `ctx.forge().propose()` (dovre#203), behind a Confirm of kind `topo.peak-pr`. Each starts from
 * the file on the default branch and edits it as a yaml Document, so comments and layout stay:
 * - **claim** an orphan: its name added under `runs` (production) in the repo it looks like; a
 *   Durable Object class added to `objects` of the worker entry that names its worker;
 * - **drop** a missing entry: removed from every list that declares it (production's runs, an
 *   environment's own runs, `health.workers`), and lists left empty go too;
 * - **start** a peak.yaml for a repo without one: name, description, tier and owner from the form,
 *   and the worker (with its Durable Object classes) from the repo's wrangler config, if any.
 * An edit that can't be made plainly throws why, and nothing is proposed.
 */
import { Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { SCHEMA_URL, SPEC_URL, TIERS } from "@bergaaberg/peak";
import type { Proposed } from "dovre/actions/propose.ts";
import type { PackForge } from "dovre/packs/types.ts";
import type { CloudWhat } from "./cloud.ts";
import { CF_NAMES, type Drift } from "./drift.ts";
import type { TopoEntry, TopoRepo } from "./scan.ts";

/** What a claim or a drop is about. */
export type Thing = { kind: CloudWhat; name: string; /** For `objects`: the worker holding the class. */ worker?: string };

export const WRITE = "peak-pr";
export const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] as const;

/** As the files are written: `[a, b]`, not `[ a, b ]`. */
const OUT = { flowCollectionPadding: false } as const;
const NAME = /^[\w.*-]{1,100}$/;

function docOf(text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`It doesn't parse: ${doc.errors[0]!.message.split("\n")[0]}`);
  if (!isMap(doc.contents)) throw new Error("It isn't a mapping.");
  return doc;
}

const nameOf = (item: unknown): string | undefined => (isScalar(item) ? String(item.value) : isMap(item) ? String(item.get("name") ?? "") : undefined);

/** The production `runs.<kind>` list, made when there's none. */
function runsList(doc: Document, kind: string): YAMLSeq {
  const list = doc.getIn(["runs", kind]);
  if (isSeq(list)) return list;
  if (list !== undefined) throw new Error(`runs.${kind} isn't a list.`);
  if (doc.get("runs") !== undefined && !isMap(doc.get("runs"))) throw new Error("runs isn't a mapping.");
  const seq = doc.createNode([]) as YAMLSeq;
  seq.flow = true;
  doc.setIn(["runs", kind], seq);
  return seq;
}

/** The text with the orphan claimed. */
export function claimText(text: string, t: Thing): string {
  if (!NAME.test(t.name) || t.name.endsWith("*")) throw new Error("Not a name Topo can add.");
  const doc = docOf(text);
  if (t.kind === "objects") {
    if (!t.worker) throw new Error("No worker for the class.");
    const workers = doc.getIn(["runs", "workers"]);
    const i = isSeq(workers) ? workers.items.findIndex((x) => nameOf(x) === t.worker) : -1;
    if (i < 0) throw new Error(`runs.workers doesn't name ${t.worker} itself.`);
    const list = workers as YAMLSeq;
    let item = list.items[i];
    if (isScalar(item)) {
      item = doc.createNode({ name: t.worker, objects: [] }) as YAMLMap;
      list.items[i] = item;
    }
    const m = item as YAMLMap;
    let objects: unknown = m.get("objects", true);
    if (objects === undefined) {
      const seq = doc.createNode([]) as YAMLSeq;
      seq.flow = true;
      m.set("objects", seq);
      objects = seq;
    }
    if (!isSeq(objects)) throw new Error(`${t.worker}'s objects isn't a list.`);
    if (objects.items.some((x) => nameOf(x) === t.name)) throw new Error(`It lists ${t.name} already.`);
    objects.add(doc.createNode(t.name));
    return doc.toString(OUT);
  }
  const list = runsList(doc, t.kind);
  if (list.items.some((x) => nameOf(x) === t.name)) throw new Error(`runs.${t.kind} lists ${t.name} already.`);
  list.add(doc.createNode(t.name));
  return doc.toString(OUT);
}

/** Takes `name` out of a list; true when it was there. A list left empty is deleted from its parent. */
function takeOut(doc: Document, path: (string | number)[], name: string, inner?: (item: YAMLMap) => boolean): boolean {
  const list = doc.getIn(path, true);
  if (!isSeq(list)) return false;
  let hit = false;
  for (let i = list.items.length - 1; i >= 0; i--) {
    const item = list.items[i];
    if (inner) {
      if (isMap(item) && nameOf(item) === name && inner(item)) hit = true;
    } else if (nameOf(item) === name) {
      list.items.splice(i, 1);
      hit = true;
    }
  }
  if (!list.items.length) doc.deleteIn(path);
  return hit;
}

/** Deletes a mapping that's left empty, from the deepest up. */
function prune(doc: Document, path: (string | number)[]) {
  for (let n = path.length; n > 0; n--) {
    const at = path.slice(0, n);
    const v = doc.getIn(at, true);
    if (isMap(v) && !v.items.length) doc.deleteIn(at);
    else break;
  }
}

/** The text with the missing thing taken out of every list that declares it. */
export function dropText(text: string, t: Thing): string {
  const doc = docOf(text);
  const envs = isMap(doc.get("environments")) ? (doc.get("environments") as YAMLMap).items.map((p) => String(isScalar(p.key) ? p.key.value : p.key)) : [];
  const places: (string | number)[][] = [["runs"], ...envs.map((e) => ["environments", e, "runs"])];
  let hit = false;
  for (const at of places) {
    if (t.kind === "objects") {
      hit = takeOut(doc, [...at, "workers"], t.worker ?? "", (m) => {
        const before = isSeq(m.get("objects")) ? (m.get("objects") as YAMLSeq).items.length : 0;
        takeOutOf(m, t.name);
        return before !== (isSeq(m.get("objects")) ? (m.get("objects") as YAMLSeq).items.length : 0);
      }) || hit;
    } else hit = takeOut(doc, [...at, t.kind], t.name) || hit;
    prune(doc, at);
    if (at.length === 3) prune(doc, at.slice(0, 2));
  }
  if (t.kind === "workers") {
    hit = takeOut(doc, ["health", "workers"], t.name) || hit;
    prune(doc, ["health"]);
  }
  prune(doc, ["environments"]);
  if (!hit) throw new Error(`It doesn't declare ${t.name} anywhere Topo can take it out.`);
  return doc.toString(OUT);
}

/** Takes a class out of a worker entry's objects, deleting the key when it's left empty. */
function takeOutOf(m: YAMLMap, cls: string) {
  const objects = m.get("objects");
  if (!isSeq(objects)) return;
  objects.items = objects.items.filter((x) => nameOf(x) !== cls);
  if (!objects.items.length) m.delete("objects");
}

/** What a repo's wrangler config says it deploys: the worker's name and the Durable Object classes it defines. */
export function wranglerRuns(file: string, text: string): { worker?: string; objects: string[] } {
  const ok = (s: unknown) => (typeof s === "string" && NAME.test(s) && !s.includes("*") ? s : undefined);
  if (file.endsWith(".toml")) {
    const top = text.split(/^\s*\[/m)[0] ?? "";
    const worker = ok(/^\s*name\s*=\s*["']([^"']+)["']/m.exec(top)?.[1]);
    const objects: string[] = [];
    for (const block of text.split(/^\s*\[\[\s*durable_objects\.bindings\s*\]\]\s*$/m).slice(1)) {
      const body = block.split(/^\s*\[/m)[0] ?? "";
      const cls = ok(/^\s*class_name\s*=\s*["']([^"']+)["']/m.exec(body)?.[1]);
      if (cls && !/^\s*script_name\s*=/m.test(body) && !objects.includes(cls)) objects.push(cls);
    }
    return { worker, objects };
  }
  let j: any;
  try {
    // JSONC: comments and trailing commas out, strings kept.
    j = JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return { objects: [] };
  }
  const objects: string[] = [];
  for (const b of Array.isArray(j?.durable_objects?.bindings) ? j.durable_objects.bindings : []) {
    const cls = ok(b?.class_name);
    if (cls && !b.script_name && !objects.includes(cls)) objects.push(cls);
  }
  return { worker: ok(j?.name), objects };
}

/** The first plain paragraph of a README (no headings, badges or HTML), as one sentence-ish line. */
export function readmeLine(text: string | undefined): string {
  for (const para of (text ?? "").split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p || /^(#|<|!\[|\[!\[|---|```|\|)/.test(p)) continue;
    return p.replace(/\s+/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").slice(0, 200);
  }
  return "";
}

export type Start = { name: string; description: string; tier: string; owner: string; wrangler?: { worker?: string; objects: string[] } };

/** A new peak.yaml. */
export function startText(s: Start): string {
  const name = s.name.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  if (!name) throw new Error("It needs a name.");
  const top: Record<string, unknown> = { name };
  const description = s.description.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (description) top.description = description;
  top.tier = (TIERS as readonly string[]).includes(s.tier) ? s.tier : "active";
  const owner = s.owner.trim();
  if (owner) {
    if (!/^@?[\w.-]{1,100}(\/[\w.-]{1,100})?$/.test(owner)) throw new Error("The owner is a handle: @user or @org/team.");
    top.owner = owner.startsWith("@") ? owner : `@${owner}`;
  }
  const w = s.wrangler;
  if (w?.worker) top.runs = { workers: [w.objects.length ? { name: w.worker, objects: w.objects } : w.worker] };
  const doc = new Document(top);
  const runs = doc.getIn(["runs", "workers"], true);
  if (isSeq(runs) && !w?.objects.length) runs.flow = true;
  return `# yaml-language-server: $schema=${SCHEMA_URL}\n${doc.toString(OUT)}`;
}

/** What Topo knows when a fix is asked for: the files, drift now, and the repos without a file. */
export type FixState = { entries: TopoEntry[]; drift?: Drift; bare: TopoRepo[] };
export type FixDone = { ok: true; text: string; url: string; key: string } | { ok: false; text: string; key: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const same = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Carries out a fix PR from the form (/topo/pr). It checks the form against what Topo knows now
 * (the orphan is still one, the missing thing is still missing, the repo still has no file), edits
 * the file the forge has on the default branch, and asks core to propose it, which reads it again.
 */
export async function runFix(form: Record<string, unknown>, state: FixState, forge: PackForge | undefined): Promise<FixDone> {
  const what = str(form.what);
  const repo = str(form.repo);
  const key = repo.toLowerCase();
  const no = (text: string): FixDone => ({ ok: false, text, key });
  if (!forge?.propose || !forge.file) return no("This forge can't open PRs for Topo.");
  const t: Thing = { kind: str(form.kind) as CloudWhat, name: str(form.name), ...(str(form.worker) ? { worker: str(form.worker) } : {}) };
  const one = CF_NAMES[t.kind]?.[0];
  try {
    if (what === "start") {
      if (!state.bare.some((r) => same(r.full, repo))) return no(`${repo} isn't a followed repo without a peak.yaml now.`);
      let wrangler: Start["wrangler"];
      for (const file of WRANGLER_FILES) {
        const text = await forge.file(repo, file);
        if (text !== undefined) {
          wrangler = wranglerRuns(file, text);
          break;
        }
      }
      const description = str(form.description).trim() || readmeLine(await forge.file(repo, "README.md").catch(() => undefined));
      const text = startText({ name: str(form.name), description, tier: str(form.tier), owner: str(form.owner), ...(wrangler ? { wrangler } : {}) });
      return said(key, await forge.propose({ kind: WRITE, repo, path: "peak.yaml", text, expect: null, title: "Add peak.yaml", body: `A first peak.yaml (${SPEC_URL}), from Topo.${wrangler?.worker ? ` The worker is \`${wrangler.worker}\`, from its wrangler config.` : ""} Check the tier, owner and description, and add its components and docs.` }));
    }
    if (!one) return no("Not a kind Topo knows.");
    const entry = state.entries.find((e) => same(e.full, repo));
    if (!entry) return no(`${repo} has no peak.yaml Topo can read.`);
    const label = t.kind === "objects" ? `the class ${t.name} on ${t.worker}` : `the ${one} ${t.name}`;
    if (what === "claim") {
      if (!state.drift?.orphans.some((o) => o.kind === t.kind && o.name === t.name && o.worker === t.worker)) return no(`${label} isn't unclaimed now.`);
      const before = await forge.file(repo, entry.file);
      if (before === undefined) return no(`${repo} has no ${entry.file} on its default branch.`);
      return said(key, await forge.propose({ kind: WRITE, repo, path: entry.file, text: claimText(before, t), expect: before, title: `peak.yaml: claim ${label}`, body: `It's on Cloudflare, and no peak.yaml listed it. Its name looks like this repo's, so Topo adds it here. If it's left over, close this and delete it on Cloudflare instead.` }));
    }
    if (what === "drop") {
      if (!state.drift?.missing.some((m) => same(m.full, repo) && m.kind === t.kind && m.name === t.name && m.worker === t.worker)) return no(`${label} isn't missing now.`);
      const before = await forge.file(repo, entry.file);
      if (before === undefined) return no(`${repo} has no ${entry.file} on its default branch.`);
      return said(key, await forge.propose({ kind: WRITE, repo, path: entry.file, text: dropText(before, t), expect: before, title: `peak.yaml: take out ${label}`, body: `${entry.file} declares it, and it isn't on Cloudflare. If it should be there, close this and deploy it instead.` }));
    }
    return no("Not a fix Topo knows.");
  } catch (e) {
    return no(`Couldn't make the PR: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
}

const said = (key: string, r: Proposed): FixDone => (r.ok ? { ok: true, text: `Opened #${r.number}.`, url: r.url, key } : { ok: false, text: `No PR: ${r.error}`, key });
