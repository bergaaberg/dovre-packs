/**
 * Topo's forge reads (dovre-packs#68 step 1): each followed repo's peak.yaml on its default branch,
 * through `ctx.forge().repos()` and `file()` (dovre#197). It's what Topo knows hosted, where there are
 * no checkouts, and locally about the repos that aren't checked out. A load is kept `ttlMs` and
 * reads a few repos at a time; a repo it couldn't read is named, not taken for one without a file.
 */
import { FILES } from "@bergaaberg/peak";
import type { PackForge } from "dovre/packs/types.ts";
import { parseText, type TopoEntry, type TopoProblem, type TopoRepo } from "./scan.ts";

export type ForgeRead = {
  entries: TopoEntry[];
  problems: TopoProblem[];
  /** Followed repos with no peak.yaml. */
  bare: TopoRepo[];
  /** Repos it couldn't read this time (`owner/name`). */
  failed: string[];
  /** Why it read nothing at all (the repo list failed). */
  error?: string;
  at: number;
};

/** The repo's page and a file's page on the forge. GitLab puts `/-/` before `blob`. */
export function forgeUrls(f: Pick<PackForge, "id" | "host">, full: string): Pick<TopoRepo, "web" | "blob"> {
  const host = f.host.replace(/^api\./, "");
  const web = `https://${host}/${full}`;
  return { web, blob: `${web}${f.id === "gitlab" ? "/-" : ""}/blob/HEAD/` };
}

const short = (full: string) => full.replace(/^.*\//, "");

export class ForgeCatalog {
  private forge: () => PackForge | undefined;
  private ttlMs: number;
  private now: () => number;
  private limit: number;
  private last?: ForgeRead;
  private loading?: Promise<ForgeRead | undefined>;

  constructor(o: { forge: () => PackForge | undefined; ttlMs?: number; now?: () => number; limit?: number }) {
    this.forge = o.forge;
    this.ttlMs = o.ttlMs ?? 15 * 60_000;
    this.now = o.now ?? Date.now;
    this.limit = o.limit ?? 6;
  }

  /** The forge can say which repos there are and read their files. */
  can(): boolean {
    const f = this.forge();
    return !!(f?.repos && f.file);
  }

  /** The last load, however old. */
  peek(): ForgeRead | undefined {
    return this.last;
  }

  /** The last load while it's fresh, else a new one (one at a time). Undefined when the forge can't read files. */
  load(force = false): Promise<ForgeRead | undefined> {
    if (!force && this.last && this.now() - this.last.at < this.ttlMs) return Promise.resolve(this.last);
    if (this.loading) return this.loading;
    const p = this.read().finally(() => {
      if (this.loading === p) this.loading = undefined;
    });
    return (this.loading = p);
  }

  private async read(): Promise<ForgeRead | undefined> {
    const f = this.forge();
    if (!f?.repos || !f.file) return undefined;
    const file = f.file.bind(f);
    const at = this.now();
    let repos: string[];
    try {
      repos = await f.repos();
    } catch (e) {
      // Keep what it knew; say why it's not newer.
      const error = `Couldn't list the repos on ${f.name}: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}`;
      return (this.last = { ...(this.last ?? { entries: [], problems: [], bare: [], failed: [] }), error, at });
    }
    const out: ForgeRead = { entries: [], problems: [], bare: [], failed: [], at };
    const one = async (full: string) => {
      const where: TopoRepo = { repo: short(full), full, ...forgeUrls(f, full) };
      try {
        for (const name of FILES) {
          const text = await file(full, name);
          if (text === undefined) continue;
          const r = parseText(text);
          if ("peak" in r) out.entries.push({ ...where, peak: r.peak, file: name, warnings: r.warnings });
          else out.problems.push({ ...where, file: name, problems: r.problems });
          return;
        }
        out.bare.push(where);
      } catch {
        out.failed.push(full);
      }
    };
    let next = 0;
    const worker = async () => {
      while (next < repos.length) await one(repos[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(this.limit, repos.length) }, worker));
    return (this.last = out);
  }
}
