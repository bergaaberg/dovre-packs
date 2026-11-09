/**
 * A PR's Storybook built here (#166), for repos whose CI publishes none for a PR. In the repo's
 * checkout right under CODE_DIR, the commit is fetched into a build worktree of Dovre's own (one per
 * repo, in Dovre's data folder: the checkout's branch and files stay as they are), installed from
 * its lockfile and built with `storybook build` into `<dir>/out/<repo>/<sha>`. One build per commit,
 * the newest few kept; one build at a time per repo. Programs start without a shell, off the main
 * thread (src/spawn.ts).
 *
 * What it builds is the PR's own code: install scripts and the build run as me, as checking the
 * branch out would. The result is served apart from Dovre (serve.ts), never from Dovre's origin.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOff } from "dovre/spawn.ts";
import type { Tool } from "dovre/tools.ts";

export type BuildState =
  | { status: "none" }
  | { status: "queued" }
  | { status: "building"; step: string; startedAt: number }
  | { status: "ready" }
  | { status: "failed"; why: string; tail: string; at: number };

/** Runs a program to the end (never a shell): its exit code and output. */
export type Run = (tool: Tool, args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; out: string }>;

export type Builds = {
  state(repo: string, sha: string): BuildState;
  /** Queues the builds of these commits that aren't built or building; true when one was queued. */
  start(repo: string, shas: string[]): boolean;
  /** Where a built commit is served, on the origin given (serve.ts). */
  url(origin: string, repo: string, sha: string): string;
  /** The folder builds are served from. */
  outDir: string;
};

export type BuildTools = { git?: Tool; pnpm?: Tool; npm?: Tool };

/** How many builds per repo are kept. */
export const KEEP = 6;
export const SHA = /^[0-9a-f]{40}$/;

/** A repo as a folder name: `acme__web`. */
export const slugOf = (repo: string) => repo.toLowerCase().replace(/[^a-z0-9.-]+/g, "__");

export const runTool: Run = async (tool, args, cwd, timeoutMs) => {
  const r = await runOff(tool.bin, [...tool.pre, ...args], { cwd, timeoutMs, maxBuffer: 16 << 20, env: { CI: "1", GIT_TERMINAL_PROMPT: "0", STORYBOOK_DISABLE_TELEMETRY: "1" } }).catch((e: Error) => ({ code: 1, stdout: "", stderr: String(e.message) }));
  return { code: r.code ?? 1, out: `${r.stdout}${r.stderr}` };
};

/** The last lines of a program's output, for the page when it fails. */
export const tailOf = (out: string, n = 25) => out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd().split(/\r?\n/).slice(-n).join("\n").slice(-4000);

/** How to install a checkout, from the lockfile it has; undefined when it has none this knows. */
export function installer(tree: string, tools: BuildTools): { tool: Tool; install: string[]; exec: string[] } | { why: string } {
  if (existsSync(join(tree, "pnpm-lock.yaml"))) return tools.pnpm ? { tool: tools.pnpm, install: ["install", "--frozen-lockfile"], exec: ["exec"] } : { why: "It uses pnpm, and pnpm isn't on this machine's PATH." };
  if (existsSync(join(tree, "package-lock.json"))) return tools.npm ? { tool: tools.npm, install: ["ci"], exec: ["exec", "--"] } : { why: "It uses npm, and npm isn't on this machine's PATH." };
  return { why: "No pnpm-lock.yaml or package-lock.json at the repo's root." };
}

export function createBuilds(o: {
  dir: string;
  tools: BuildTools;
  /** The repo's checkout right under CODE_DIR (a full path), or undefined. */
  checkout(repo: string): string | undefined;
  onChange(): void;
  run?: Run;
  log?(line: string): void;
}): Builds {
  const run = o.run ?? runTool;
  // Windows: deep component folders pass 260 characters inside the build worktree.
  const git = (args: string[], cwd: string, ms: number) => run(o.tools.git!, ["-c", "core.longpaths=true", ...args], cwd, ms);
  const outDir = resolve(o.dir, "out");
  const treeDir = resolve(o.dir, "trees");
  const states = new Map<string, BuildState>();
  const queues = new Map<string, Promise<void>>();
  const key = (repo: string, sha: string) => `${slugOf(repo)}/${sha}`;
  const done = (repo: string, sha: string) => existsSync(join(outDir, slugOf(repo), sha));
  const set = (repo: string, sha: string, s: BuildState) => {
    states.set(key(repo, sha), s);
    o.onChange();
  };

  /** Keeps the newest KEEP builds of a repo. */
  function prune(repo: string) {
    const dir = join(outDir, slugOf(repo));
    try {
      const builds = readdirSync(dir)
        .filter((f) => SHA.test(f))
        .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const b of builds.slice(KEEP)) rmSync(join(dir, b.f), { recursive: true, force: true });
    } catch {}
  }

  async function build(repo: string, sha: string) {
    const startedAt = Date.now();
    const step = (s: string) => set(repo, sha, { status: "building", step: s, startedAt });
    const fail = (why: string, out = "") => {
      o.log?.(`storybook: ${repo}@${sha.slice(0, 7)} failed: ${why}`);
      set(repo, sha, { status: "failed", why, tail: tailOf(out), at: Date.now() });
    };
    if (!o.tools.git) return fail("git isn't on this machine's PATH.");
    const checkout = o.checkout(repo);
    if (!checkout) return fail(`There's no checkout of ${repo} right under the code folder.`);
    step("Fetching the commit");
    const fetched = await git(["fetch", "--no-tags", "--quiet", "origin", sha], checkout, 5 * 60_000);
    if (fetched.code) return fail("git fetch failed.", fetched.out);
    const tree = join(treeDir, slugOf(repo));
    mkdirSync(treeDir, { recursive: true });
    if (existsSync(join(tree, ".git"))) {
      const moved = await git(["checkout", "--detach", "--force", "--quiet", sha], tree, 2 * 60_000);
      if (moved.code) return fail("git checkout failed in the build worktree.", moved.out);
      await git(["clean", "-fdq"], tree, 2 * 60_000);
    } else {
      rmSync(tree, { recursive: true, force: true });
      await git(["worktree", "prune"], checkout, 60_000);
      const added = await git(["worktree", "add", "--detach", "--quiet", tree, sha], checkout, 5 * 60_000);
      if (added.code) {
        // Half made: gone, so the next build starts it again rather than using it.
        rmSync(tree, { recursive: true, force: true });
        await git(["worktree", "prune"], checkout, 60_000);
        return fail("git worktree add failed.", added.out);
      }
    }
    const how = installer(tree, o.tools);
    if ("why" in how) return fail(how.why);
    step("Installing packages");
    const installed = await run(how.tool, how.install, tree, 20 * 60_000);
    if (installed.code) return fail("Installing packages failed.", installed.out);
    step("Building the Storybook");
    const dest = join(outDir, slugOf(repo), sha);
    const tmp = `${dest}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(outDir, slugOf(repo)), { recursive: true });
    const built = await run(how.tool, [...how.exec, "storybook", "build", "--output-dir", tmp, "--quiet", "--disable-telemetry"], tree, 30 * 60_000);
    if (built.code || !existsSync(join(tmp, "iframe.html"))) {
      rmSync(tmp, { recursive: true, force: true });
      return fail(built.code ? "storybook build failed." : "storybook build made no iframe.html.", built.out);
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    prune(repo);
    o.log?.(`storybook: built ${repo}@${sha.slice(0, 7)} in ${Math.round((Date.now() - startedAt) / 1000)} s`);
    set(repo, sha, { status: "ready" });
  }

  return {
    outDir,
    state(repo, sha) {
      const s = states.get(key(repo, sha));
      if (s && s.status !== "ready") return s;
      return done(repo, sha) ? { status: "ready" } : { status: "none" };
    },
    start(repo, shas) {
      let queued = false;
      for (const sha of shas) {
        if (!SHA.test(sha) || done(repo, sha)) continue;
        const now = states.get(key(repo, sha))?.status;
        if (now === "queued" || now === "building") continue;
        set(repo, sha, { status: "queued" });
        const slug = slugOf(repo);
        const next = (queues.get(slug) ?? Promise.resolve()).then(() =>
          build(repo, sha).catch((e) => set(repo, sha, { status: "failed", why: String((e as Error)?.message ?? e).slice(0, 300), tail: "", at: Date.now() })),
        );
        queues.set(slug, next);
        queued = true;
      }
      return queued;
    },
    url: (origin, repo, sha) => `${origin}/${slugOf(repo)}/${sha}/`,
  };
}
