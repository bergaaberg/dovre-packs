/** Moved: its page from the snapshot, by person, as a timeline, and in the menu and search. */
import type { Move } from "dovre/pack.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertInert, HOSTILE, packApp, testSnapshot } from "dovre/pack-testing.ts";
import { createMovementPack } from "../index.ts";

const move = (o: Partial<Move> = {}): Move => ({ at: "2026-10-22T06:00:00Z", actor: "per-hansen", bot: false, repo: "ACME/shop-api", type: "PullRequestEvent", verb: "opened", ref: "ACME/shop-api#2", title: "Fix", url: "https://acme.ghe.com/ACME/shop-api/pull/2", ...o });
const snap = (moves: Move[]) => testSnapshot({ moves: { ok: true, value: moves } });

test("the page draws the org's moves, by person and as a timeline", async () => {
  const { get } = packApp([createMovementPack()], { snapshot: snap([move({ actor: "kari", title: "Fix the login", verb: "merged" }), move({ bot: true, actor: "dependabot", title: "Bump x" })]) });
  const people = await (await get("/movement")).text();
  assert.match(people, /<title>Movement · Dovre<\/title>/);
  assert.match(people, /id="p-kari"[\s\S]*Fix the login/, "by person");
  assert.match(people, /href="\/movement"[^>]*>[\s\S]{0,200}Moved/, "in the menu");
  assert.match(await (await get("/movement?view=bots")).text(), /Bump x/, "the bots");
  assert.match(await (await get("/movement?view=nonsense")).text(), /id="p-kari"/, "an unknown view is people");
  assert.match(await (await get("/search?q=timeline")).text(), /href="\/movement"/, "search finds it");
});

test("hostile moves stay inert, and a javascript: link isn't drawn", async () => {
  const { get } = packApp([createMovementPack()], { snapshot: snap([move({ actor: HOSTILE, title: HOSTILE, url: "javascript:alert(1)" })]) });
  for (const v of ["people", "timeline"]) {
    const out = await (await get(`/movement?view=${v}`)).text();
    assertInert(`movement ${v}`, out);
    assert.doesNotMatch(out, /href="javascript:/);
  }
});
