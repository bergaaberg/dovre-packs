/**
 * Topo's catalog: the checkouts' peak.yaml files (scan.ts) and the forge's (forge.ts) as one list,
 * and its coverage findings (dovre-packs#68 step 1). A checkout's own file wins, since it shows
 * the edits not pushed yet. A followed repo that's not checked out, or whose checkout has no file,
 * comes from the forge. Repos are matched by name, ignoring case.
 */
import type { ForgeCatalog } from "./forge.ts";
import type { TopoEntry, TopoProblem, TopoRepo, TopoScanner } from "./scan.ts";

/** One coverage finding: a followed repo without a peak.yaml, or with a file that has problems or warnings. */
export type Coverage = TopoRepo & { kind: "problems" | "warnings" | "uncataloged"; file?: string; lines: string[] };

const key = (repo: string) => repo.replace(/^.*\//, "").toLowerCase();

export class TopoCatalog {
  readonly scanner?: TopoScanner;
  readonly forge?: ForgeCatalog;
  private checkouts: () => string[];

  constructor(o: { scanner?: TopoScanner; forge?: ForgeCatalog; /** Checkout folders under the code folder. */ checkouts?: () => string[] }) {
    this.scanner = o.scanner;
    this.forge = o.forge;
    this.checkouts = o.checkouts ?? (() => []);
  }

  /** Everything, merged. Cheap enough to do per call: a list per followed repo. */
  private merged(): { entries: TopoEntry[]; problems: TopoProblem[]; bare: TopoRepo[] } {
    const remote = this.forge?.peek();
    const local = this.scanner?.list() ?? [];
    const localProblems = this.scanner?.problems() ?? [];
    const folders = new Map(this.checkouts().map((f) => [key(f), f]));
    for (const e of [...local, ...localProblems]) folders.set(key(e.repo), e.repo);

    // The forge's side of each repo (its name and pages), for a checkout of it too.
    const onForge = new Map<string, TopoRepo>();
    for (const r of [...(remote?.entries ?? []), ...(remote?.problems ?? []), ...(remote?.bare ?? [])]) {
      if (!onForge.has(key(r.repo))) onForge.set(key(r.repo), { repo: r.repo, full: r.full, web: r.web, blob: r.blob });
    }
    const withForge = <T extends TopoRepo>(r: T): T => ({ ...onForge.get(key(r.repo)), ...r });
    /** A forge result, pointed at the checkout when there's one (so /code and agents work). */
    const withCheckout = <T extends TopoRepo>(r: T): T => {
      const folder = folders.get(key(r.repo));
      const dir = folder ? this.scanner?.dirOf(folder) : undefined;
      return folder ? { ...r, repo: folder, ...(dir ? { dir } : {}) } : r;
    };

    const fromCheckout = new Set([...local, ...localProblems].map((e) => key(e.repo)));
    const fromForge = (r: TopoRepo) => !fromCheckout.has(key(r.repo));
    const entries = [...local.map(withForge), ...(remote?.entries ?? []).filter(fromForge).map(withCheckout)];
    const problems = [...localProblems.map(withForge), ...(remote?.problems ?? []).filter(fromForge).map(withCheckout)];

    const known = new Set([...entries, ...problems].map((e) => key(e.repo)));
    const bare: TopoRepo[] = [];
    for (const [k, folder] of folders) {
      if (!known.has(k)) bare.push(withForge({ repo: folder, ...(this.scanner ? { dir: this.scanner.dirOf(folder) } : {}) }));
    }
    for (const r of remote?.bare ?? []) if (!known.has(key(r.repo)) && !folders.has(key(r.repo))) bare.push(r);

    return {
      entries: entries.sort((a, b) => a.peak.name.localeCompare(b.peak.name)),
      problems: problems.sort((a, b) => a.repo.localeCompare(b.repo)),
      bare: bare.sort((a, b) => a.repo.localeCompare(b.repo, "en", { sensitivity: "base" })),
    };
  }

  list(): TopoEntry[] {
    return this.merged().entries;
  }

  /** A repo's entry, by `owner/name` or its name (ignoring case). */
  entry(repo: string): TopoEntry | undefined {
    const entries = this.list();
    const lower = repo.toLowerCase();
    return (repo.includes("/") ? entries.find((e) => e.full?.toLowerCase() === lower) : undefined) ?? entries.find((e) => key(e.repo) === key(repo));
  }

  get(repo: string) {
    return this.entry(repo)?.peak;
  }

  problems(): TopoProblem[] {
    return this.merged().problems;
  }

  /** Followed repos and checkouts without a peak.yaml. */
  bare(): TopoRepo[] {
    return this.merged().bare;
  }

  /** What the forge couldn't tell this time: why nothing, or which repos. */
  unread(): { error?: string; failed: string[] } {
    const r = this.forge?.peek();
    return { error: r?.error, failed: r?.failed ?? [] };
  }

  /** The coverage findings: files with problems, then files with warnings, then repos without a file. */
  coverage(): Coverage[] {
    const { entries, problems, bare } = this.merged();
    return [
      ...problems.map(({ problems: lines, ...r }): Coverage => ({ ...r, kind: "problems", lines })),
      ...entries
        .filter((e) => e.warnings?.length)
        .sort((a, b) => a.repo.localeCompare(b.repo))
        .map(({ peak: _p, warnings, ...r }): Coverage => ({ ...r, kind: "warnings", lines: warnings! })),
      ...bare.map((r): Coverage => ({ ...r, kind: "uncataloged", lines: [] })),
    ];
  }
}
