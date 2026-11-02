/**
 * Markdown (`markdown`): the docs in my checkouts (local only). A checkout is a git repo directly
 * under CODE_DIR. Only `.md` files and pictures are read, only inside the checkout (its real path:
 * a symlink out of it is refused), never in dependency or build folders, 1 MB at most each.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, sep } from "node:path";
import { slug } from "./render.ts";

export const codeDirOf = (env: Record<string, string | undefined>) => env.CODE_DIR?.trim() || join(homedir(), "Code");

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", "out", "coverage", "__pycache__"]);
export const MAX_FILE = 1024 * 1024;
const MAX_FILES = 400;
const MAX_DEPTH = 6;
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

export const isDoc = (p: string) => /\.(md|markdown)$/i.test(p);
export const imageType = (p: string) => IMAGE_TYPES[p.slice(p.lastIndexOf(".") + 1).toLowerCase()];

export function listRepos(codeDir: string): string[] {
  try {
    return readdirSync(codeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && REPO_RE.test(d.name) && existsSync(join(codeDir, d.name, ".git")))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The checkout's real path, or null when `name` isn't one. */
export function repoRoot(codeDir: string, name: string): string | null {
  if (!REPO_RE.test(name)) return null;
  const dir = join(codeDir, name);
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/** A path inside the repo as written in a URL or link (`docs/a.md`), normalised; null when it leaves the repo or looks odd. */
export function cleanPath(p: string): string | null {
  if (!p || p.length > 500 || p.includes("\0") || p.includes("\\")) return null;
  const n = posix.normalize(p.replace(/^\/+/, ""));
  if (n === "." || n.startsWith("../") || n === ".." || n.split("/").some((s) => s.startsWith(".") && s !== ".github")) return null;
  return n;
}

/** The file's real path when it's a regular file inside the repo (after symlinks), else null. */
export function inside(root: string, rel: string): string | null {
  const clean = cleanPath(rel);
  if (!clean) return null;
  try {
    const real = realpathSync(join(root, ...clean.split("/")));
    if (!real.startsWith(root + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The docs in a checkout: README first, then by path. */
export function listDocs(root: string): { files: string[]; more: boolean } {
  const files: string[] = [];
  let more = false;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH || more) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(dir, e.name), r, depth + 1);
      } else if (e.isFile() && isDoc(e.name)) {
        if (files.length >= MAX_FILES) {
          more = true;
          return;
        }
        files.push(r);
      }
    }
  };
  walk(root, "", 0);
  const rank = (f: string) => (/^readme\.md$/i.test(f) ? 0 : f.includes("/") ? 2 : 1);
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { files, more };
}

export type Read = { ok: true; text: string } | { ok: false; why: string };

export function readDoc(root: string, rel: string): Read {
  const real = inside(root, rel);
  if (!real || !isDoc(real)) return { ok: false, why: "No such Markdown file in this checkout." };
  if (statSync(real).size > MAX_FILE) return { ok: false, why: "Too big to show (1 MB at most)." };
  return { ok: true, text: readFileSync(real, "utf8") };
}

export function readImage(root: string, rel: string): { bytes: Uint8Array; type: string } | null {
  const real = inside(root, rel);
  const type = real && imageType(real);
  if (!real || !type || statSync(real).size > MAX_FILE * 5) return null;
  return { bytes: new Uint8Array(readFileSync(real)), type };
}

/** Where a doc or picture is served. */
export const docHref = (repo: string, rel: string) => `/markdown/docs/${encodeURIComponent(repo)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
export const rawHref = (repo: string, rel: string) => `/markdown/raw/${encodeURIComponent(repo)}/${rel.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Resolves a link in `from` (a doc's path in the repo): another doc opens here, a picture is served
 * from the checkout, a file that isn't there is broken. Other files (source code) stay text.
 */
export function resolver(root: string, repo: string, from: string) {
  return (href: string, kind: "link" | "image") => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
    const [pathPart, hash = ""] = href.split("#", 2) as [string, string?];
    let path: string;
    try {
      path = decodeURIComponent(pathPart.split("?")[0]!);
    } catch {
      return { broken: true as const };
    }
    if (!path) return undefined;
    const rel = cleanPath(path.startsWith("/") ? path : posix.join(posix.dirname(from), path));
    if (!rel) return { broken: true as const };
    const real = inside(root, rel);
    if (!real) {
      // A folder: its README, as GitHub shows it.
      const readme = inside(root, posix.join(rel, "README.md"));
      if (kind === "link" && readme) return { href: docHref(repo, posix.join(rel, "README.md")) };
      return { broken: true as const };
    }
    if (kind === "image") return imageType(rel) ? { href: rawHref(repo, rel) } : { broken: true as const };
    if (isDoc(rel)) return { href: docHref(repo, rel) + (hash ? `#md-${slug(hash)}` : "") };
    return undefined;
  };
}
