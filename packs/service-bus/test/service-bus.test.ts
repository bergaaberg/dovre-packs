/**
 * Azure Service Bus Pack (`service-bus`) tests: both endpoint kinds against fake APIs (ARM JSON
 * and the namespace's Atom feed), the DLQ radar (needs, ring keys, avatar), soft failure, counts
 * only, and hostile input on the page and card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { authHeader, parseAtom, parseEndpoint, parseEntities } from "../data.ts";
import { createServiceBusPack } from "../index.ts";
import { serviceBusCard, serviceBusPage } from "../view.ts";
import type { ServiceBusKept } from "../watch.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const ARM = "https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ServiceBus/namespaces/acme-bus";
const DATA = "https://acme-bus.servicebus.windows.net";
/** What a message would say: it must never reach the pack's state, page or Bino. */
const BODY = "card 4111-1111-1111-1111";

type Call = { url: string; auth: string | null };

/** A fake API: answers by path, records each call. Anything unknown is a 404. */
function fakeApi(routes: Record<string, unknown>, calls: Call[] = []): typeof fetch {
  return async (input, init) => {
    const u = new URL(String(input));
    calls.push({ url: u.href, auth: new Headers(init?.headers).get("authorization") });
    const body = routes[u.pathname];
    if (body === undefined) return new Response("not here", { status: 404 });
    if (typeof body === "number") return new Response("no", { status: body });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
}

const armQueue = (name: string, c: Record<string, number>) => ({ name, properties: { status: "Active", countDetails: { transferMessageCount: 0, ...c } } });

const armRoutes = (over: Record<string, unknown> = {}) => {
  const p = new URL(ARM).pathname;
  return {
    [`${p}/queues`]: { value: [armQueue("orders", { activeMessageCount: 12, deadLetterMessageCount: 3, scheduledMessageCount: 1, transferDeadLetterMessageCount: 0 }), armQueue("emails", { activeMessageCount: 5000, deadLetterMessageCount: 0 })] },
    [`${p}/topics`]: { value: [{ name: "billing", properties: {} }] },
    [`${p}/topics/billing/subscriptions`]: { value: [armQueue("invoices", { activeMessageCount: 0, deadLetterMessageCount: 90, transferDeadLetterMessageCount: 20 }), armQueue("audit", {})] },
    ...over,
  };
};

const atomEntry = (title: string, desc: string, c: { active: number; dead: number; scheduled?: number; tdead?: number }) =>
  `<entry xmlns="http://www.w3.org/2005/Atom"><id>${DATA}/${title}</id><title type="text">${title}</title><content type="application/xml"><${desc} xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><MessageCount>${c.active + c.dead}</MessageCount><CountDetails xmlns:d2p1="http://schemas.microsoft.com/netservices/2011/06/servicebus"><d2p1:ActiveMessageCount>${c.active}</d2p1:ActiveMessageCount><d2p1:DeadLetterMessageCount>${c.dead}</d2p1:DeadLetterMessageCount><d2p1:ScheduledMessageCount>${c.scheduled ?? 0}</d2p1:ScheduledMessageCount><d2p1:TransferMessageCount>0</d2p1:TransferMessageCount><d2p1:TransferDeadLetterMessageCount>${c.tdead ?? 0}</d2p1:TransferDeadLetterMessageCount></CountDetails></${desc}></content></entry>`;
const atomFeed = (title: string, entries: string[]) => `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">${title}</title>${entries.join("")}</feed>`;

test("service-bus: manifest declares its settings, secret token and DLQ ring", () => {
  const m = createServiceBusPack().manifest;
  assert.equal(m.id, "service-bus");
  assert.equal(m.execution, "any");
  assert.deepEqual(m.settings?.map((s) => s.key), ["SERVICEBUS_ENDPOINT", "SERVICEBUS_TOKEN", "SERVICEBUS_ENTITIES"]);
  assert.equal(m.settings?.find((s) => s.key === "SERVICEBUS_TOKEN")?.secret, true);
  assert.deepEqual(m.rings?.map((r) => r.kind), ["service-bus-dlq"]);
});

test("service-bus: endpoints, entity lists and tokens are read as documented", () => {
  assert.deepEqual(parseEndpoint(`${ARM}/`), { mode: "arm", base: ARM, namespace: "acme-bus", portal: `https://portal.azure.com/#resource${new URL(ARM).pathname}/overview` });
  assert.deepEqual(parseEndpoint(`${DATA}/`), { mode: "data", base: DATA, namespace: "acme-bus" });
  assert.equal(parseEndpoint("javascript:alert(1)"), undefined);
  assert.equal(parseEndpoint("http://acme-bus.servicebus.windows.net"), undefined, "plain http would send the token in the clear");
  assert.equal(parseEndpoint(`${DATA}/orders`), undefined);
  assert.equal(parseEndpoint("https://user:pw@acme-bus.servicebus.windows.net"), undefined);
  assert.deepEqual(parseEntities(" orders, billing/invoices ,,orders"), [
    { name: "orders", queue: "orders" },
    { name: "billing/invoices", topic: "billing", sub: "invoices" },
  ]);
  assert.equal(authHeader("SharedAccessSignature sr=x&sig=y&se=1&skn=k"), "SharedAccessSignature sr=x&sig=y&se=1&skn=k");
  assert.equal(authHeader("Bearer abc"), "Bearer abc");
  assert.equal(authHeader("abc"), "Bearer abc");
});

test("service-bus: ARM discovery reads queues and subscriptions, and the DLQ radar raises needs, ring and avatar", async () => {
  const calls: Call[] = [];
  const pack = createServiceBusPack({ fetchFn: fakeApi(armRoutes(), calls), now: () => 1_000 });
  const topics: string[] = [];
  const ctx = testContext({ env: { SERVICEBUS_ENDPOINT: ARM, SERVICEBUS_TOKEN: "tok-arm" }, publish: (t) => void topics.push(...t) });
  await pack.refresh!(ctx);

  assert.deepEqual(topics, ["service-bus", "snapshot"]);
  assert.ok(calls.every((c) => c.auth === "Bearer tok-arm" && c.url.includes("api-version=2021-11-01")));
  const k = pack.kept()!;
  assert.equal(k.ok, true);
  assert.deepEqual(
    k.entities.map((e) => [e.name, e.kind, e.dlq, e.tone, e.backlog]),
    [
      ["billing/invoices", "subscription", 110, "bad", false],
      ["orders", "queue", 3, "warn", false],
      ["emails", "queue", 0, "ok", true],
      ["billing/audit", "subscription", 0, "ok", false],
    ],
  );

  const needs = pack.needs!(ctx);
  assert.deepEqual(
    needs.map((n) => [n.key, n.tone, n.ring]),
    [
      ["service-bus:subscription:billing/invoices:bad", "bad", "service-bus-dlq"],
      ["service-bus:queue:orders:warn", "warn", "service-bus-dlq"],
    ],
  );
  assert.match(needs[0]!.title, /billing\/invoices has 110 dead-lettered messages/);
  assert.equal(pack.avatar!(ctx)?.trouble?.level, "fire");
  assert.match(pack.bino!(ctx), /subscription billing\/invoices: 0 active, 110 dead-lettered/);
  assert.match(pack.bino!(ctx), /queue emails: 5000 active/);
});

test("service-bus: a need keeps its key and its since-time while the DLQ fills, and goes when it's drained", async () => {
  let t = 1_000;
  const p = new URL(ARM).pathname;
  let dead = 3;
  const fetchFn: typeof fetch = (input, init) => fakeApi({ [`${p}/queues/orders`]: armQueue("orders", { activeMessageCount: 1, deadLetterMessageCount: dead }) })(input, init);
  const pack = createServiceBusPack({ fetchFn, now: () => t });
  const ctx = testContext({ env: { SERVICEBUS_ENDPOINT: ARM, SERVICEBUS_TOKEN: "tok", SERVICEBUS_ENTITIES: "orders" } });

  await pack.refresh!(ctx);
  const first = pack.needs!(ctx)[0]!;
  t = 61_000;
  dead = 7;
  await pack.refresh!(ctx);
  const again = pack.needs!(ctx)[0]!;
  assert.equal(again.key, first.key, "same state, same key: rings once");
  assert.equal(again.at, 1_000, "since the first refresh that saw it");
  assert.equal(pack.avatar!(ctx)?.trouble?.level, "storm");

  dead = 150;
  await pack.refresh!(ctx);
  assert.notEqual(pack.needs!(ctx)[0]!.key, first.key, "turning bad rings once more");
  assert.equal(pack.avatar!(ctx)?.trouble?.level, "fire");

  dead = 0;
  await pack.refresh!(ctx);
  assert.deepEqual(pack.needs!(ctx), []);
  assert.equal(pack.avatar!(ctx), undefined);
  assert.equal(pack.kept()!.entities[0]!.dlqSince, undefined);
});

test("service-bus: the namespace's Atom feed with a SAS token, listed entities only, one missing", async () => {
  const calls: Call[] = [];
  const sas = "SharedAccessSignature sr=acme&sig=abc&se=9999999999&skn=dovre";
  const fetchFn = fakeApi(
    {
      "/orders": atomFeed("orders", [atomEntry("orders", "QueueDescription", { active: 2, dead: 4, scheduled: 1 })]),
      "/billing/Subscriptions/invoices": atomFeed("invoices", [atomEntry("invoices", "SubscriptionDescription", { active: 0, dead: 0, tdead: 2 })]),
      "/gone": atomFeed("gone", []),
    },
    calls,
  );
  const pack = createServiceBusPack({ fetchFn, now: () => 5 });
  await pack.refresh!(testContext({ env: { SERVICEBUS_ENDPOINT: DATA, SERVICEBUS_TOKEN: sas, SERVICEBUS_ENTITIES: "orders,billing/invoices,gone" } }));

  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.auth === sas && c.url.includes("api-version=2021-05")));
  const k = pack.kept()!;
  assert.equal(k.ok, true);
  assert.deepEqual(k.errors, ["gone: not found"]);
  assert.deepEqual(
    k.entities.map((e) => [e.name, e.kind, e.active, e.deadLetter, e.scheduled, e.transferDeadLetter, e.dlq]),
    [
      ["orders", "queue", 2, 4, 1, 0, 4],
      ["billing/invoices", "subscription", 0, 0, 0, 2, 2],
    ],
  );
});

test("service-bus: Atom discovery lists queues, topics and each topic's subscriptions", async () => {
  const fetchFn = fakeApi({
    "/$Resources/Queues": atomFeed("Queues", [atomEntry("orders", "QueueDescription", { active: 1, dead: 0 })]),
    "/$Resources/Topics": atomFeed("Topics", [`<entry><title type="text">billing</title><content><TopicDescription/></content></entry>`]),
    "/billing/Subscriptions": atomFeed("Subscriptions", [atomEntry("invoices", "SubscriptionDescription", { active: 0, dead: 1 })]),
  });
  const pack = createServiceBusPack({ fetchFn });
  await pack.refresh!(testContext({ env: { SERVICEBUS_ENDPOINT: DATA, SERVICEBUS_TOKEN: "tok" } }));
  assert.deepEqual(pack.kept()!.entities.map((e) => [e.name, e.dlq]), [["billing/invoices", 1], ["orders", 0]]);
});

test("service-bus: Atom counts are read from their own elements, and names are XML-decoded", () => {
  const [e] = parseAtom(atomFeed("Queues", [atomEntry("a&amp;b", "QueueDescription", { active: 7, dead: 0, tdead: 9 })]), "queue");
  assert.deepEqual(e, { name: "a&b", kind: "queue", active: 7, deadLetter: 0, scheduled: 0, transferDeadLetter: 9 });
});

test("service-bus: fails softly: no settings, a down API, and a failure after a good read keeps the last counts", async () => {
  const none = createServiceBusPack({ fetchFn: async () => assert.fail("no request without settings") });
  await none.refresh!(testContext({ env: { SERVICEBUS_ENDPOINT: "javascript:alert(1)", SERVICEBUS_TOKEN: "tok" } }));
  assert.equal(none.kept()!.ok, false);
  assert.match(none.kept()!.error!, /SERVICEBUS_ENDPOINT/);
  await none.refresh!(testContext({ env: { SERVICEBUS_ENDPOINT: DATA } }));
  assert.match(none.kept()!.error!, /SERVICEBUS_TOKEN/);

  let down = false;
  const good = fakeApi(armRoutes());
  const fetchFn: typeof fetch = async (input, init) => (down ? new Response("", { status: 503 }) : good(input, init));
  const pack = createServiceBusPack({ fetchFn, now: () => 10 });
  const ctx = testContext({ env: { SERVICEBUS_ENDPOINT: ARM, SERVICEBUS_TOKEN: "tok" } });
  await pack.refresh!(ctx);
  down = true;
  await pack.refresh!(ctx);
  const k = pack.kept()!;
  assert.equal(k.ok, false);
  assert.match(k.error!, /HTTP 503/);
  assert.equal(k.entities.length, 4, "last good counts kept");
  assert.equal(pack.needs!(ctx).length, 2, "needs don't flap on a hiccup");
  assert.match(String(serviceBusPage(k, parseEndpoint(ARM), 20)), /showing the last counts/);

  const throws = createServiceBusPack({ fetchFn: async () => Promise.reject(new Error("network down")) });
  await throws.refresh!(ctx);
  assert.equal(throws.kept()!.ok, false);
  assert.match(throws.kept()!.error!, /network down/);
});

test("service-bus: keeps counts and names only, never what a message says", async () => {
  const p = new URL(ARM).pathname;
  const leaky = { name: "orders", properties: { countDetails: { activeMessageCount: 1, deadLetterMessageCount: 1 }, lastMessage: BODY, deadLetterReason: BODY } };
  const pack = createServiceBusPack({ fetchFn: fakeApi({ [`${p}/queues`]: { value: [leaky] }, [`${p}/topics`]: { value: [] } }) });
  const ctx = testContext({ env: { SERVICEBUS_ENDPOINT: ARM, SERVICEBUS_TOKEN: "tok-secret-7f3a" } });
  await pack.refresh!(ctx);
  const everything = [JSON.stringify(pack.kept()), pack.bino!(ctx), JSON.stringify(pack.needs!(ctx)), String(serviceBusPage(pack.kept(), parseEndpoint(ARM))), String(serviceBusCard(pack.kept()!))].join("\n");
  assert.ok(!everything.includes(BODY), "a message's words got through");
  assert.ok(!everything.includes("tok-secret-7f3a"), "the token got through");
});

test("service-bus: hostile entity names and errors are inert on the page and the card", async () => {
  const k: ServiceBusKept = {
    at: 0,
    ok: false,
    error: H,
    errors: [H],
    countsAt: 0,
    entities: [
      { name: H, kind: "queue", active: 5000, deadLetter: 200, scheduled: 0, transferDeadLetter: 0, dlq: 200, tone: "bad", backlog: true, dlqSince: 1 },
      { name: `javascript:alert(1)`, kind: "subscription", active: 0, deadLetter: 1, scheduled: 0, transferDeadLetter: 0, dlq: 1, tone: "warn", backlog: false, dlqSince: 1 },
    ],
  };
  const hostileArm = parseEndpoint(`https://management.azure.com/subscriptions/x/resourceGroups/y/providers/Microsoft.ServiceBus/namespaces/${encodeURIComponent(H)}`);
  for (const out of [String(serviceBusPage(k, hostileArm, 10)), String(serviceBusCard(k, 10)), String(serviceBusCard({ ...k, entities: [] }, 10))]) {
    assert.ok(!out.includes("<script>") && !out.includes("<img"), "markup got through");
    assert.ok(!out.includes('href="javascript:'), "a javascript: link got through");
  }
  assert.match(String(serviceBusPage(undefined, undefined)), /Not read yet/);
});
