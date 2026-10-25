/** Custom App Pack (`custom-app`): manifest validation, refresh hook, and hostile-input XSS/URL escaping. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { customAppPack } from "../index.ts";
import { customAppPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;

test("custom-app: manifest adheres to PACK_API", () => {
  assert.equal(customAppPack.manifest.id, "custom-app");
});

test("custom-app: hostile text stays text and javascript: links are neutralized", async () => {
  const out = String(
    await customAppPage({
      at: 0,
      summary: H,
      items: [{ title: H, sub: H, href: "javascript:alert(1)" }],
    }),
  );
  assert.ok(!out.includes("<script>") && !out.includes("<img"), "markup got through");
  assert.ok(!out.includes('href="javascript:'), "a javascript: link got through");
  assert.match(String(await customAppPage(undefined)), /Not read yet/);
});

test("custom-app: refresh reads and publishes custom-app topic", async () => {
  const topics: string[] = [];
  await customAppPack.refresh!(testContext({ publish: (t) => void topics.push(...t) }));
  assert.deepEqual(topics, ["custom-app"]);
});
