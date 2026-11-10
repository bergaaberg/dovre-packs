/**
 * The release guard (#128): every pack has its own version and core API in its manifest, a
 * changelog whose newest entry is that version, and no change since its last tag without a bump.
 * There's no CI here, so `pnpm check` carries it. The scripts are tested on a scratch repo.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apiGap } from "dovre/pack-testing.ts";
import { PACK_API } from "dovre/pack.ts";
import { bump, changedSince, lastTag, manifestOf, packIds, problemsOf } from "../scripts/versions.ts";

test("every pack is versioned, its changelog current, and changed only with a bump", () => {
  const ids = packIds();
  assert.ok(ids.length >= 20);
  const bad = ids.flatMap((id) => problemsOf(id).map((p) => `${id}: ${p}`));
  assert.deepEqual(bad, []);
});

test("every pack runs on the core it's checked against", () => {
  for (const id of packIds()) assert.equal(apiGap(manifestOf(id).api), null, `${id} needs api ${manifestOf(id).api}, core is ${PACK_API}`);
});

test("bump: patch, minor and major", () => {
  assert.equal(bump([1, 2, 3], "patch"), "1.2.4");
  assert.equal(bump([1, 2, 3], "minor"), "1.3.0");
  assert.equal(bump([1, 2, 3], "major"), "2.0.0");
});

const sh = (cwd: string, cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
};

test("release moves Unreleased under the bumped version; tags tags it; the guard wants a bump for a change", () => {
  const root = mkdtempSync(join(tmpdir(), "packs-release-"));
  try {
    mkdirSync(join(root, "packs", "foo", "test"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    for (const f of ["versions.ts", "release.ts", "tags.ts"]) writeFileSync(join(root, "scripts", f), readFileSync(join(import.meta.dirname, "..", "scripts", f)));
    writeFileSync(join(root, "packs", "foo", "index.ts"), `export const fooPack = { manifest: { api: "1.6", version: "1.0.0", id: "foo" } };\n`);
    writeFileSync(join(root, "packs", "foo", "CHANGELOG.md"), "# foo\n\n## 1.0.0 — 2026-11-01\n\n- First.\n");
    // release.ts loads the pack through index.ts and core's check through this repo's node_modules.
    writeFileSync(join(root, "index.ts"), `export { fooPack } from "./packs/foo/index.ts";\n`);
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"));
    sh(root, "git", ["init", "-q", "-b", "main"]);
    sh(root, "git", ["add", "."]);
    sh(root, "git", ["commit", "-qm", "first"]);
    assert.deepEqual(problemsOf("foo", root), [], "untagged: nothing to compare yet");

    sh(root, "node", ["scripts/tags.ts"]);
    assert.equal(lastTag("foo", root)?.tag, "foo@1.0.0");

    writeFileSync(join(root, "packs", "foo", "test", "foo.test.ts"), "// a test only\n");
    assert.deepEqual(changedSince("foo", "foo@1.0.0", root), [], "tests don't need a release");
    writeFileSync(join(root, "packs", "foo", "data.ts"), "export const x = 1;\n");
    assert.match(problemsOf("foo", root).join(), /changed since foo@1\.0\.0 \(packs\/foo\/data\.ts\)/);

    const early = spawnSync("node", ["scripts/release.ts", "foo", "minor"], { cwd: root, encoding: "utf8" });
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /no lines under "## Unreleased"/);

    // dovre#482: a pack using something newer than its manifest's api isn't released.
    writeFileSync(join(root, "packs", "foo", "data.ts"), "export const who = (ctx: { viewer(): string }) => ctx.viewer();\n");
    const old = spawnSync("node", ["scripts/release.ts", "foo", "minor"], { cwd: root, encoding: "utf8" });
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /declares too old an api: uses ctx\.viewer \(1\.31\), declares 1\.6/);
    writeFileSync(join(root, "packs", "foo", "data.ts"), "export const x = 1;\n");

    writeFileSync(join(root, "packs", "foo", "CHANGELOG.md"), "# foo\n\n## Unreleased\n\n- Adds x.\n\n## 1.0.0 — 2026-11-01\n\n- First.\n");
    assert.match(problemsOf("foo", root).join(), /## Unreleased: run pnpm release foo/);
    sh(root, "node", ["scripts/release.ts", "foo", "minor"]);
    assert.equal(manifestOf("foo", root).version, "1.1.0");
    assert.match(readFileSync(join(root, "packs", "foo", "CHANGELOG.md"), "utf8"), /## 1\.1\.0 — \d{4}-\d\d-\d\d\n\n- Adds x\.\n\n## 1\.0\.0/);
    assert.deepEqual(problemsOf("foo", root), []);

    sh(root, "git", ["add", "."]);
    sh(root, "git", ["commit", "-qm", "foo 1.1.0"]);
    sh(root, "node", ["scripts/tags.ts"]);
    assert.equal(lastTag("foo", root)?.tag, "foo@1.1.0");
    assert.equal(sh(root, "git", ["rev-list", "-n", "1", "foo@1.1.0"]).trim(), sh(root, "git", ["rev-parse", "HEAD"]).trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
