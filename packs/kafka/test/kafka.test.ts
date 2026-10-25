/** Kafka Pack (`kafka`) tests: a fake lag endpoint answers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { type KafkaKept, lagState, LAG_WARN_DEFAULT, parseKafka } from "../data.ts";
import { createKafkaPack } from "../index.ts";
import { kafkaCard, kafkaPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;

/** A lag payload with every shape the parser accepts, plus a payload field it must never keep. */
const READING = {
  groups: [
    { group: "orders", topic: "orders-v1", totalLag: 50, maxLagPartition: 3, partitions: 12 },
    { groupId: "payments", topicName: "payments.dlq", lag: 7 },
    { consumerGroup: H, topic: H, totalLag: 999_999, payload: H },
    { group: "noTopic" },
  ],
  cluster: { brokers: 3, underReplicatedPartitions: 2, offlinePartitions: 0, topics: 40 },
};

function endpointReading(body: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

test("kafka: parses groups in every accepted shape, and never keeps a payload", () => {
  const { groups, cluster } = parseKafka(READING);
  assert.deepEqual(
    groups.slice(0, 2).map((g) => [g.group, g.topic]),
    [["orders", "orders-v1"], ["payments", "payments.dlq"]],
  );
  // The hostile names survive only as text: no angle brackets to render.
  const hostile = groups[2]!;
  assert.ok(!hostile.group.includes("<") && !hostile.topic.includes("<"));
  assert.ok(hostile.group.includes("alert(1)"));
  assert.equal(groups[1]!.dlq, true);
  assert.equal(groups[0]!.dlq, false);
  assert.equal(cluster!.underReplicatedPartitions, 2);
  assert.ok(!JSON.stringify(groups).includes("payload"), "no payload field survives");
  // A bare array of rows works too.
  assert.equal(parseKafka([{ group: "g", topic: "t", totalLag: 1 }]).groups.length, 1);
});

test("kafka: reads lag, sends the token as a header, and escalates across refreshes", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  let body: unknown = READING;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const pack = createKafkaPack({ fetchFn });
  const ctx = testContext({ env: { KAFKA_ADMIN_URL: "https://kafka.example.com/api/lag", KAFKA_TOKEN: "tok" } });
  await pack.refresh!(ctx);
  let kept = pack.kept()!;
  assert.ok(kept.ok);
  assert.equal(kept.groups.length, 3);
  assert.equal(seen[0]!.url, "https://kafka.example.com/api/lag");
  assert.equal(seen[0]!.headers.authorization, "Bearer tok"); // never in the URL
  assert.ok(!seen[0]!.url.includes("tok"));
  // No needs yet: 50 < 1000, the DLQ is behind (bad), the hostile pair is behind (bad).
  let needs = pack.needs!(ctx);
  assert.ok(needs.some((n) => n.tone === "bad" && n.title.includes("payments.dlq")));
  assert.ok(needs.some((n) => n.title.includes("under-replicated")));
  // The next refresh: orders grows 50 → 900 (still under the threshold) and needs a warning.
  body = { ...READING, groups: [READING.groups[0]!, READING.groups[1]!] };
  body = { ...READING, groups: [{ ...READING.groups[0]!, totalLag: 900 }, READING.groups[1]!] };
  await pack.refresh!(ctx);
  kept = pack.kept()!;
  needs = pack.needs!(ctx);
  assert.ok(needs.some((n) => n.tone === "warn" && n.title.includes("orders") && n.title.includes("growing")), needs.map((n) => n.title).join("; "));
  // Key stability: the same pair behind the same way keeps its key.
  const keys = needs.map((n) => n.key);
  assert.equal(new Set(keys).size, keys.length);
  // And the avatar reports trouble while any need stands.
  const avatar = pack.avatar!(ctx);
  assert.ok(avatar && avatar.trouble);
  assert.equal(avatar.trouble!.level, "fire");
  assert.ok(avatar.asking! >= 2);
});

test("kafka: KAFKA_LAG_WARN sets the threshold; caught-up groups raise nothing", async () => {
  const fetchFn = endpointReading({ groups: [{ group: "g", topic: "t", totalLag: 500 }] });
  const pack = createKafkaPack({ fetchFn });
  const ctx = testContext({ env: { KAFKA_ADMIN_URL: "https://k.example/lag", KAFKA_LAG_WARN: "400" } });
  await pack.refresh!(ctx);
  assert.ok(pack.needs!(ctx).some((n: { tone: string; title: string }) => n.tone === "warn" && n.title.includes("500 behind")));
  const calm = testContext({ env: { KAFKA_ADMIN_URL: "https://k.example/lag", KAFKA_LAG_WARN: "600" } });
  assert.match(pack.bino!(calm), /1 of 1 groups behind/); // behind, but under the threshold: no need
  assert.deepEqual(pack.glance!(calm), [{ label: "groups behind", value: 1 }]);
});

test("kafka: hostile group and topic names come out inert everywhere", async () => {
  const pack = createKafkaPack({ fetchFn: endpointReading(READING) });
  await pack.refresh!(testContext({ env: { KAFKA_ADMIN_URL: "https://k.example/lag" } }));
  const kept = pack.kept()!;
  for (const out of [String(await kafkaPage(kept)), String(kafkaCard(kept))]) {
    assert.ok(!out.includes("<script>"), "script escaped");
    assert.ok(!out.includes("<img"), "img escaped");
    assert.ok(!out.includes('href="javascript:'), "javascript: inert");
  }
  for (const need of pack.needs!(testContext({ env: { KAFKA_ADMIN_URL: "https://k.example/lag" } }))) {
    assert.ok(!need.title.includes("<img"));
  }
});

test("kafka: a missing URL, a bad one, and a failing endpoint each say so without breaking", async () => {
  const pack = createKafkaPack();
  await pack.refresh!(testContext({ env: {} }));
  assert.ok(!pack.kept()!.ok);
  assert.match(pack.kept()!.error!, /KAFKA_ADMIN_URL/);
  await pack.refresh!(testContext({ env: { KAFKA_ADMIN_URL: "javascript:alert(1)" } }));
  assert.ok(!pack.kept()!.ok);
  assert.match(String(await kafkaPage(pack.kept())), /KAFKA_ADMIN_URL|endpoint/);
  const failing = createKafkaPack({ fetchFn: endpointReading({}, 500) });
  await failing.refresh!(testContext({ env: { KAFKA_ADMIN_URL: "https://k.example/lag" } }));
  assert.match(failing.kept()!.error!, /500/);
  assert.equal(failing.needs!(testContext({})).length, 0);
});

test("kafka: lagState says which level, and why", () => {
  const g = { key: "g/t", group: "g", topic: "t", totalLag: 20, maxLagPartition: 0, partitions: 0, dlq: false };
  const kept: KafkaKept = { at: 0, ok: true, groups: [], history: new Map([["g/t", [{ at: 1, lag: 10 }, { at: 2, lag: 20 }]]]) };
  assert.equal(lagState(kept, { ...g, totalLag: 100_000 }, 1000).level, "bad"); // 100× the threshold
  assert.equal(lagState(kept, { ...g, totalLag: 1000 }, 1000).level, "warn");
  assert.equal(lagState(kept, g, 1000).level, "warn"); // growing 10 → 20
  assert.equal(lagState(kept, { ...g, totalLag: 5 }, 1000).level, "ok");
});
