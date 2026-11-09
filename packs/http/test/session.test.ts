import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packApp } from "dovre/pack-testing.ts";
import { httpPack } from "../index.ts";

test("in a pack session the repo picker holds only its checkout (core's ctx.checkouts, API 1.7)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-http-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const r of ["mine", "beside"]) mkdirSync(join(dir, r, ".git"), { recursive: true });
  const options = async (o: Parameters<typeof packApp>[1]) => [...(await (await packApp([httpPack], o).get("/http")).text()).matchAll(/<option value="(mine|beside)"/g)].map((m) => m[1]);
  assert.deepEqual(await options({ codeDir: dir }), ["beside", "mine"]);
  assert.deepEqual(await options({ codeDir: dir, session: { pack: "http", checkout: "mine" } }), ["mine"]);
  const { get } = packApp([httpPack], { codeDir: dir, session: { pack: "http", checkout: "mine" } });
  assert.doesNotMatch(await (await get("/http?repo=beside")).text(), /<option value="beside" selected/);
});
