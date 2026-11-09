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
if (git(["status", "--porcelain", "--untracked-files=no"])?.trim()) fail("the working tree has changes: commit or stash them first");

const made: string[] = [];
/** Current versions tagged here already: --push sends those origin hasn't got (a run without --push made them). */
const here: string[] = [];
for (const id of packIds()) {
  const { version } = manifestOf(id);
  if (!version) continue;
  const tag = `${id}@${version}`;
  if (git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`])) {
    here.push(tag);
    continue;
  }
  const at = git(["log", "-1", "--format=%H", `-Sversion: "${version}"`, "--", `packs/${id}/index.ts`])?.trim();
  if (!at) fail(`no commit sets ${tag}`);
  if (git(["tag", "-a", tag, at!, "-m", tag]) === null) fail(`couldn't tag ${tag}`);
  made.push(tag);
  console.log(`${tag} → ${at!.slice(0, 7)}`);
}
if (push) {
  const remote = git(["ls-remote", "--tags", "origin"]);
  if (remote === null) fail("couldn't read origin's tags");
  const there = new Set(remote!.split("\n").map((l) => l.split("\t")[1]));
  const send = [...made, ...here.filter((t) => !there.has(`refs/tags/${t}`))];
  if (!send.length) console.log("every pack's version is tagged on origin");
  else {
    if (git(["push", "origin", ...send.map((t) => `refs/tags/${t}`)]) === null) fail("push failed; the tags are made here, retry with pnpm tags --push");
    console.log(`pushed ${send.length} tag${send.length === 1 ? "" : "s"}: ${send.join(", ")}`);
  }
} else if (!made.length) console.log("every pack's version is tagged");
else console.log("pnpm tags --push to send them");
