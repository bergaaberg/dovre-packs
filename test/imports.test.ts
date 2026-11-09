/**
 * One door (dovre#473): a pack imports core as dovre/pack.ts, and dovre/pack-testing.ts in its
 * tests. Any other dovre/… path is a reach-in into core's internals, which may move without notice
 * and stops being importable at Pack API 2.0 (dovre#484).
 *
 * REACH_INS is what's left, as imports per module. A new one fails here; so does a count that's
 * gone down without the list following, so it only shrinks. dovre#474 takes it to empty.
 */
import { join } from "node:path";
import { test } from "node:test";
import { assertDoors } from "dovre/pack-testing.ts";

const REACH_INS: Record<string, number> = {
  "dovre/actions/deploys.ts": 9,
  "dovre/actions/propose.ts": 2,
  "dovre/agents/workdir.ts": 1,
  "dovre/app.ts": 1,
  "dovre/db.ts": 14,
  "dovre/env.ts": 13,
  "dovre/forge/pick.ts": 1,
  "dovre/forge/types.ts": 1,
  "dovre/gather.ts": 5,
  "dovre/home/needs.ts": 3,
  "dovre/html.ts": 1,
  "dovre/kept.ts": 2,
  "dovre/live.ts": 1,
  "dovre/owners.ts": 2,
  "dovre/packs/acts.ts": 2,
  "dovre/packs/api.ts": 2,
  "dovre/packs/core/assistant/bino/context.ts": 1,
  "dovre/packs/core/issues/compose/work.ts": 1,
  "dovre/packs/core/todo/index.ts": 1,
  "dovre/packs/core/todo/store.ts": 1,
  "dovre/packs/guard.ts": 1,
  "dovre/packs/ingest.ts": 1,
  "dovre/packs/registry.ts": 1,
  "dovre/packs/testing.ts": 40,
  "dovre/packs/types.ts": 68,
  "dovre/pages/inline.ts": 1,
  "dovre/pages/later.ts": 1,
  "dovre/pages/parts.ts": 19,
  "dovre/sources/changelog.ts": 1,
  "dovre/sources/claude.ts": 1,
  "dovre/sources/files.ts": 1,
  "dovre/sources/ghe.ts": 4,
  "dovre/spawn.ts": 3,
  "dovre/strict.ts": 7,
  "dovre/tools.ts": 2,
  "dovre/ui/kit.ts": 31,
  "dovre/ui/markdown.ts": 1,
  "dovre/ui/on.js.ts": 1,
  "dovre/ui/style.ts": 3,
  "dovre/when.ts": 3,
  "dovre/worker.ts": 1,
};

test("packs import core only through its SDK, but for the reach-ins listed", () => {
  assertDoors(join(import.meta.dirname, "..", "packs"), REACH_INS);
});
