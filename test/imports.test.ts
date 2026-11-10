/**
 * One door (dovre#473): a pack imports core as dovre/pack.ts, and dovre/pack-testing.ts in its
 * tests. Any other dovre/… path is a reach-in into core's internals, and since Pack API 2.0
 * (dovre#484) there are none left and no list of them: a new one fails here.
 */
import { join } from "node:path";
import { test } from "node:test";
import { assertDoors } from "dovre/pack-testing.ts";

test("packs import core only through its SDK", () => {
  assertDoors(join(import.meta.dirname, "..", "packs"));
});
