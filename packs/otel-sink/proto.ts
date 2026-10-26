/**
 * A minimal protobuf wire-format reader for the three OTLP export requests (traces, metrics,
 * logs), decoding only the fields the sink keeps into the same shape as OTLP/JSON, so one
 * normaliser handles both encodings. No schema compiler, no dependency: the field numbers are
 * opentelemetry-proto's (v1). Nested attribute values (arrays, kvlists) are skipped, never
 * recursed into, so a hostile payload can't nest its way into a deep stack. Anything malformed
 * throws, and the request is a 400.
 */

/** OTLP/JSON's shape, the subset the sink reads. */
export type AnyValue = { stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number; arrayValue?: unknown; kvlistValue?: unknown; bytesValue?: unknown };
export type KeyValue = { key?: string; value?: AnyValue };
export type Resource = { attributes?: KeyValue[] };
export type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  events?: { name?: string; timeUnixNano?: string | number; attributes?: KeyValue[] }[];
  status?: { code?: number | string; message?: string };
};
export type OtlpLog = {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityNumber?: number | string;
  severityText?: string;
  body?: AnyValue;
  attributes?: KeyValue[];
  traceId?: string;
  spanId?: string;
};
export type NumberPoint = { attributes?: KeyValue[]; timeUnixNano?: string | number; asDouble?: number; asInt?: string | number };
export type HistogramPoint = { attributes?: KeyValue[]; timeUnixNano?: string | number; count?: string | number; sum?: number };
export type OtlpMetric = {
  name?: string;
  unit?: string;
  gauge?: { dataPoints?: NumberPoint[] };
  sum?: { dataPoints?: NumberPoint[] };
  histogram?: { dataPoints?: HistogramPoint[] };
  exponentialHistogram?: { dataPoints?: HistogramPoint[] };
  summary?: { dataPoints?: HistogramPoint[] };
};
export type TracesRequest = { resourceSpans?: { resource?: Resource; scopeSpans?: { spans?: OtlpSpan[] }[] }[] };
export type LogsRequest = { resourceLogs?: { resource?: Resource; scopeLogs?: { logRecords?: OtlpLog[] }[] }[] };
export type MetricsRequest = { resourceMetrics?: { resource?: Resource; scopeMetrics?: { metrics?: OtlpMetric[] }[] }[] };

type Val = { wire: 0; n: bigint } | { wire: 1; at: number } | { wire: 2; bytes: Uint8Array } | { wire: 5; at: number };

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Each field of one message, in order: its number and its raw value. Throws on a malformed buffer. */
export function* fields(b: Uint8Array): Generator<[number, Val]> {
  let p = 0;
  const varint = (): bigint => {
    let out = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (p >= b.length) throw new Error("protobuf: truncated varint");
      const byte = b[p++]!;
      out |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return out;
      shift += 7n;
    }
    throw new Error("protobuf: varint too long");
  };
  while (p < b.length) {
    const tag = varint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field < 1) throw new Error("protobuf: field 0");
    if (wire === 0) yield [field, { wire, n: varint() }];
    else if (wire === 1) {
      if (p + 8 > b.length) throw new Error("protobuf: truncated fixed64");
      yield [field, { wire, at: p }];
      p += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      if (len < 0 || p + len > b.length) throw new Error("protobuf: truncated bytes");
      yield [field, { wire, bytes: b.subarray(p, p + len) }];
      p += len;
    } else if (wire === 5) {
      if (p + 4 > b.length) throw new Error("protobuf: truncated fixed32");
      yield [field, { wire, at: p }];
      p += 4;
    } else throw new Error(`protobuf: wire type ${wire}`);
  }
}

/** Readers for one value, each checking the wire type it expects (a mismatch is malformed). */
function reader(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const want = (v: Val, w: number) => {
    if (v.wire !== w) throw new Error(`protobuf: wire type ${v.wire}, wanted ${w}`);
  };
  return {
    str: (v: Val) => (want(v, 2), utf8.decode((v as { bytes: Uint8Array }).bytes)),
    bytes: (v: Val) => (want(v, 2), (v as { bytes: Uint8Array }).bytes),
    hex: (v: Val) => (want(v, 2), Array.from((v as { bytes: Uint8Array }).bytes, (x) => x.toString(16).padStart(2, "0")).join("")),
    u64: (v: Val) => (want(v, 1), view.getBigUint64((v as { at: number }).at, true).toString()),
    f64: (v: Val) => (want(v, 1), view.getFloat64((v as { at: number }).at, true)),
    s64: (v: Val) => (want(v, 1), view.getBigInt64((v as { at: number }).at, true).toString()),
    int: (v: Val) => (want(v, 0), Number(BigInt.asIntN(64, (v as { n: bigint }).n))),
    int64: (v: Val) => (want(v, 0), BigInt.asIntN(64, (v as { n: bigint }).n).toString()),
  };
}

type R = ReturnType<typeof reader>;

/** Runs `on` for each field of the sub-message `b`, with readers bound to it. */
function msg(b: Uint8Array, on: (field: number, v: Val, r: R) => void): void {
  const r = reader(b);
  for (const [f, v] of fields(b)) on(f, v, r);
}

const sub = (v: Val): Uint8Array => {
  if (v.wire !== 2) throw new Error("protobuf: wanted a message");
  return v.bytes;
};

/** AnyValue: scalars only; an array or kvlist is noted, not read. */
function anyValue(b: Uint8Array): AnyValue {
  const out: AnyValue = {};
  msg(b, (f, v, r) => {
    if (f === 1) out.stringValue = r.str(v);
    else if (f === 2) out.boolValue = r.int(v) !== 0;
    else if (f === 3) out.intValue = r.int64(v);
    else if (f === 4) out.doubleValue = r.f64(v);
    else if (f === 5) out.arrayValue = true;
    else if (f === 6) out.kvlistValue = true;
    else if (f === 7) out.bytesValue = true;
  });
  return out;
}

function keyValue(b: Uint8Array): KeyValue {
  const out: KeyValue = {};
  msg(b, (f, v, r) => {
    if (f === 1) out.key = r.str(v);
    else if (f === 2) out.value = anyValue(sub(v));
  });
  return out;
}

function resource(b: Uint8Array): Resource {
  const attributes: KeyValue[] = [];
  msg(b, (f, v) => {
    if (f === 1) attributes.push(keyValue(sub(v)));
  });
  return { attributes };
}

function span(b: Uint8Array): OtlpSpan {
  const out: OtlpSpan = { attributes: [], events: [] };
  msg(b, (f, v, r) => {
    if (f === 1) out.traceId = r.hex(v);
    else if (f === 2) out.spanId = r.hex(v);
    else if (f === 4) out.parentSpanId = r.hex(v);
    else if (f === 5) out.name = r.str(v);
    else if (f === 6) out.kind = r.int(v);
    else if (f === 7) out.startTimeUnixNano = r.u64(v);
    else if (f === 8) out.endTimeUnixNano = r.u64(v);
    else if (f === 9) out.attributes!.push(keyValue(sub(v)));
    else if (f === 11) {
      const ev: { name?: string; timeUnixNano?: string; attributes: KeyValue[] } = { attributes: [] };
      msg(sub(v), (ef, ev_, er) => {
        if (ef === 1) ev.timeUnixNano = er.u64(ev_);
        else if (ef === 2) ev.name = er.str(ev_);
        else if (ef === 3) ev.attributes.push(keyValue(sub(ev_)));
      });
      out.events!.push(ev);
    } else if (f === 15) {
      const st: { code?: number; message?: string } = {};
      msg(sub(v), (sf, sv, sr) => {
        if (sf === 2) st.message = sr.str(sv);
        else if (sf === 3) st.code = sr.int(sv);
      });
      out.status = st;
    }
  });
  return out;
}

function logRecord(b: Uint8Array): OtlpLog {
  const out: OtlpLog = { attributes: [] };
  msg(b, (f, v, r) => {
    if (f === 1) out.timeUnixNano = r.u64(v);
    else if (f === 2) out.severityNumber = r.int(v);
    else if (f === 3) out.severityText = r.str(v);
    else if (f === 5) out.body = anyValue(sub(v));
    else if (f === 6) out.attributes!.push(keyValue(sub(v)));
    else if (f === 9) out.traceId = r.hex(v);
    else if (f === 10) out.spanId = r.hex(v);
    else if (f === 11) out.observedTimeUnixNano = r.u64(v);
  });
  return out;
}

function numberPoint(b: Uint8Array): NumberPoint {
  const out: NumberPoint = { attributes: [] };
  msg(b, (f, v, r) => {
    if (f === 3) out.timeUnixNano = r.u64(v);
    else if (f === 4) out.asDouble = r.f64(v);
    else if (f === 6) out.asInt = r.s64(v);
    else if (f === 7) out.attributes!.push(keyValue(sub(v)));
  });
  return out;
}

/** Histogram, exponential histogram and summary points: count and sum are fields 4 and 5 in all three. */
function countSumPoint(b: Uint8Array, attrField: number): HistogramPoint {
  const out: HistogramPoint = { attributes: [] };
  msg(b, (f, v, r) => {
    if (f === 3) out.timeUnixNano = r.u64(v);
    else if (f === 4) out.count = r.u64(v);
    else if (f === 5) out.sum = r.f64(v);
    else if (f === attrField) out.attributes!.push(keyValue(sub(v)));
  });
  return out;
}

function points<T>(b: Uint8Array, one: (b: Uint8Array) => T): { dataPoints: T[] } {
  const dataPoints: T[] = [];
  msg(b, (f, v) => {
    if (f === 1) dataPoints.push(one(sub(v)));
  });
  return { dataPoints };
}

function metric(b: Uint8Array): OtlpMetric {
  const out: OtlpMetric = {};
  msg(b, (f, v, r) => {
    if (f === 1) out.name = r.str(v);
    else if (f === 3) out.unit = r.str(v);
    else if (f === 5) out.gauge = points(sub(v), numberPoint);
    else if (f === 7) out.sum = points(sub(v), numberPoint);
    else if (f === 9) out.histogram = points(sub(v), (x) => countSumPoint(x, 9));
    else if (f === 10) out.exponentialHistogram = points(sub(v), (x) => countSumPoint(x, 1));
    else if (f === 11) out.summary = points(sub(v), (x) => countSumPoint(x, 7));
  });
  return out;
}

/** Resource → scopes → items, the shape all three requests share. */
function export3<T>(b: Uint8Array, item: (b: Uint8Array) => T): { resource: Resource; items: T[] }[] {
  const out: { resource: Resource; items: T[] }[] = [];
  msg(b, (f, v) => {
    if (f !== 1) return;
    const block: { resource: Resource; items: T[] } = { resource: {}, items: [] };
    msg(sub(v), (rf, rv) => {
      if (rf === 1) block.resource = resource(sub(rv));
      else if (rf === 2)
        msg(sub(rv), (sf, sv) => {
          if (sf === 2) block.items.push(item(sub(sv)));
        });
    });
    out.push(block);
  });
  return out;
}

export function decodeTraces(b: Uint8Array): TracesRequest {
  return { resourceSpans: export3(b, span).map((x) => ({ resource: x.resource, scopeSpans: [{ spans: x.items }] })) };
}
export function decodeLogs(b: Uint8Array): LogsRequest {
  return { resourceLogs: export3(b, logRecord).map((x) => ({ resource: x.resource, scopeLogs: [{ logRecords: x.items }] })) };
}
export function decodeMetrics(b: Uint8Array): MetricsRequest {
  return { resourceMetrics: export3(b, metric).map((x) => ({ resource: x.resource, scopeMetrics: [{ metrics: x.items }] })) };
}

// --- writing: only what the replies need (and the tests' fixtures) ---

function varintBytes(n: bigint): number[] {
  const out: number[] = [];
  let x = BigInt.asUintN(64, n);
  do {
    let byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x) byte |= 0x80;
    out.push(byte);
  } while (x);
  return out;
}

/** One field, encoded: a number is a varint, a string/bytes/array of parts a length-delimited field. */
export function field(n: number, v: number | bigint | string | Uint8Array | number[]): number[] {
  if (typeof v === "number" || typeof v === "bigint") return [...varintBytes(BigInt(n << 3)), ...varintBytes(BigInt(v))];
  const bytes = typeof v === "string" ? Array.from(new TextEncoder().encode(v)) : Array.from(v);
  return [...varintBytes(BigInt((n << 3) | 2)), ...varintBytes(BigInt(bytes.length)), ...bytes];
}

/** A fixed64 (wire 1) field: nanosecond times. */
export function fixed64(n: number, v: bigint): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return [...varintBytes(BigInt((n << 3) | 1)), ...b];
}

/** A double (wire 1) field. */
export function double(n: number, v: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return [...varintBytes(BigInt((n << 3) | 1)), ...b];
}

/**
 * Export*ServiceResponse: empty when all was taken, else partial_success (field 1) with the count
 * rejected (field 1) and why (field 2) — the same numbers in all three signals.
 */
export function encodeReply(rejected: number, why: string): Uint8Array {
  if (!rejected && !why) return new Uint8Array();
  const inner = [...(rejected ? field(1, rejected) : []), ...(why ? field(2, why) : [])];
  return new Uint8Array(field(1, inner));
}
