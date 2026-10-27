/** OTel sink tests: OTLP requests go through the ingest handler (and once through a worker) into an in-memory database. */
import assert from "node:assert/strict";
import { html } from "hono/html";
import { test } from "node:test";
import { Hono } from "hono";
import { openDb } from "dovre/db.ts";
import { createToken } from "dovre/packs/ingest.ts";
import { testContext } from "dovre/packs/testing.ts";
import type { IngestInput, PackContext } from "dovre/packs/types.ts";
import { createWorker } from "dovre/worker.ts";
import { createOtelSinkPack, repoMap } from "../index.ts";
import { extraKeys, hexId, scrub } from "../otlp.ts";
import { MAX_SPANS, readLogs, readTrace } from "../store.ts";
import { logsPage, servicePage, sinkCard, sinkPage, sinkProd, spanArg, tracePage, treeOrder } from "../view.ts";

const H = `<script>alert(1)</script>`;
const J = "javascript:alert(1)";
const NOW = Date.parse("2026-10-25T12:00:00Z");
const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const sid = (n: number) => n.toString(16).padStart(16, "0");

type Attr = [string, string | number | boolean];
const kv = (attrs: Attr[]) => attrs.map(([key, v]) => ({ key, value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }));
const resource = (name: string, more: Attr[] = []) => ({ attributes: kv([["service.name", name], ...more]) });

type SpanSpec = { trace?: string; id: number; parent?: number; name?: string; kind?: number; at?: number; dur?: number; err?: boolean; attrs?: Attr[]; ex?: [string, string] };
function span(s: SpanSpec) {
  const at = s.at ?? NOW - 60_000;
  return {
    traceId: s.trace ?? TRACE,
    spanId: sid(s.id),
    parentSpanId: s.parent ? sid(s.parent) : "",
    name: s.name ?? "GET /pay",
    kind: s.kind ?? 2,
    startTimeUnixNano: ns(at),
    endTimeUnixNano: ns(at + (s.dur ?? 100)),
    attributes: kv(s.attrs ?? []),
    events: s.ex ? [{ name: "exception", attributes: kv([["exception.type", s.ex[0]], ["exception.message", s.ex[1]], ["exception.stacktrace", "at secret.ts:1"]]) }] : [],
    status: { code: s.err ? 2 : 0, message: s.err ? "boom" : "" },
  };
}
const traces = (svc: string, spans: ReturnType<typeof span>[], more: Attr[] = [["service.version", "1.4.2"], ["deployment.environment", "prod"]]) => ({ resourceSpans: [{ resource: resource(svc, more), scopeSpans: [{ scope: { name: "x" }, spans }] }] });

function setup(env: Record<string, string> = {}, clock = { t: NOW }) {
  const db = openDb().DB;
  const published: string[][] = [];
  const ctx = testContext({ db, env, publish: (t) => void published.push(t) });
  const pack = createOtelSinkPack({ now: () => clock.t });
  const send = async (path: string, body: unknown, over: Partial<IngestInput> = {}) => {
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
    const r = await pack.ingest!.handle({ path, body: bytes, contentType: "application/json", contentEncoding: "", source: "checkout", ...over }, ctx);
    return { ...r, json: () => JSON.parse(typeof r.body === "string" ? r.body : new TextDecoder().decode(r.body)) };
  };
  return { db, ctx, pack, send, published, clock };
}

test("otel-sink: JSON traces come in, RED per service is read back, and only allowlisted attributes are kept", async () => {
  const { db, ctx, pack, send, published } = setup({ OTEL_SINK_ATTRIBUTES: "url.full, http.request.header.authorization, enduser.id_ok, user.id, region" });
  const spans = [
    span({ id: 1, name: "GET /pay?card=4242", attrs: [["http.request.method", "GET"], ["http.route", "/pay?x=1"], ["http.response.status_code", 200], ["url.full", "https://shop.example/pay?card=4242#frag"], ["http.request.header.authorization", "Bearer s3cret"], ["user.id", "u-1"], ["http.request.body", "card=4242"], ["region", "eu"]] }),
    span({ id: 2, dur: 300 }),
    span({ id: 3, dur: 2000, err: true, ex: ["CardDeclined", "card of ann@example.com declined at https://bank.example/x?token=abc"], attrs: [["http.response.status_code", 502]] }),
    span({ id: 4, parent: 3, kind: 3, name: "POST bank", dur: 1500, attrs: [["http.response.status_code", 503]] }), // a client span's 5xx isn't this service's error
  ];
  const r = await send("v1/traces", traces("checkout-api", spans));
  assert.equal(r.status, 200);
  assert.equal(r.contentType, "application/json");
  assert.deepEqual(r.json(), {});

  const kept = await readTrace(db, TRACE);
  assert.equal(kept.length, 4);
  const root = kept.find((s) => s.span_id === sid(1))!;
  assert.equal(root.name, "GET /pay", "the query is cut from the span name");
  assert.equal(root.http_route, "/pay");
  assert.equal(root.http_method, "GET");
  assert.equal(root.http_status, 200);
  assert.equal(root.source, "checkout");
  assert.deepEqual(JSON.parse(root.attrs!), { "url.full": "https://shop.example/pay", region: "eu" }, "extras kept without the query; headers, bodies and user ids never");
  const all = JSON.stringify(kept);
  for (const gone of ["s3cret", "u-1", "4242", "card=", "secret.ts", "ann@example.com", "token=abc"]) assert.ok(!all.includes(gone), `${gone} is dropped`);
  const failed = kept.find((s) => s.span_id === sid(3))!;
  assert.equal(failed.err, 1);
  assert.equal(failed.err_type, "CardDeclined");
  assert.equal(failed.err_msg, "card of [email] declined at https://bank.example/x");
  assert.equal(kept.find((s) => s.span_id === sid(4))!.err, 0);
  assert.equal(kept.find((s) => s.span_id === sid(4))!.entry, 0);

  await pack.refresh!(ctx);
  assert.deepEqual(published.at(-1), ["otel-sink", "snapshot"]);
  const k = pack.kept()!;
  assert.ok(k.ok);
  const s = k.services[0]!;
  assert.equal(s.name, "checkout-api");
  assert.equal(s.version, "1.4.2");
  assert.equal(s.environment, "prod");
  assert.equal(s.n, 3, "three entry spans (server spans and roots)");
  assert.equal(s.errors, 1);
  assert.equal(s.errPct, 33.3);
  assert.equal(s.rpm, 0.2);
  assert.equal(s.p50, 300);
  assert.equal(s.p95, 2000);
  assert.equal(s.status, "ok", "one failure is not yet erroring");
  assert.equal(k.errors.length, 1);
  assert.equal(k.errors[0]!.trace_id, TRACE);
  assert.equal(s.hourly.length, 24);
  assert.equal(s.hourly.reduce((a, h) => a + h.n, 0), 3);
});

test("otel-sink: a service that starts erroring is a need (rung once by key), a lane mark, avatar trouble and a Today card", async () => {
  const { ctx, pack, send } = setup({ OTEL_SINK_SERVICES: "api=bergaaberg/api, bad=<x>" });
  await send("v1/traces", traces("api", [1, 2, 3, 4, 5, 6].map((id) => span({ id, err: id <= 3, trace: TRACE.slice(0, 31) + id })))); // 3 of 6 failed
  await pack.refresh!(ctx);
  const needs = pack.needs!(ctx);
  assert.equal(needs.length, 1);
  assert.equal(needs[0]!.key, "erroring api bad");
  assert.equal(needs[0]!.ring, "erroring");
  assert.equal(needs[0]!.tone, "bad");
  assert.equal(needs[0]!.href, "/otel-sink/service/api");
  assert.deepEqual(pack.avatar!(ctx), { trouble: { level: "fire", why: "1 service failing", href: "/otel-sink" } });
  const lane = pack.lane!(ctx)!;
  assert.equal(lane.marks.length, 1);
  assert.match(lane.marks[0]!.title, /api: 3 errors \(50%\)/);
  assert.ok(pack.today!(ctx));
  assert.match(String(sinkCard(pack.kept())), /Erroring services/);
  assert.match(String(sinkProd(pack.kept(), "bergaaberg/api")), /running v1\.4\.2/);
  assert.equal(sinkProd(pack.kept(), "other/repo"), "");
  assert.match(pack.bino!(ctx), /^api \[bad\]: 0\.4 req\/min, 50% errors/);
  assert.deepEqual([...repoMap("api=bergaaberg/api, bad=<x>, =a/b")], [["api", "bergaaberg/api"]]);
});

test("otel-sink: requests that aren't OTLP are refused with the status the spec names", async () => {
  const { send } = setup();
  assert.equal((await send("v1/nope", {})).status, 404);
  assert.equal((await send("v1/traces", {}, { contentType: "text/plain" })).status, 415);
  assert.equal((await send("v1/traces", {}, { contentEncoding: "br" })).status, 415);
  assert.equal((await send("v1/traces", new TextEncoder().encode("{not json"))).status, 400);
  assert.equal((await send("v1/traces", new TextEncoder().encode("[1]"))).status, 400);
  assert.equal((await send("v1/traces", new Uint8Array([1, 2, 3]), { contentEncoding: "gzip" })).status, 400, "not gzip");
  assert.equal((await send("v1/traces", new Uint8Array([0x0a, 0xff]), { contentType: "application/x-protobuf" })).status, 400, "truncated protobuf");
  assert.equal((await send("v1/traces", {})).status, 200, "an empty request is fine");
});

test("otel-sink: spans without ids or outside the window are rejected as partial success", async () => {
  const { db, send } = setup();
  const r = await send("v1/traces", traces("api", [span({ id: 1 }), { ...span({ id: 2 }), traceId: "zz" }, { ...span({ id: 3 }), spanId: "00".repeat(8) }, span({ id: 4, at: NOW - 25 * 3600_000 })]));
  assert.equal(r.status, 200);
  const body = r.json();
  assert.equal(body.partialSuccess.rejectedSpans, 3);
  assert.match(body.partialSuccess.errorMessage, /trace or span id/);
  assert.equal((await readTrace(db, TRACE)).length, 1);
});

test("otel-sink: gzip is inflated, and a zip bomb stops at the cap", async () => {
  const { db, send } = setup();
  const gz = async (b: Uint8Array) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const r = await send("v1/traces", await gz(new TextEncoder().encode(JSON.stringify(traces("api", [span({ id: 7 })])))), { contentEncoding: "gzip" });
  assert.equal(r.status, 200);
  assert.equal((await readTrace(db, TRACE)).length, 1);
  const bomb = await gz(new Uint8Array(20 * 1024 * 1024)); // 20 MB of zeros, ~20 KB on the wire
  assert.ok(bomb.byteLength < 100_000);
  assert.equal((await send("v1/traces", bomb, { contentEncoding: "gzip" })).status, 413);
});

test("otel-sink: logs keep level, service and trace; bodies are scrubbed, or dropped when switched off", async () => {
  const { db, send } = setup();
  const logs = (records: unknown[]) => ({ resourceLogs: [{ resource: resource("api"), scopeLogs: [{ logRecords: records }] }] });
  const r = await send(
    "v1/logs",
    logs([
      { timeUnixNano: ns(NOW - 5000), severityNumber: 17, body: { stringValue: "paid by bob@example.com via https://x.example/cb?code=123" }, traceId: TRACE, spanId: sid(1), attributes: kv([["exception.type", "Boom"], ["user.email", "bob@example.com"]]) },
      { timeUnixNano: ns(NOW - 4000), severityText: "WARNING", body: { kvlistValue: { values: [{ key: "password", value: { stringValue: "hunter2" } }] } } },
      { observedTimeUnixNano: ns(NOW - 3000), severityNumber: "SEVERITY_NUMBER_INFO", body: { stringValue: "ok" } },
      { timeUnixNano: ns(NOW - 26 * 3600_000), body: { stringValue: "too old" } },
    ]),
  );
  assert.equal(r.json().partialSuccess.rejectedLogRecords, 1);
  const all = await readLogs(db, {});
  assert.deepEqual(all.map((l) => [l.severity, l.body]), [[9, "ok"], [13, "(structured body, not kept)"], [17, "paid by [email] via https://x.example/cb"]]);
  assert.ok(!JSON.stringify(all).includes("hunter2") && !JSON.stringify(all).includes("bob@"));
  assert.equal(all[2]!.err_type, "Boom");
  assert.equal((await readLogs(db, { minSeverity: 13 })).length, 2);
  assert.equal((await readLogs(db, { trace: TRACE })).length, 1);
  assert.equal((await readLogs(db, { service: "web" })).length, 0);

  const off = setup({ OTEL_SINK_LOG_BODIES: "off" });
  await off.send("v1/logs", logs([{ timeUnixNano: ns(NOW), severityNumber: 9, body: { stringValue: "a body" } }]));
  assert.equal((await readLogs(off.db, {}))[0]!.body, "");
});

test("otel-sink: metric points roll up per service, metric and hour", async () => {
  const { ctx, pack, send } = setup();
  const metrics = (v: number, h: number) => ({
    resourceMetrics: [{ resource: resource("api"), scopeMetrics: [{ metrics: [
      { name: "queue.depth", unit: "1", gauge: { dataPoints: [{ timeUnixNano: ns(NOW - 60_000), asDouble: v }] } },
      { name: "http.server.request.duration", unit: "s", histogram: { dataPoints: [{ timeUnixNano: ns(NOW - 60_000), count: "4", sum: h }] } },
      { name: "<bad name>", sum: { dataPoints: [{ asInt: "3" }] } },
    ] }] }],
  });
  assert.equal((await send("v1/metrics", metrics(5, 2))).json().partialSuccess.rejectedDataPoints, 1);
  await send("v1/metrics", metrics(7, 6));
  await pack.refresh!(ctx);
  const k = pack.kept()!;
  assert.ok(k.ok);
  const m = Object.fromEntries(k.services[0]!.metrics.map((x) => [x.name, x]));
  assert.equal(m["queue.depth"]!.last, 7);
  assert.equal(m["queue.depth"]!.avg, 6);
  assert.equal(m["http.server.request.duration"]!.last, 1.5);
  assert.equal(m["http.server.request.duration"]!.unit, "s");
  assert.equal(k.counts.metrics, 2);
});

test("otel-sink: refresh prunes past retention, and the span cap holds", async () => {
  const { db, ctx, pack, send, clock } = setup();
  await send("v1/traces", traces("api", [span({ id: 1 })]));
  await send("v1/logs", { resourceLogs: [{ resource: resource("api"), scopeLogs: [{ logRecords: [{ timeUnixNano: ns(NOW), body: { stringValue: "x" } }] }] }] });
  clock.t = NOW + 25 * 3600_000;
  await pack.refresh!(ctx);
  assert.equal((await readTrace(db, TRACE)).length, 0);
  assert.equal((await readLogs(db, {})).length, 0);
  const k = pack.kept()!;
  assert.ok(k.ok);
  assert.equal(k.services.length, 1, "the service is kept for its 7 days");

  clock.t = NOW;
  let n = 0;
  const batch = () => Array.from({ length: 5000 }, () => span({ id: ++n, trace: n.toString(16).padStart(32, "a"), at: NOW - 3600_000 + n }));
  for (let i = 0; i < 7; i++) await send("v1/traces", traces("api", batch()));
  await pack.refresh!(ctx);
  const k2 = pack.kept()!;
  assert.ok(k2.ok);
  assert.equal(k2.counts.spans, MAX_SPANS);
  assert.equal((await readTrace(db, (35000).toString(16).padStart(32, "a"))).length, 1, "the newest stay");
  assert.equal((await readTrace(db, (1).toString(16).padStart(32, "a"))).length, 0, "the oldest go");
});

test("otel-sink: hostile service names, span names, attributes and log bodies come out inert", async () => {
  const { db, ctx, pack, send } = setup({ OTEL_SINK_ATTRIBUTES: "evil", OTEL_SINK_SERVICES: `${J}=a/b` });
  for (const svc of [H, J]) {
    await send("v1/traces", traces(svc, [span({ id: 1, trace: svc === H ? TRACE : TRACE.replace("0a", "0b"), name: H, err: true, ex: [H, `${J} ${H}`], attrs: [["evil", `${H} ${J}`], ["http.route", J], ["http.request.method", H]] }), span({ id: 2, trace: svc === H ? TRACE : TRACE.replace("0a", "0b"), err: true }), span({ id: 3, trace: svc === H ? TRACE : TRACE.replace("0a", "0b"), err: true })], [["service.version", H], ["deployment.environment", J]]));
    await send("v1/logs", { resourceLogs: [{ resource: resource(svc), scopeLogs: [{ logRecords: [{ timeUnixNano: ns(NOW), severityText: H, body: { stringValue: `${H} ${J}` }, traceId: TRACE, attributes: kv([["evil", H], ["exception.type", H]]) }] }] }] });
  }
  await pack.refresh!(ctx);
  const kept = pack.kept()!;
  assert.ok(kept.ok && kept.services.length === 2);
  const spans = await readTrace(db, TRACE);
  const logs = await readLogs(db, {});
  const out = [
    sinkPage(kept),
    servicePage(kept, H),
    servicePage(kept, J),
    tracePage(TRACE, spans, logs),
    logsPage(logs, { service: H, level: H, trace: H }, [H, J]),
    sinkCard(kept),
    sinkProd(kept, "a/b"),
    pack.settings!(ctx),
  ].map(String);
  for (const o of out) {
    assert.ok(!o.includes("<script>"), "script escaped");
    assert.ok(!/href="javascript:/i.test(o) && !/action="javascript:/i.test(o), "no javascript: link");
  }
  assert.match(out[0]!, /href="\/otel-sink\/service\/javascript%3Aalert\(1\)"/);
  assert.match(out[0]!, /&lt;script&gt;/);
  for (const n of pack.needs!(ctx)) assert.ok(n.href.startsWith("/otel-sink/service/"));
});

test("otel-sink: the pages answer through routes, a bad trace id is a 404", async () => {
  const { ctx, pack, send } = setup();
  await send("v1/traces", traces("api", [span({ id: 1, name: "root" }), span({ id: 2, parent: 1, kind: 3, name: "child", at: NOW - 59_990, dur: 50 })]));
  await send("v1/logs", { resourceLogs: [{ resource: resource("api"), scopeLogs: [{ logRecords: [{ timeUnixNano: ns(NOW), severityNumber: 17, body: { stringValue: "in the trace" }, traceId: TRACE }] }] }] });
  await pack.refresh!(ctx);
  const app = new Hono();
  const page: PackContext["page"] = async (_c, o) => new Response(`<title>${o.title}</title>${String(await o.body)}`);
  pack.routes!(app as never, { ...ctx, page });
  const get = async (p: string) => {
    const r = await app.request(`http://localhost${p}`);
    return { status: r.status, text: await r.text() };
  };
  assert.match((await get("/otel-sink")).text, /api/);
  assert.match((await get("/otel-sink/service/api")).text, /p95/);
  const t = await get(`/otel-sink/trace/${TRACE}`);
  assert.match(t.text, /root[\s\S]*child/, "the waterfall puts the child under its parent");
  assert.match(t.text, /osink-d1/);
  assert.match(t.text, /in the trace/);
  assert.equal((await get("/otel-sink/trace/nothex")).status, 404);
  assert.match((await get("/otel-sink/logs?level=error&service=api")).text, /in the trace/);
  assert.doesNotMatch((await get("/otel-sink/logs?level=fatal")).text, /in the trace/);
});

/**
 * Core switches a pack with both `ingest` and `routes` off (bergaaberg/dovre#113: the ingest route's
 * /<id> counts as a core path), so until that's fixed this goes through core with the routes left out.
 */
async function throughWorker(withRoutes: boolean) {
  const db = openDb().DB;
  const full = createOtelSinkPack();
  const pack = withRoutes ? full : { ...full, routes: undefined };
  const worker = createWorker({ packs: [pack] });
  const env = { DB: db, IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud" };
  const pending: Promise<unknown>[] = [];
  const wctx = { waitUntil: (x: Promise<unknown>) => void pending.push(x) };
  const token = await createToken(db, "otel-sink", "checkout");
  const post = (auth: string | undefined) =>
    worker.fetch(new Request("https://dovre.example.dev/otel-sink/ingest/v1/traces", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(traces("api", [span({ id: 1, at: Date.now() - 1000 })])) }), env as never, wctx);
  assert.equal((await post(undefined)).status, 401);
  const r = await post(`Bearer ${token}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "{}");
  await Promise.all(pending);
  const rows = await readTrace(db, TRACE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "checkout");
}

test("otel-sink: through a hosted worker, a token from Settings lets an exporter in", () => throughWorker(false));
test("otel-sink: the same with the pack's pages mounted", () => throughWorker(true));

test("otel-sink: small helpers", () => {
  assert.equal(hexId(TRACE.toUpperCase(), 16), TRACE);
  assert.equal(hexId(btoa(String.fromCharCode(...Array.from({ length: 16 }, (_, i) => i + 1))), 16), "0102030405060708090a0b0c0d0e0f10");
  assert.equal(hexId("0".repeat(32), 16), undefined);
  assert.equal(hexId(H, 16), undefined);
  assert.deepEqual([...extraKeys("a.b, user.id, http.request.header.cookie, <x>, session.id")], ["a.b"]);
  assert.equal(scrub("see https://a.example/p?q=1#f and a@b.co"), "see https://a.example/p and [email]");
  const node = (id: string, parent: string, at: number) => ({ span_id: id, parent_id: parent, start_us: at }) as never;
  assert.deepEqual(treeOrder([node("c", "b", 3), node("b", "a", 2), node("a", "", 1), node("x", "x", 0)]).map((n) => [n.s.span_id, n.depth]), [["x", 0], ["a", 0], ["b", 1], ["c", 2]]);
});

test("otel-sink: an HTTP span on the trace page carries what other packs put there (span.actions), from what was kept", async () => {
  const { db, ctx, pack, send } = setup({ OTEL_SINK_ATTRIBUTES: "url.full" });
  await send("v1/traces", traces("api", [
    span({ id: 1, name: "GET /orders", kind: 2, attrs: [["http.request.method", "GET"], ["http.route", "/orders/:id"], ["url.full", "https://shop.example/orders/7?card=4242"], ["http.request.header.authorization", "Bearer s3cret"]] }),
    span({ id: 2, parent: 1, name: "db query" }),
  ]));
  await pack.refresh!(ctx);
  const spans = await readTrace(db, TRACE);
  const seen: unknown[] = [];
  const page = String(tracePage(TRACE, spans, [], (a) => (seen.push(a), [html`<button>Open ${a.method}</button>`, ""])));
  assert.deepEqual(seen, [{ service: "api", kind: "server", method: "GET", route: "/orders/:id", attrs: { "url.full": "https://shop.example/orders/7" } }], "only the HTTP span, its URL without the query, no header");
  assert.equal((page.match(/<button>Open GET<\/button>/g) ?? []).length, 1);
  assert.equal(spanArg({ ...spans[0]!, attrs: "not json" })!.attrs["url.full"], undefined, "unreadable attrs: none");
  assert.doesNotMatch(String(tracePage(TRACE, spans, [])), /<button>/, "no pack answers: no button");
});
