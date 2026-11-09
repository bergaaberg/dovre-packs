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
  "dovre/kept.ts": 2,
  "dovre/owners.ts": 2,
  "dovre/spawn.ts": 1,
};

test("packs import core only through its SDK, but for the reach-ins listed", () => {
  assertDoors(join(import.meta.dirname, "..", "packs"), REACH_INS);
});
