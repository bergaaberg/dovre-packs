/** OpenTelemetry pack tests: a fake Prometheus API answers; no real service is touched. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { wantedServices } from "../data.ts";
import { createOtelPack } from "../index.ts";
import { otelCard, otelPage, otelProd } from "../view.ts";

const H = `<script>alert(1)</script>`;
const NOW = Date.parse("2026-10-25T12:00:00Z");

const QUERIES: [string, { value?: [number, string]; values?: [number, string][]; metric?: Record<string, string> }[]][] = [
  ["query_range", [{ values: [[NOW / 1000 - 7200, "0.2"], [NOW / 1000 - 3600, "6.4"], [NOW / 1000, "1.4"]] }]],
  ["http_response_status_code=~\"5..\"", [{ value: [1770000000, "0.75"] }]], // 0.75% of 100 → 0.75
  ["sum(rate(http_server_request_duration_seconds_count{service_name=\"api\"}", [{ value: [1770000000, "12.5"] }]],
  ["histogram_quantile(0.95", [{ value: [1770000000, "0.42"] }]], // 420ms
  ["histogram_quantile(0.99", [{ value: [1770000000, "0.91"] }]], // 910ms
  ["build_info", [{ metric: { service_name: "api", service_version: "1.4." + H } }]], // hostile label
];

/** A fake Prometheus: routes every call by matching the URL against the table above. */
function fakeProm() {
  const hits: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    hits.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    assert.ok(auth?.startsWith("Bearer "), "the token rides in the Authorization header");
    if (url.includes("/api/v1/alerts")) {
      return new Response(
        JSON.stringify({
          status: "success",
          data: { alerts: [
            { labels: { alertname: H, service_name: "api", severity: "critical" }, state: "firing", activeAt: "2026-10-25T11:20:00Z", annotations: { summary: H } },
            { labels: { alertname: "Watchdog", severity: "none" }, state: "firing", activeAt: "2026-10-25T11:00:00Z" },
            { labels: { alertname: "ResolvedSoon", severity: "warning" }, state: "pending", activeAt: "2026-10-25T10:00:00Z" },
          ] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    const hit = QUERIES.find(([needle]) => url.includes(needle));
    return new Response(JSON.stringify({ status: "success", data: { resultType: hit ? "vector" : "vector", result: hit?.[1] ?? [] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, hits };
}

const ENV = { OTEL_PROMETHEUS_URL: "https://prom.example.com", OTEL_BEARER_TOKEN: "tok-1", OTEL_SERVICES: "api=bergaaberg/api" };

test("otel: wantedServices parses names and repo mappings, refusing anything else", () => {
  assert.deepEqual(wantedServices("api, web=bergaaberg/web ,,"), [{ name: "api" }, { name: "web", repo: "bergaaberg/web" }]);
  assert.deepEqual(wantedServices(`${H},x=<img>,ok`), [{ name: "ok" }]);
  assert.deepEqual(wantedServices(undefined), []);
});

test("otel: reads RED metrics, alerts and version; status math and lanes follow the thresholds", async () => {
  const pack = createOtelPack({ fetchFn: fakeProm().fetchFn });
  await pack.refresh!(testContext({ env: ENV }));
  const kept = pack.kept()!;
  assert.ok(kept.ok);
  const api = kept.services.find((s) => s.name === "api")!;
  assert.equal(api.rps, 12.5);
  assert.equal(api.errPct, 0.8); // 0.75 rounded to one decimal
  assert.equal(api.p95, 420);
  assert.equal(api.p99, 910);
  assert.equal(api.version, "1.4.scriptalert(1)/script"); // tags stripped at the source, so even plain-text sinks stay inert
  assert.equal(api.status, "bad"); // the critical firing alert on api
  assert.equal(kept.alerts.length, 2); // firing only: Watchdog yes, pending no
  const lane = pack.lane!(testContext({ env: ENV }))!;
  assert.ok(lane.marks.some((m) => m.title.includes("6.4% 5xx")));
  assert.ok(lane.marks.some((m) => m.title.includes("critical")));
  // the avatar runs fire on the critical alert, with the on-duty beacon lit
  assert.deepEqual(pack.avatar!(testContext({ env: ENV })), { trouble: { level: "fire", why: "api: 5xx or latency breach", href: "/otel" }, onDuty: true });
  // bino says states and numbers only
  const bino = pack.bino!(testContext({ env: ENV }));
  assert.match(bino, /api \[bad\]: 12\.5 req\/s, 0\.8% 5xx, p95 420ms/);
  assert.ok(!bino.includes("<script>"));
});

test("otel: status falls to warn on latency, ok when quiet", async () => {
  const base = fakeProm();
  const quiet = QUERIES.map(([k, v]) => [k, k === "histogram_quantile(0.95" ? [{ value: [1770000000, "0.9"] }] : v] as [string, typeof v]); // p95 900ms → warn
  const pack = createOtelPack({
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/api/v1/alerts")) return new Response(JSON.stringify({ data: { alerts: [] } }), { headers: { "content-type": "application/json" } });
      const hit = quiet.find(([needle]) => url.includes(needle));
      return new Response(JSON.stringify({ data: { result: hit?.[1] ?? [] } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await pack.refresh!(testContext({ env: ENV }));
  const kept = pack.kept()!;
  assert.ok(kept.ok);
  assert.equal(kept.services[0]!.status, "warn"); // p95 900ms ≥ 500ms
  assert.deepEqual(pack.avatar!(testContext({ env: ENV })), { trouble: { level: "storm", why: "api: elevated latency or errors", href: "/otel" }, onDuty: false });
  void base;
});

test("otel: hostile labels and alert names come out inert on page, card and prod pill", async () => {
  const pack = createOtelPack({ fetchFn: fakeProm().fetchFn });
  await pack.refresh!(testContext({ env: ENV }));
  const kept = pack.kept()!;
  for (const out of [String(otelPage(kept)), String(otelCard(kept)), String(otelProd(kept, "bergaaberg/api"))]) {
    assert.ok(!out.includes("<script>"), "script escaped");
    assert.ok(!out.includes("<img"), "markup escaped");
  }
  assert.ok(String(otelProd(kept, "bergaaberg/api")).includes("prod v"));
  assert.equal(otelProd(kept, "other/repo"), "");
});

test("otel: a missing or malformed URL, or no services, says so without fetching", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response("{}");
  }) as typeof fetch;
  const pack = createOtelPack({ fetchFn });
  await pack.refresh!(testContext({ env: { OTEL_SERVICES: "api" } }));
  const noUrl = pack.kept()!;
  assert.ok(!noUrl.ok);
  assert.match(noUrl.error, /OTEL_PROMETHEUS_URL is not set/);
  await pack.refresh!(testContext({ env: { OTEL_PROMETHEUS_URL: `${H}` } }));
  const badUrl = pack.kept()!;
  assert.ok(!badUrl.ok);
  assert.match(badUrl.error, /not a plain http\(s\) URL/);
  await pack.refresh!(testContext({ env: { OTEL_PROMETHEUS_URL: "https://prom.example.com" } }));
  const noServices = pack.kept()!;
  assert.ok(!noServices.ok);
  assert.match(noServices.error, /OTEL_SERVICES/);
  assert.equal(calls, 0);
  // an unreachable API fails the whole read with the message the page shows
  const dead = createOtelPack({ fetchFn: (async () => new Response("nope", { status: 503 })) as typeof fetch });
  await dead.refresh!(testContext({ env: ENV }));
  const deadKept = dead.kept()!;
  assert.ok(!deadKept.ok);
  assert.match(deadKept.error, /answered 503/);
});

test("otel: Basic auth is used when the token has a colon", async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ data: { result: [] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const pack = createOtelPack({ fetchFn });
  await pack.refresh!(testContext({ env: { ...ENV, OTEL_BEARER_TOKEN: "user:pass" } }));
  assert.ok(seen.length > 0 && seen.every((a) => a.startsWith("Basic ")));
});
