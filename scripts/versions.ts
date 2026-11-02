/**
 * Each pack's own release (#128): `version: "x.y.z"` and `api: "M.m"` in its manifest, a line per
 * release in packs/<id>/CHANGELOG.md, and a git tag `<id>@x.y.z` on main. Shared by
 * `pnpm release`, `pnpm tags` and the guard in test/versions.test.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export type Semver = [number, number, number];
export type Level = "patch" | "minor" | "major";

const VERSION = /\bversion:\s*"(\d+\.\d+\.\d+)"/g;
const API = /\bapi:\s*"(\d+\.\d+)"/;

export const parseSemver = (v: string): Semver | null => {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
export const compareSemver = (a: Semver, b: Semver) => Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
export const bump = ([x, y, z]: Semver, level: Level): string =>
  level === "major" ? `${x + 1}.0.0` : level === "minor" ? `${x}.${y + 1}.0` : `${x}.${y}.${z + 1}`;

export function git(args: string[], cwd = ROOT): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

export const packIds = (root = ROOT) =>
  readdirSync(join(root, "packs"), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, "packs", d.name, "index.ts"))).map((d) => d.name).sort();

export const indexPath = (id: string, root = ROOT) => join(root, "packs", id, "index.ts");
export const changelogPath = (id: string, root = ROOT) => join(root, "packs", id, "CHANGELOG.md");

/** The manifest's version and api, read from index.ts; `versions` counts the version literals (must be 1). */
export function manifestOf(id: string, root = ROOT): { version: string | null; versions: number; api: string | null } {
  const src = readFileSync(indexPath(id, root), "utf8");
  const all = [...src.matchAll(VERSION)];
  return { version: all[0]?.[1] ?? null, versions: all.length, api: src.match(API)?.[1] ?? null };
}

/** The `## …` headings of a pack's CHANGELOG.md, newest first: "Unreleased" or "x.y.z". */
export function changelogHeadings(id: string, root = ROOT): string[] {
  const p = changelogPath(id, root);
  if (!existsSync(p)) return [];
  return [...readFileSync(p, "utf8").matchAll(/^## (Unreleased|\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]!);
}

/** The newest `<id>@x.y.z` tag, or null. */
export function lastTag(id: string, root = ROOT): { tag: string; version: Semver } | null {
  const tags = (git(["tag", "--list", `${id}@*`], root) ?? "").split("\n").map((t) => t.trim()).filter(Boolean);
  let best: { tag: string; version: Semver } | null = null;
  for (const tag of tags) {
    const v = parseSemver(tag.slice(id.length + 1));
    if (v && (!best || compareSemver(v, best.version) > 0)) best = { tag, version: v };
  }
  return best;
}

/** Files of a pack that differ from `tag` (committed, staged, edited or new), leaving out its tests and changelog. */
export function changedSince(id: string, tag: string, root = ROOT): string[] {
  const dir = `packs/${id}`;
  const diff = (git(["diff", "--name-only", tag, "--", dir], root) ?? "").split("\n");
  const fresh = (git(["ls-files", "--others", "--exclude-standard", "--", dir], root) ?? "").split("\n");
  return [...new Set([...diff, ...fresh].filter(Boolean))].filter((f) => !f.startsWith(`${dir}/test/`) && f !== `${dir}/CHANGELOG.md`).sort();
}

/**
 * What's wrong with a pack's release state, for the guard in `pnpm check`: its manifest's version
 * and api, its changelog's top entry, and, once it has a tag, that changes since bump the version.
 */
export function problemsOf(id: string, root = ROOT): string[] {
  const out: string[] = [];
  const m = manifestOf(id, root);
  const v = m.version ? parseSemver(m.version) : null;
  if (!v || m.versions !== 1) out.push(`index.ts needs exactly one manifest line version: "x.y.z" (found ${m.versions})`);
  if (!m.api) out.push(`index.ts needs the oldest core API it works with as a literal, api: "1.6"`);
  const heads = changelogHeadings(id, root);
  if (!heads.length) out.push("CHANGELOG.md is missing or has no ## x.y.z entry");
  else if (heads[0] === "Unreleased") out.push(`CHANGELOG.md has lines under ## Unreleased: run pnpm release ${id} patch|minor|major`);
  else if (m.version && heads[0] !== m.version) out.push(`CHANGELOG.md's newest entry is ${heads[0]}, the manifest says ${m.version}`);
  const last = lastTag(id, root);
  if (v && last) {
    if (compareSemver(v, last.version) < 0) out.push(`version ${m.version} is older than the tag ${last.tag}`);
    else if (compareSemver(v, last.version) === 0) {
      const changed = changedSince(id, last.tag, root);
      if (changed.length) out.push(`changed since ${last.tag} (${changed.join(", ")}): add a line under ## Unreleased in CHANGELOG.md, then pnpm release ${id} patch|minor|major`);
    }
  }
  return out;
}
