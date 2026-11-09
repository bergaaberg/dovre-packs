/** AI summaries: what it queues from a snapshot, what it keeps, and that it asks nothing until I allow it. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "dovre/db.ts";
import { deploySummaryKey, prSummaryKey } from "dovre/gather.ts";
import { testContext, testPr, testSnapshot } from "dovre/pack-testing.ts";
import type { PackAi, PackContext } from "dovre/pack.ts";
import type { Changelog } from "dovre/sources/changelog.ts";
import { createSummaries } from "../store.ts";
import { createSummariesPack, wantAll } from "../index.ts";

const change = { kind: "feature", title: "Ny side", author: "per", text: "Ny side", sha: "abc1234" } as Changelog["changes"][number];
const changelog = (changes: Changelog["changes"]): Changelog => ({ repo: "ACME/people", env: "prod", head: "bbb", prodSha: "aaa", prodAt: new Date(Date.now() - 3 * 86400e3).toISOString(), changes, commits: changes.length, additions: 1, deletions: 0, files: 1, compareUrl: "https://acme.ghe.com/x" }) as Changelog;

test("it queues every open PR at its head commit and every deploy that ships something, once each", async () => {
  const db = openDb();
  const asked: string[] = [];
  const sum = createSummaries(db.DB, async ({ user }) => (asked.push(user), { text: "Kort.", cost: 0 }));
  await sum.load();
  const mine = testPr({ number: 3, title: "Mine", headSha: "h3" });
  const s = testSnapshot({
    prs: { ok: true, value: { mine: [mine, testPr({ number: 4, headSha: "" })], review: [testPr({ number: 5, title: "Theirs", headSha: "h5" })] } },
    changelogs: new Map([
      [1, { ok: true, value: changelog([change]) }],
      [2, { ok: true, value: { ...changelog([]), head: "ccc" } }],
    ]),
  });
  wantAll(sum, s, Date.now());
  wantAll(sum, s, Date.now());
  await sum.idle();
  assert.equal(asked.length, 3, "two PRs with a head commit and the deploy that ships something; the second pass asks nothing");
  assert.match(asked.find((u) => u.includes("#3"))!, /Title: Mine/);
  assert.match(asked.find((u) => u.includes("deploy"))!, /last 3 days[^]*\[feature\] Ny side \(per\)/);
  assert.deepEqual(sum.get(prSummaryKey(mine)), { state: "ready", text: "Kort." });
  assert.deepEqual(sum.get(deploySummaryKey(changelog([change]))), { state: "ready", text: "Kort." });
  // Kept: a restart reads it back.
  const again = createSummaries(db.DB, async () => assert.fail("not asked again"));
  await again.load();
  assert.deepEqual(again.get(prSummaryKey(mine)), { state: "ready", text: "Kort." });
});

test("a failed summary says so and isn't asked again; one the gate refused is asked again later", async () => {
  let n = 0;
  const sum = createSummaries(openDb().DB, async () => (n++, Promise.reject(new Error("quota"))));
  sum.want("k", () => ({ system: "", user: "" }));
  await sum.idle();
  sum.want("k", () => ({ system: "", user: "" }));
  await sum.idle();
  assert.deepEqual([sum.get("k"), n], [{ state: "failed", error: "quota" }, 1]);
  const capped = createSummaries(openDb().DB, async () => Promise.reject(new Error("AI: today's cap ($1.00) is spent")));
  capped.want("k", () => ({ system: "", user: "" }));
  await capped.idle();
  assert.equal(capped.get("k"), undefined, "forgotten, so tomorrow's refresh asks again");
});

test("it asks nothing until I allow it; then its refresh queues the snapshot's PRs, and the slot answers", async () => {
  const p = testPr({ number: 7, title: "Seven", headSha: "h7" });
  const asked: string[] = [];
  let ai: PackAi = { text: false, why: "not allowed" };
  const ctx: PackContext = testContext({
    db: openDb().DB,
    snapshot: () => testSnapshot({ prs: { ok: true, value: { mine: [p], review: [] } } }),
    ai: () => ai,
    complete: async ({ user }) => (asked.push(user), { text: "Fixes it.", cost: 0.001 }),
  });
  const pack = createSummariesPack();
  const slot = () => pack.slots!(ctx)["ai.summary"]!({ key: prSummaryKey(p) });
  await pack.refresh!(ctx);
  assert.equal(asked.length, 0);
  assert.equal(slot(), undefined);
  ai = { text: true, size: "small", dayUsd: 1 };
  await pack.refresh!(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.length, 1);
  assert.deepEqual(slot(), { state: "ready", text: "Fixes it." });
});

test("its manifest asks for text only, and says why", () => {
  const m = createSummariesPack().manifest;
  assert.match(m.ai?.text?.why ?? "", /summary of each open PR/);
  assert.equal(m.execution, "local-only");
});
