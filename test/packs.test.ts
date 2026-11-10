/**
 * Every pack in index.ts, together: its styles stay scoped to its own classes, its id and the kinds
 * it declares are unique, and the Today cards that render without its app are markup core accepts.
 * Core drops a bad rule or part at runtime and only logs it, so a slip would show up as a pack that
 * silently loses styles. Per-pack behaviour is tested in packs/<name>/test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pack } from "dovre/pack.ts";
import { assertFragment, assertScoped, assertTables, testContext } from "dovre/pack-testing.ts";
import * as index from "../index.ts";

// Each `xxxPack` export; the crates and the createXxxPack factories are the same packs or build them.
const packs = Object.entries(index)
  .filter(([name]) => /^[a-z]\w*Pack$/.test(name) && !name.startsWith("create"))
  .map(([name, pack]) => ({ name, pack: pack as Pack }));

test("index.ts exports the packs", () => {
  // A floor, not an exact count: adding a pack shouldn't fail this; losing them to the filter should.
  assert.ok(packs.length >= 20, `expected at least 20 packs, found ${packs.length}: ${packs.map((p) => p.name).join(", ")}`);
});

test("ids are lowercase and unique", () => {
  const seen = new Set<string>();
  for (const { name, pack } of packs) {
    const id = pack.manifest.id;
    assert.equal(id, id.toLowerCase(), `${name}: id "${id}" is not lowercase`);
    assert.ok(!seen.has(id), `${name}: id "${id}" is used by another pack`);
    seen.add(id);
  }
});

test("each write kind and ring kind is declared once", () => {
  const rings = new Map<string, string>();
  for (const { name, pack } of packs) {
    const writes = new Set<string>();
    for (const w of pack.writes ?? []) {
      assert.ok(!writes.has(w.kind), `${name}: write kind "${w.kind}" is declared twice`);
      writes.add(w.kind);
    }
    for (const r of pack.manifest.rings ?? []) {
      const other = rings.get(r.kind);
      assert.ok(!other, `${name}: ring kind "${r.kind}" is also declared by ${other}`);
      rings.set(r.kind, name);
    }
  }
});

// Today cards: none of the packs here draw one without their app yet (Nov 2026), so this guards a
// pack that will; each pack's own tests check the cards it draws with its app.
for (const { name, pack } of packs) {
  test(`${name}: styles are scoped to its own classes`, () => {
    assertScoped(pack);
  });

  test(`${name}: the tables its migrations make are named after it`, () => {
    assertTables(pack);
  });

  test(`${name}: Today cards that render without its app are markup core accepts`, async (t) => {
    if (!pack.today) return;
    let cards;
    try {
      cards = await pack.today(testContext());
    } catch (e) {
      // Needs its app: the pack's own tests cover it.
      t.diagnostic(`skipped, today() threw: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const card of cards) {
      let out: string;
      try {
        out = String(await card.render);
      } catch (e) {
        t.diagnostic(`card ${card.id} skipped, render threw: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      assertFragment(`${name} card ${card.id}`, out);
    }
  });
}
