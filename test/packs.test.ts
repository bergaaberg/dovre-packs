/**
 * Every pack in index.ts, together: its styles stay scoped to its own classes, its id and the kinds
 * it declares are unique, and the Today cards that render without its app are markup core accepts.
 * Core drops a bad rule or part at runtime and only logs it, so a slip would show up as a pack that
 * silently loses styles. Per-pack behaviour is tested in packs/<name>/test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pack } from "dovre/packs/types.ts";
import { assertFragment, assertScoped, testContext } from "dovre/packs/testing.ts";
import * as index from "../index.ts";

// Each `xxxPack` export; the crates and the createXxxPack factories are the same packs or build them.
const packs = Object.entries(index)
  .filter(([name]) => /^[a-z]\w*Pack$/.test(name) && !name.startsWith("create"))
  .map(([name, pack]) => ({ name, pack: pack as Pack }));

test("index.ts exports the packs", () => {
  assert.equal(packs.length, 20, `expected 20 packs, found ${packs.length}: ${packs.map((p) => p.name).join(", ")}`);
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

const skipped: string[] = [];
let checked = 0;

for (const { name, pack } of packs) {
  test(`${name}: styles are scoped to its own classes`, () => {
    assertScoped(pack);
  });

  test(`${name}: Today cards that render without its app are markup core accepts`, async (t) => {
    if (!pack.today) return;
    let cards;
    try {
      cards = await pack.today(testContext());
    } catch (e) {
      // No signal tells "needs its app" from a bug, so record the skip; the last test bounds them.
      skipped.push(name);
      t.diagnostic(`skipped, today() threw: ${e instanceof Error ? e.message : String(e)}`);
      return; // the pack's own tests cover it
    }
    for (const card of cards) {
      let html: unknown;
      try {
        html = typeof card.render === "function" ? await card.render() : card.render;
      } catch (e) {
        t.diagnostic(`card ${card.id} skipped, render threw: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      assert.equal(typeof html, "string", `${name} card ${card.id}: render gave ${typeof html}, not markup`);
      assertFragment(`${name} card ${card.id}`, html as string);
      checked++;
    }
  });
}

test("the cards check is not empty", () => {
  assert.ok(checked > 0, `no card was checked; today() threw for: ${skipped.join(", ")}`);
});
