/** Themes: every theme passes Dovre's contrast check, and can be picked and worn. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertThemes, packApp } from "dovre/pack-testing.ts";
import { createThemesPack, THEMES } from "../index.ts";

test("every theme is kept: its tokens are the palette's and its contrast holds, with each accent", () => {
  assertThemes(createThemesPack());
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
});

test("a theme is offered on Look, worn once picked, and its styles come from Dovre", async () => {
  const { get, post } = packApp([createThemesPack()]);
  const look = await (await get("/settings/look")).text();
  for (const t of THEMES) assert.ok(look.includes(`name="theme" value="themes-${t.id}"`), t.id);
  await post("/settings/layout", { part: "look", theme: "themes-dusk" });
  const page = await (await get("/settings/look")).text();
  assert.match(page, /<html lang="en" data-theme="themes-dusk">/);
  assert.match(page, /<meta name="theme-color" content="#181526">/);
  const sheet = /href="(\/assets\/packs\.[^"]+\.css)"/.exec(page)![1]!;
  assert.match(await (await get(sheet)).text(), /:root\[data-theme="themes-dusk"\] \{\n {2}color-scheme: dark;/);
});
