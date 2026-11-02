/**
 * pnpm tags [--push]
 *
 * On main: tags each pack's current version as `<id>@x.y.z` at the commit that set it, when that
 * tag doesn't exist yet. --push sends the new tags to origin. Core's `packs update` follows them.
 */
import { git, manifestOf, packIds } from "./versions.ts";

const push = process.argv.includes("--push");
const fail = (why: string): never => {
  console.error(`tags: ${why}`);
  process.exit(1);
};
if (git(["rev-parse", "--abbrev-ref", "HEAD"])?.trim() !== "main") fail("run it on main, after the merge");
if (git(["status", "--porcelain"])?.trim()) fail("the working tree has changes: commit or stash them first");

const made: string[] = [];
for (const id of packIds()) {
  const { version } = manifestOf(id);
  if (!version) continue;
  const tag = `${id}@${version}`;
  if (git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`])) continue;
  const at = git(["log", "-1", "--format=%H", `-Sversion: "${version}"`, "--", `packs/${id}/index.ts`])?.trim();
  if (!at) fail(`no commit sets ${tag}`);
  if (git(["tag", "-a", tag, at!, "-m", tag]) === null) fail(`couldn't tag ${tag}`);
  made.push(tag);
  console.log(`${tag} → ${at!.slice(0, 7)}`);
}
if (!made.length) console.log("every pack's version is tagged");
else if (push) {
  if (git(["push", "origin", ...made.map((t) => `refs/tags/${t}`)]) === null) fail("push failed; the tags are made here, retry with git push --tags");
  console.log(`pushed ${made.length} tag${made.length === 1 ? "" : "s"}`);
} else console.log("pnpm tags --push to send them");
