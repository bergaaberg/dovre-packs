/**
 * A file's new side for the "only formatting" check (dovre#301): read at a PR's head through the
 * forge, or locally from a checkout (its working tree, or a ref). Only the new side: the engine
 * rebuilds the old one from the diff's hunks, so a PR's file costs one forge read.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { PackContext } from "dovre/pack.ts";

/** Bigger than this isn't checked. */
export const MAX_SRC = 2 * 1024 * 1024;

/** Extensions a formatter knows (engine.js's FMT; a test keeps them the same). */
export const FMT_EXTS = ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx", "json", "jsonc", "toml", "md", "markdown", "css", "scss", "less", "py", "pyi"];
export const formattable = (path: string) => FMT_EXTS.includes(/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "");

/** Extensions whose grammar has definition queries, for the outline (engine.js's EXT and gen.ts's TAGS; a test keeps them the same). */
export const OUTLINE_EXTS = ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx", "go", "rs", "py", "pyi", "cs"];
export const outlined = (path: string) => OUTLINE_EXTS.includes(/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "");

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
/** A ref as git reads one, never an option or a range. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^-]{0,199}$/;

/** A plain relative path inside a repo, or null. */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.length > 500 || /[\0\\]/.test(p) || p.startsWith("/")) return null;
  return p.split("/").every((s) => s && s !== "." && s !== "..") ? p : null;
}

export type SrcAsk = { kind: "pr"; repo: string; sha: string; path: string } | { kind: "local"; dir: string; ref: string; path: string };

/** What a /code-review/src query asks for, or null when any of it isn't plain. */
export function srcAsk(q: Record<string, string | undefined>): SrcAsk | null {
  const path = cleanPath(q.path);
  if (!path) return null;
  if (q.repo !== undefined) return REPO.test(q.repo) && SHA.test(q.sha ?? "") ? { kind: "pr", repo: q.repo, sha: q.sha!, path } : null;
  if (q.dir === undefined) return null;
  const ref = q.ref ?? "";
  return ref === "" || (REF.test(ref) && !ref.includes("..")) ? { kind: "local", dir: q.dir, ref, path } : null;
}

/** The PR button's source: the file at the PR's head. */
export const prSrc = (repo: string, sha: string, path: string) => `/code-review/src?${new URLSearchParams({ repo, sha, path })}`;

/** A working-tree file inside `root`: a plain file, not a link, not leading outside, not too big. */
function worktreeFile(root: string, path: string): string | undefined {
  const real = realpathSync(root);
  const full = join(real, path);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size > MAX_SRC) return undefined;
  if (!realpathSync(full).startsWith(real + sep)) return undefined;
  return readFileSync(full, "utf8");
}

/** The file's text, or undefined when it isn't there (or isn't one this may read). */
export async function readSrc(ctx: Pick<PackContext, "forge" | "checkout" | "run" | "hosted">, a: SrcAsk): Promise<string | undefined> {
  if (a.kind === "pr") {
    const forge = ctx.forge();
    if (!forge?.file || !forge.owns(a.repo)) return undefined;
    const text = await forge.file(a.repo, a.path, a.sha).catch(() => undefined);
    return text !== undefined && text.length <= MAX_SRC ? text : undefined;
  }
  if (ctx.hosted) return undefined;
  const root = ctx.checkout(a.dir);
  if (!root) return undefined;
  if (!a.ref) {
    try {
      return worktreeFile(root, a.path);
    } catch {
      return undefined;
    }
  }
  if (!ctx.run) return undefined;
  const r = await ctx.run("git", ["cat-file", "blob", `${a.ref}:${a.path}`], { cwd: root, timeoutMs: 10_000, maxBuffer: MAX_SRC + 1 }).catch(() => undefined);
  return r?.code === 0 && r.stdout.length <= MAX_SRC ? r.stdout : undefined;
}
