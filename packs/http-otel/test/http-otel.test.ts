/** HTTP & OpenTelemetry Pack (`http-otel`) tests. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { createHttpOtelPack } from "../index.ts";
import { httpOtelPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;

test("http-otel: polls endpoints, reports down endpoints to avatar, and escapes hostile text", async () => {
  const fakeFetch: typeof fetch = async (url) =>
    String(url).includes("bad") ? new Response("err", { status: 503 }) : new Response('{"ok":true}', { status: 200 });
  const pack = createHttpOtelPack({ fetchFn: fakeFetch });
  await pack.refresh!(testContext({ env: { HTTP_HEALTH_URLS: "https://api.example.com/healthz, https://bad.example.com/healthz" } }));
  assert.equal(pack.kept()!.endpoints.length, 2);
  assert.equal(pack.kept()!.endpoints[0]!.ok, true);
  assert.equal(pack.kept()!.endpoints[1]!.ok, false);
  assert.equal(pack.avatar!(testContext())?.trouble?.level, "fire");

  const out = String(
    await httpOtelPage({
      at: 0,
      endpoints: [{ name: H, url: "javascript:alert(1)", ok: false, statusCode: 500, latencyMs: 12, status: "bad", detail: H }],
    }),
  );
  assert.ok(!out.includes("<script>") && !out.includes("<img"));
  assert.ok(!out.includes('href="javascript:'));
});
