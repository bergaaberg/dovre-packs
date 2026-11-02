/**
 * HTTP client (`http`): saved requests as `.http` files in a repo's `.http/` folder, so they're
 * versioned with the code and shared with the team.
 *
 * Only checkouts directly under CODE_DIR (a real folder with .git, as core's listRepos sees them),
 * only `<repo>/.http/<name>.http` (no subfolders), and nothing reached through a symlink: the repo,
 * its .http folder and the file are each checked with lstat, and the folder's real path must be the
 * repo's own. A write re-checks the file's hash against the one it was opened with, writes a temp
 * file and renames it over (or creates the file exclusively), and never writes a secret's value.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PackContext } from "dovre/packs/types.ts";
import { agentEnvsOf, parseEnvs, parseHttp, type Envs, type Parsed } from "./model.ts";

export const DIR = ".http";
/** The JetBrains HTTP Client's environment file (public values only: secrets come from HTTP_SECRETS). */
export const ENV_FILE = "http-client.env.json";
export const MAX_FILE = 256_000;
const MAX_FILES = 200;

const REPO_RE = /^[\w.-]{1,100}$/;
export const FILE_RE = /^[A-Za-z0-9_][\w .-]{0,79}\.http$/;

export const codeDirOf = (env: Record<string, string | undefined>) => env.CODE_DIR?.trim() || join(homedir(), "Code");

const lst = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

/** A checkout directly under the code folder: a real folder (not a symlink) with .git in it. */
export function repoRoot(codeDir: string, name: unknown): string | null {
  if (typeof name !== "string" || !REPO_RE.test(name) || name === "." || name === "..") return null;
  const dir = join(codeDir, name);
  const st = lst(dir);
  return st?.isDirectory() && existsSync(join(dir, ".git")) ? dir : null;
}

/** The checkouts: core's (API 1.7, narrowed to one in a pack session), else the code folder listed here. */
export const reposOf = (ctx: Pick<PackContext, "env" | "checkouts">): string[] => (ctx.checkouts ? ctx.checkouts() : listRepos(codeDirOf(ctx.env)));

/** A checkout's folder by name: core's check (API 1.7), else repoRoot's. */
export const rootOf = (ctx: Pick<PackContext, "env" | "checkout">, name: unknown): string | null => (ctx.checkout ? ctx.checkout(name) : repoRoot(codeDirOf(ctx.env), name));

export function listRepos(codeDir: string): string[] {
  try {
    return readdirSync(codeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && REPO_RE.test(d.name) && existsSync(join(codeDir, d.name, ".git")))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  } catch {
    return [];
  }
}

/** The repo's .http folder when it's a real folder inside it (undefined: there's none yet). Throws when it isn't safe. */
function httpDir(root: string): string | undefined {
  const dir = join(root, DIR);
  const st = lst(dir);
  if (!st) return undefined;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${DIR} in that repo isn't a plain folder.`);
  if (realpathSync(dir) !== join(realpathSync(root), DIR)) throw new Error(`${DIR} in that repo leads outside it.`);
  return dir;
}

/** A file in the .http folder, by name: refused unless the name is plain and it isn't a symlink. */
function filePath(root: string, file: unknown): { dir: string | undefined; path: string; name: string } {
  if (typeof file !== "string" || !FILE_RE.test(file) || file.includes("..")) throw new Error("A request file is a plain name ending in .http.");
  const dir = httpDir(root);
  const path = join(root, DIR, file);
  const st = lst(path);
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error(`${file} isn't a plain file.`);
  return { dir, path, name: file };
}

export const STORY_RE = /^[a-z0-9][a-z0-9-]{0,59}\.story$/;
export type StoryKind = "stories" | "setups";

/** `.http/stories/<name>.story` or `.http/setups/<name>.story`: a plain folder and a plain file, or refused. */
function storyPath(root: string, kind: StoryKind, file: unknown): { path: string | undefined; name: string } {
  if (kind !== "stories" && kind !== "setups") throw new Error("Stories are in stories/ or setups/.");
  if (typeof file !== "string" || !STORY_RE.test(file)) throw new Error("A story file is a plain lower-case name ending in .story.");
  const dir = httpDir(root);
  if (!dir) return { path: undefined, name: file };
  const sub = join(dir, kind);
  const st = lst(sub);
  if (!st) return { path: undefined, name: file };
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${DIR}/${kind} isn't a plain folder.`);
  const path = join(sub, file);
  const fst = lst(path);
  if (fst && (fst.isSymbolicLink() || !fst.isFile())) throw new Error(`${file} isn't a plain file.`);
  return { path: fst ? path : undefined, name: file };
}

/** The story files of a kind, by name (none when the folder isn't there; refused when it's unsafe). */
export function listStories(root: string, kind: StoryKind): string[] {
  try {
    const dir = httpDir(root);
    if (!dir) return [];
    const sub = join(dir, kind);
    const st = lst(sub);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return [];
    return readdirSync(sub, { withFileTypes: true })
      .filter((d) => d.isFile() && STORY_RE.test(d.name))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

/** A story file's text, or undefined when it isn't there. Throws when it's unsafe or too large. */
export function readStoryFile(root: string, kind: StoryKind, file: unknown): { name: string; text: string; hash: string } | undefined {
  const f = storyPath(root, kind, file);
  if (!f.path) return undefined;
  const st = lst(f.path)!;
  if (st.size > MAX_FILE) throw new Error(`${f.name} is larger than ${MAX_FILE / 1000} kB.`);
  const text = readFileSync(f.path, "utf8");
  return { name: f.name, text, hash: hashOf(text) };
}

export const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 20);

export type FileInfo = { name: string; reqs: Parsed["reqs"]; /** The text's hash, to re-check it against before a run or a write. */ hash?: string; error?: string };

/** The repo's .http files with the requests in each (bad or large ones listed with why). */
export function listFiles(root: string): FileInfo[] {
  let dir: string | undefined;
  try {
    dir = httpDir(root);
  } catch (e) {
    return [{ name: DIR, reqs: [], error: (e as Error).message }];
  }
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && FILE_RE.test(d.name))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
  return names.map((name) => {
    try {
      const f = readFile(root, name);
      return { name, reqs: parseHttp(f.text).reqs, hash: f.hash };
    } catch (e) {
      return { name, reqs: [], error: (e as Error).message };
    }
  });
}

export function readFile(root: string, file: unknown): { name: string; text: string; hash: string } {
  const f = filePath(root, file);
  const st = lst(f.path);
  if (!st) throw new Error(`${f.name} isn't there.`);
  if (st.size > MAX_FILE) throw new Error(`${f.name} is larger than ${MAX_FILE / 1000} kB.`);
  const text = readFileSync(f.path, "utf8");
  return { name: f.name, text, hash: hashOf(text) };
}

/** The repo's .http/http-client.env.json as text, undefined when there's none or it's unsafe. */
function envText(root: string | null): string | undefined {
  if (!root) return undefined;
  try {
    const dir = httpDir(root);
    if (!dir) return undefined;
    const path = join(dir, ENV_FILE);
    const st = lst(path);
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > 64_000) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The repo's environments, {} when there's no env file or it's unsafe. */
export const repoEnvs = (root: string | null): Envs => parseEnvs(envText(root));

const git = (root: string, args: string[]) =>
  new Promise<string | undefined>((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 128_000 }, (err, out) => resolve(err ? undefined : String(out)));
  });

/**
 * The repo's environments marked `"$agent": "writes"`, read from the env file on origin's default
 * branch (origin/HEAD, else origin/main or origin/master), never the working tree: an agent that
 * commits the flag in its checkout can't open writes to itself; the flag counts once it's merged
 * (and fetched). No such branch, or no env file on it: no environment is open to agents' writes.
 */
export async function repoAgentEnvs(root: string | null): Promise<{ envs: Set<string>; branch?: string }> {
  if (!root) return { envs: new Set() };
  const head = (await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  let branch: string | undefined;
  for (const ref of [head, "origin/main", "origin/master"]) {
    if (ref && /^origin\/[\w./-]{1,200}$/.test(ref) && (await git(root, ["rev-parse", "-q", "--verify", `refs/remotes/${ref}^{commit}`])) !== undefined) {
      branch = ref;
      break;
    }
  }
  if (!branch) return { envs: new Set() };
  const text = await git(root, ["show", `refs/remotes/${branch}:${DIR}/${ENV_FILE}`]);
  return { envs: agentEnvsOf(text), branch };
}

export type Written = { ok: true; created: boolean; hash: string } | { ok: false; error: string };

/**
 * Writes `text` as the file. `expect`: the hash it had when it was opened ("" for a file that
 * must not exist yet); anything else there now refuses the write.
 */
export function writeFile(root: string, file: unknown, text: string, expect: string): Written {
  if (Buffer.byteLength(text) > MAX_FILE) return { ok: false, error: `That would make the file larger than ${MAX_FILE / 1000} kB.` };
  let f: ReturnType<typeof filePath>;
  try {
    f = filePath(root, file);
    if (!f.dir) {
      mkdirSync(join(root, DIR));
      f = filePath(root, file);
      if (!f.dir) return { ok: false, error: `Couldn't make ${DIR}.` };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const now = lst(f.path);
  if (!expect) {
    if (now) return { ok: false, error: `${f.name} is there already.` };
    try {
      writeFileSync(f.path, text, { flag: "wx" });
    } catch (e) {
      return { ok: false, error: (e as NodeJS.ErrnoException).code === "EEXIST" ? `${f.name} is there already.` : `Couldn't write ${f.name}.` };
    }
    return { ok: true, created: true, hash: hashOf(text) };
  }
  if (!now) return { ok: false, error: `${f.name} isn't there any more.` };
  let current: string;
  try {
    current = readFile(root, f.name).hash;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (current !== expect) return { ok: false, error: `${f.name} changed since it was opened.` };
  const tmp = join(f.dir, `.${f.name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, f.path);
  } catch {
    rmSync(tmp, { force: true });
    return { ok: false, error: `Couldn't write ${f.name}.` };
  }
  return { ok: true, created: false, hash: hashOf(text) };
}

/** Where a repo's OpenAPI spec is looked for, first found wins: its top, then the usual folders. */
export const SPEC_PLACES = ["", "docs/", "api/", "spec/", "openapi/", ".http/"].flatMap((d) => ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.json"].map((f) => `${d}${f}`));
const MAX_SPEC_FILE = 1_000_000;

/** The repo's OpenAPI spec, when one is in a usual place: a plain file in a plain folder (no symlinks), not too large. */
export function findSpec(root: string): { name: string; text: string } | undefined {
  for (const name of SPEC_PLACES) {
    const parts = name.split("/");
    // Each folder on the way, and the file, checked without following a link.
    let at = root;
    let safe = true;
    for (const [i, part] of parts.entries()) {
      at = join(at, part);
      const st = lst(at);
      if (!st || st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    if (lst(at)!.size > MAX_SPEC_FILE) continue;
    try {
      return { name, text: readFileSync(at, "utf8") };
    } catch {
      // Unreadable: the next place.
    }
  }
  return undefined;
}

/**
 * What under `.http/` differs from the checkout's HEAD (these paths, or all of it with "."):
 * changed, staged, untracked or ignored (an ignored file is on disk but in no commit), as git
 * names them from the repo's root (`.http/stories/x.story`; a folder ends in /). An agent's run
 * reads only committed files, so what it runs is what I can review in git (`notCommitted`).
 */
export function uncommitted(root: string, paths: string[]): Promise<{ ok: true; changed: string[] } | { ok: false; error: string }> {
  const rel = [...new Set(paths)].filter((p) => /^[\w .\/-]{1,200}$/.test(p) && !p.split("/").includes("..")).map((p) => `${DIR}/${p}`);
  if (!rel.length) return Promise.resolve({ ok: true, changed: [] });
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--", ...rel], { timeout: 10_000, maxBuffer: 1_000_000 }, (err, out, stderr) => {
      if (err) return resolve({ ok: false, error: `git couldn't tell what's committed (${String(stderr).trim().split("\n", 1)[0]!.replace(/^fatal: /, "").slice(0, 160) || "it didn't answer"})` });
      // -z: "XY path\0" each, and a rename's old path as an entry of its own (left out: it isn't on disk).
      const changed = String(out).split("\0").filter((e) => /^[ MADRCU?!]{2} ./.test(e)).map((e) => e.slice(3));
      resolve({ ok: true, changed });
    });
  });
}

/** Which of these paths (under .http/) `uncommitted` found changed: itself, or a folder it's in. */
export const notCommitted = (changed: string[], paths: string[]) => paths.filter((p) => changed.some((c) => c === `${DIR}/${p}` || (c.endsWith("/") && `${DIR}/${p}`.startsWith(c))));
