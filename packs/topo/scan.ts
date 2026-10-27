/**
 * Topo scanner: finds and parses each checkout's peak.yaml (the format and parser live in
 * bergaaberg/peak) right under the code folder. range.yaml, the format's old name, is not read (dovre#138).
 * The forge's copies are read by forge.ts; catalog.ts puts the two together.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "yaml";
import { FILES, parsePeak, type Peak } from "@bergaaberg/peak";

/** Where a repo is: a checkout here, the forge, or both. */
export type TopoRepo = {
  /** The checkout's folder name, or the repo's own name on the forge. */
  repo: string;
  /** The checkout (local): /code and /agents/new link to it. */
  dir?: string;
  /** `owner/name` on the forge. */
  full?: string;
  /** The repo's page on the forge. */
  web?: string;
  /** A file's page on the forge is this followed by its path (the default branch). */
  blob?: string;
};

export type TopoEntry = TopoRepo & {
  peak: Peak;
  /** The file it came from: peak.yaml or peak.yml. */
  file: string;
  /** What the parser ignored (unknown keys and the like). */
  warnings?: string[];
};

/** A repo whose file can't be used, and why (every problem, not just the first). */
export type TopoProblem = TopoRepo & { file: string; problems: string[] };

/** Reads one file's text: a usable peak (with its warnings), or every problem. */
export function parseText(text: string): ReturnType<typeof parsePeak> {
  try {
    return parsePeak(yaml.parse(text));
  } catch (e) {
    return { problems: [`Not valid YAML: ${String((e as Error)?.message ?? e).split("\n")[0]}`], warnings: [] };
  }
}

export class TopoScanner {
  private codeDir: string;
  private cachedAt = 0;
  private scanned = false;
  private cache = new Map<string, { peak: Peak; file: string; warnings: string[] }>();
  private broken: TopoProblem[] = [];
  /** The folder's own name by its lowercased one: links (/code/:dir, /agents/new) need it exactly. */
  private folders = new Map<string, string>();
  private ttlMs: number;
  private now: () => number;

  constructor(codeDir: string, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.codeDir = codeDir;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  scan(force = false): void {
    const now = this.now();
    // The TTL holds for an empty cache too (a code folder with no manifests yet): without it,
    // every call rescans the folder synchronously, and /topo's filter and every PR card call
    // this (WP-R6).
    if (!force && this.scanned && now - this.cachedAt < this.ttlMs) return;

    this.cache.clear();
    this.folders.clear();
    this.broken = [];
    this.cachedAt = now;
    this.scanned = true;

    let names: string[];
    try {
      names = existsSync(this.codeDir) ? readdirSync(this.codeDir) : [];
    } catch {
      return;
    }

    for (const name of names) {
      const file = FILES.find((f) => existsSync(join(this.codeDir, name, f)));
      if (!file) continue;
      let result: ReturnType<typeof parsePeak>;
      try {
        result = parseText(readFileSync(join(this.codeDir, name, file), "utf8"));
      } catch (e) {
        result = { problems: [`Can't be read: ${String((e as Error)?.message ?? e).split("\n")[0]}`], warnings: [] };
      }
      if ("peak" in result) {
        this.cache.set(name.toLowerCase(), { peak: result.peak, file, warnings: result.warnings });
        this.folders.set(name.toLowerCase(), name);
      } else this.broken.push({ repo: name, dir: join(this.codeDir, name), file, problems: result.problems });
    }
  }

  /** A checkout's folder. */
  dirOf(folder: string): string {
    return join(this.codeDir, folder);
  }

  get(repoName: string): Peak | undefined {
    this.scan();
    // "org/repo" or "repo"
    return this.cache.get(repoName.replace(/^.*\//, "").toLowerCase())?.peak;
  }

  list(): TopoEntry[] {
    this.scan();
    const out: TopoEntry[] = [];
    for (const [key, { peak, file, warnings }] of this.cache.entries()) {
      const repo = this.folders.get(key) ?? key;
      out.push({ repo, dir: join(this.codeDir, repo), peak, file, warnings });
    }
    return out.sort((a, b) => a.peak.name.localeCompare(b.peak.name));
  }

  /** Checkouts with a file Dovre can't use, by folder name. */
  problems(): TopoProblem[] {
    this.scan();
    return [...this.broken].sort((a, b) => a.repo.localeCompare(b.repo));
  }
}
