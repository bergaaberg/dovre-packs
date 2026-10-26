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
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvs, parseHttp, type Envs, type Parsed } from "./model.ts";

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

export const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 20);

export type FileInfo = { name: string; reqs: Parsed["reqs"]; error?: string };

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
      return { name, reqs: parseHttp(readFile(root, name).text).reqs };
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

/** The repo's environments (its .http/http-client.env.json), {} when there's none or it's unsafe. */
export function repoEnvs(root: string | null): Envs {
  if (!root) return {};
  try {
    const dir = httpDir(root);
    if (!dir) return {};
    const path = join(dir, ENV_FILE);
    const st = lst(path);
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > 64_000) return {};
    return parseEnvs(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
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
