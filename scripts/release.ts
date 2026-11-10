/**
 * pnpm release <id> [patch|minor|major]   (default patch)
 *
 * Moves the `## Unreleased` lines in packs/<id>/CHANGELOG.md under the new version and writes that
 * version into the pack's manifest. It doesn't commit or tag: the release goes in your PR, and
 * `pnpm tags --push` on main tags it after the merge (squash merges would lose a branch tag).
 * A pack using something newer than its manifest's `api` isn't released (dovre#482): raise `api` first.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Pack } from "dovre/pack.ts";
import { apiOver } from "dovre/pack-testing.ts";
import * as packs from "../index.ts";
import { bump, changelogPath, indexPath, type Level, manifestOf, packIds, parseSemver } from "./versions.ts";

const [id, level = "patch"] = process.argv.slice(2);
const fail = (why: string): never => {
  console.error(`release: ${why}`);
  process.exit(1);
};
if (!id || !packIds().includes(id)) fail(`usage: pnpm release <id> [patch|minor|major]; packs: ${packIds().join(", ")}`);
if (!["patch", "minor", "major"].includes(level)) fail(`level is patch, minor or major, not ${level}`);

const m = manifestOf(id!);
const now = m.version ? parseSemver(m.version) : null;
if (!now || m.versions !== 1) fail(`packs/${id}/index.ts needs exactly one manifest line version: "x.y.z"`);
const next = bump(now!, level as Level);

const pack = (Object.values(packs) as Partial<Pack>[]).find((p) => p?.manifest?.id === id);
if (!pack) fail(`index.ts exports no pack with the id ${id}`);
const over = apiOver(pack as Pack, dirname(indexPath(id!)));
if (over.length) fail(`packs/${id}/index.ts declares too old an api: ${over.join("; ")}`);

const log = readFileSync(changelogPath(id!), "utf8");
const at = log.match(/^## Unreleased[^\n]*\n([^]*?)(?=^## |(?![^]))/m);
if (!at || !/^\s*[-*] \S/m.test(at[1]!)) fail(`packs/${id}/CHANGELOG.md has no lines under "## Unreleased": add what changed first`);
const day = new Date().toISOString().slice(0, 10);
writeFileSync(changelogPath(id!), log.replace(/^## Unreleased[^\n]*$/m, `## ${next} — ${day}`));

const index = readFileSync(indexPath(id!), "utf8");
writeFileSync(indexPath(id!), index.replace(/\bversion:\s*"\d+\.\d+\.\d+"/, `version: "${next}"`));
console.log(`${id} ${m.version} → ${next}. Commit it with the change; after the merge, pnpm tags --push on main tags ${id}@${next}.`);
