/** OTLP protobuf: requests encoded by hand (field numbers from opentelemetry-proto v1) decode like their JSON. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "dovre/db.ts";
import { testContext } from "dovre/packs/testing.ts";
import { createOtelSinkPack } from "../index.ts";
import { decodeLogs, decodeMetrics, decodeTraces, double, encodeReply, field, fields, fixed64 } from "../proto.ts";
import { readLogs, readTrace } from "../store.ts";

const NOW = Date.now();
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const hex = (h: string) => Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
const nsOf = (ms: number) => BigInt(ms) * 1_000_000n;
const str = (k: string, v: string) => field(1, [...field(1, k), ...field(2, field(1, v))]); // Resource.attributes / KeyValue{key, AnyValue{string_value}}
const kvInt = (n: number, k: string, v: number) => field(n, [...field(1, k), ...field(2, field(3, v))]);
const resource = field(1, [...str("service.name", "api"), ...str("service.version", "2.0.1")]);
const bytes = (a: number[]) => new Uint8Array(a);

function spanBytes(id: string, err: boolean): number[] {
  return [
    ...field(1, hex(TRACE)),
    ...field(2, hex(id)),
    ...field(5, "GET /orders?id=7"),
    ...field(6, 2),
    ...fixed64(7, nsOf(NOW - 1000)),
    ...fixed64(8, nsOf(NOW - 750)),
    ...kvInt(9, "http.response.status_code", err ? 500 : 200),
    ...field(9, [...field(1, "http.request.header.cookie"), ...field(2, field(1, "sid=1"))]),
    ...field(9, [...field(1, "nested"), ...field(2, field(5, field(1, field(1, "deep"))))]), // an array value: skipped
    ...(err ? field(11, [...field(2, "exception"), ...field(3, [...field(1, "exception.type"), ...field(2, field(1, "Timeout"))])]) : []),
    ...field(15, [...field(2, "boom"), ...field(3, err ? 2 : 0)]),
  ];
}

test("proto: a traces request decodes and is kept like JSON, the reply is an empty protobuf", async () => {
  const req = bytes(field(1, [...resource, ...field(2, [...field(1, field(1, "scope")), ...field(2, spanBytes("00f067aa0ba902b7", true)), ...field(2, spanBytes("00f067aa0ba902b8", false))])]));
  const d = decodeTraces(req);
  const sp = d.resourceSpans![0]!.scopeSpans![0]!.spans!;
  assert.equal(sp.length, 2);
  assert.equal(sp[0]!.traceId, TRACE);
  assert.equal(sp[0]!.startTimeUnixNano, String(nsOf(NOW - 1000)));
  assert.equal(sp[0]!.status!.code, 2);

  const db = openDb().DB;
  const ctx = testContext({ db });
  const pack = createOtelSinkPack();
  const r = await pack.ingest!.handle({ path: "v1/traces", body: req, contentType: "application/x-protobuf", contentEncoding: "", source: "s" }, ctx);
  assert.equal(r.status, 200);
  assert.equal(r.contentType, "application/x-protobuf");
  assert.equal((r.body as Uint8Array).byteLength, 0);
  const rows = await readTrace(db, TRACE);
  assert.equal(rows.length, 2);
  const failed = rows.find((x) => x.err)!;
  assert.equal(failed.name, "GET /orders");
  assert.equal(failed.dur_us, 250_000);
  assert.equal(failed.http_status, 500);
  assert.equal(failed.err_type, "Timeout");
  assert.ok(!JSON.stringify(rows).includes("sid=1"));
  await pack.refresh!(ctx);
  const k = pack.kept()!;
  assert.ok(k.ok);
  assert.equal(k.services[0]!.version, "2.0.1");
  assert.equal(k.services[0]!.p95, 250);
});

test("proto: logs and metrics decode", async () => {
  const log = [...fixed64(1, nsOf(NOW)), ...field(2, 13), ...field(5, field(1, "slow")), ...field(9, hex(TRACE)), ...field(10, hex("00f067aa0ba902b7"))];
  const logs = bytes(field(1, [...resource, ...field(2, field(2, log))]));
  const dl = decodeLogs(logs);
  assert.deepEqual(dl.resourceLogs![0]!.scopeLogs![0]!.logRecords![0]!.body, { stringValue: "slow" });
  const db = openDb().DB;
  const ctx = testContext({ db });
  const pack = createOtelSinkPack();
  await pack.ingest!.handle({ path: "v1/logs", body: logs, contentType: "application/x-protobuf", contentEncoding: "", source: "s" }, ctx);
  const got = await readLogs(db, {});
  assert.equal(got[0]!.severity, 13);
  assert.equal(got[0]!.trace_id, TRACE);

  const gaugePt = [...fixed64(3, nsOf(NOW)), ...double(4, 3.5)];
  const histPt = [...fixed64(3, nsOf(NOW)), ...fixed64(4, 4n), ...double(5, 2)];
  const metrics = bytes(field(1, [...resource, ...field(2, [...field(2, [...field(1, "q.depth"), ...field(3, "1"), ...field(5, field(1, gaugePt))]), ...field(2, [...field(1, "lat"), ...field(9, field(1, histPt))])])]));
  const dm = decodeMetrics(metrics).resourceMetrics![0]!.scopeMetrics![0]!.metrics!;
  assert.equal(dm[0]!.gauge!.dataPoints![0]!.asDouble, 3.5);
  assert.equal(dm[1]!.histogram!.dataPoints![0]!.count, "4");
  await pack.ingest!.handle({ path: "v1/metrics", body: metrics, contentType: "application/x-protobuf", contentEncoding: "", source: "s" }, ctx);
  await pack.refresh!(ctx);
  const k = pack.kept()!;
  assert.ok(k.ok);
  assert.deepEqual(k.services[0]!.metrics.map((m) => [m.name, m.last]), [["lat", 0.5], ["q.depth", 3.5]]);
});

test("proto: a partial success reply encodes its count and message; malformed input throws", () => {
  assert.equal(encodeReply(0, "").byteLength, 0);
  const r = encodeReply(3, "why");
  const [[f, v]] = [...fields(r)];
  assert.equal(f, 1);
  const inner = [...fields((v as { bytes: Uint8Array }).bytes)];
  assert.equal((inner[0]![1] as { n: bigint }).n, 3n);
  assert.equal(new TextDecoder().decode((inner[1]![1] as { bytes: Uint8Array }).bytes), "why");
  assert.throws(() => decodeTraces(bytes([0x0a, 0x05, 0x01])), /truncated/);
  assert.throws(() => decodeTraces(bytes([0x0b])), /wire type/);
  assert.throws(() => decodeTraces(bytes([0x08, 0x01])), /wanted a message/);
  assert.throws(() => decodeTraces(bytes(Array(11).fill(0xff))), /varint/);
});
