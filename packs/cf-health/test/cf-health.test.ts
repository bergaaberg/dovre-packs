/** Cloudflare Health Pack (`cf-health`) tests: GraphQL parsing, status thresholds, and hostile input escaping. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { createCfHealthPack } from "../index.ts";
import { cfHealthPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;

test("cf-health: parses GraphQL telemetry, classifies status, and notifies hub", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  { dimensions: { scriptName: "edge-api" }, sum: { requests: 1200, errors: 0 } },
                  { dimensions: { scriptName: "auth-worker" }, sum: { requests: 200, errors: 25 } },
                ],
              },
            ],
          },
        },
      }),
      { status: 200 },
    );

  const pack = createCfHealthPack({ fetchFn: fakeFetch });
  const topics: string[] = [];
  await pack.refresh!(
    testContext({
      env: { CF_ACCOUNT_ID: "acc-123", CF_API_TOKEN: "tok-123" },
      publish: (t) => void topics.push(...t),
    }),
  );

  assert.deepEqual(topics, ["cf-health", "snapshot"]);
  const kept = pack.kept()!;
  assert.equal(kept.ok, true);
  assert.equal(kept.workers.length, 2);
  assert.equal(kept.workers[0]!.status, "ok");
  assert.equal(kept.workers[1]!.status, "bad");
  assert.equal(pack.avatar!(testContext())?.trouble?.level, "fire");
  assert.match(pack.bino!(testContext()), /edge-api \[ok\]: 1200 req/);
});

test("cf-health: hostile script names and error messages are inert on the page", async () => {
  const out = String(
    await cfHealthPage({
      at: 0,
      ok: false,
      error: H,
      workers: [{ script: H, requests24h: 10, errors24h: 1, errorRatePct: 10, status: "bad", dashboardUrl: "javascript:alert(1)" }],
    }),
  );
  assert.ok(!out.includes("<script>") && !out.includes("<img"), "hostile HTML escaped");
  assert.ok(!out.includes('href="javascript:'), "javascript: URL blocked");
});
