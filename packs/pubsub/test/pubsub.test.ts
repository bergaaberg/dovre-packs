/**
 * Google Cloud Pub/Sub Pack (`pubsub`) tests: fake Google APIs, Cloud Monitoring metrics join,
 * dead-letter radar (needs, rings, avatar), service-account JWT minting and caching, soft failure,
 * metadata-only enforcement, and hostile input.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import {
  authHeader,
  clearTokenCache,
  parseSubscriptions,
  resolveToken,
  validateProject,
} from "../data.ts";
import { createPubsubPack } from "../index.ts";
import { pubsubCard, pubsubPage } from "../view.ts";
import {
  AGE_BAD_SECS,
  AGE_WARN_SECS,
  avatarOf,
  binoOf,
  DLQ_BAD,
  formatAge,
  needsOf,
  type PubsubKept,
  RING,
} from "../watch.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
const SECRET_TOKEN = "ya29.secret-test-token-xyz123";
const BODY = "confidential user payload message body 9999-0000";

type Call = { url: string; auth: string | null; method?: string; body?: string };

function fakeApi(
  routes: Record<string, unknown>,
  calls: Call[] = [],
  onCall?: (call: Call) => void,
): typeof fetch {
  return async (input, init) => {
    const u = new URL(String(input));
    // Verify metadata-only: never call action verbs with :
    if (u.pathname.includes(":")) {
      assert.fail(`Forbidden verb in API path: ${u.pathname}`);
    }

    const auth = new Headers(init?.headers).get("authorization");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const callRec: Call = { url: u.href, auth, method, body };
    calls.push(callRec);
    onCall?.(callRec);

    const match = routes[u.pathname];
    if (match === undefined) {
      return new Response("not found", { status: 404 });
    }
    if (typeof match === "number") {
      return new Response("error", { status: match });
    }
    return new Response(typeof match === "string" ? match : JSON.stringify(match), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const mockSub = (id: string, topic: string, dlTopic?: string, maxDeliveryAttempts = 5) => ({
  name: `projects/acme-prod/subscriptions/${id}`,
  topic: `projects/acme-prod/topics/${topic}`,
  ackDeadlineSeconds: 10,
  deadLetterPolicy: dlTopic
    ? {
        deadLetterTopic: `projects/acme-prod/topics/${dlTopic}`,
        maxDeliveryAttempts,
      }
    : undefined,
});

const mockTimeSeries = (subId: string, val: number) => ({
  resource: {
    type: "pubsub_subscription",
    labels: {
      project_id: "acme-prod",
      subscription_id: subId,
    },
  },
  points: [
    {
      interval: {
        startTime: "2026-10-25T08:00:00Z",
        endTime: "2026-10-25T08:01:00Z",
      },
      value: {
        int64Value: String(val),
      },
    },
  ],
});

function defaultGcpRoutes(opts: {
  subs?: ReturnType<typeof mockSub>[];
  undelivered?: Record<string, number>;
  ages?: Record<string, number>;
  monitoringStatus?: number;
} = {}) {
  const subs = opts.subs ?? [
    mockSub("orders-sub", "orders", "orders-dlq"),
    mockSub("orders-dlq-sub", "orders-dlq"),
    mockSub("metrics-sub", "telemetry"),
  ];

  const undeliveredMap = opts.undelivered ?? {
    "orders-sub": 50,
    "orders-dlq-sub": 5,
    "metrics-sub": 1500, // backlog
  };

  const agesMap = opts.ages ?? {
    "orders-sub": 900, // 15m -> warn
    "orders-dlq-sub": 30,
    "metrics-sub": 60,
  };

  return {
    "/v1/projects/acme-prod/subscriptions": {
      subscriptions: subs,
    },
    "/v3/projects/acme-prod/timeSeries": opts.monitoringStatus ?? ((call: Call) => {
      const u = new URL(call.url);
      const filter = u.searchParams.get("filter") ?? "";
      if (filter.includes("num_undelivered_messages")) {
        return {
          timeSeries: Object.entries(undeliveredMap).map(([s, val]) => mockTimeSeries(s, val)),
        };
      }
      if (filter.includes("oldest_unacked_message_age")) {
        return {
          timeSeries: Object.entries(agesMap).map(([s, val]) => mockTimeSeries(s, val)),
        };
      }
      return { timeSeries: [] };
    }),
  };
}

function routerWrapper(routes: Record<string, unknown>, calls: Call[]): typeof fetch {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.includes(":")) {
      assert.fail(`Forbidden verb in API path: ${u.pathname}`);
    }
    const auth = new Headers(init?.headers).get("authorization");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: u.href, auth, method, body });

    const route = routes[u.pathname];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "number") return new Response("error", { status: route });
    if (typeof route === "function") {
      const res = (route as (c: Call) => unknown)({ url: u.href, auth, method, body });
      if (typeof res === "number") return new Response("error", { status: res });
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(typeof route === "string" ? route : JSON.stringify(route), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("pubsub: manifest declares settings, secret token, and ring kind", () => {
  const m = createPubsubPack().manifest;
  assert.equal(m.id, "pubsub");
  assert.equal(m.execution, "any");
  assert.deepEqual(m.settings?.map((s) => s.key), [
    "PUBSUB_PROJECT",
    "PUBSUB_TOKEN",
    "PUBSUB_SUBSCRIPTIONS",
  ]);
  assert.equal(m.settings?.find((s) => s.key === "PUBSUB_TOKEN")?.secret, true);
  assert.equal(m.settings?.find((s) => s.key === "PUBSUB_PROJECT")?.required, true);
  assert.deepEqual(m.rings?.map((r) => r.kind), [RING]);
});

test("pubsub: settings parsing validates project id and subscription list", () => {
  assert.equal(validateProject("acme-prod-1"), "acme-prod-1");
  assert.equal(validateProject("example.com:prod-cluster"), "example.com:prod-cluster");
  assert.equal(validateProject(""), undefined);
  assert.equal(validateProject("ab"), undefined, "too short");
  assert.equal(validateProject("javascript:alert(1)"), undefined);
  assert.equal(validateProject("<script>alert(1)</script>"), undefined);

  assert.deepEqual(parseSubscriptions("sub-1, sub-2, projects/p/subscriptions/sub-3"), [
    "sub-1",
    "sub-2",
    "sub-3",
  ]);
  assert.deepEqual(parseSubscriptions("  sub-a , , sub-b  "), ["sub-a", "sub-b"]);
  assert.deepEqual(parseSubscriptions(""), []);

  assert.equal(authHeader("my-token"), "Bearer my-token");
  assert.equal(authHeader("Bearer my-token"), "Bearer my-token");
});

test("pubsub: formats duration ages properly", () => {
  assert.equal(formatAge(undefined), "—");
  assert.equal(formatAge(30), "30s");
  assert.equal(formatAge(600), "10m");
  assert.equal(formatAge(3600), "1h");
  assert.equal(formatAge(3960), "1h 6m");
});

test("pubsub: joins subscription metadata with Cloud Monitoring metrics and assigns tones", async () => {
  const calls: Call[] = [];
  const fetchFn = routerWrapper(defaultGcpRoutes(), calls);
  const pack = createPubsubPack({ fetchFn, now: () => 1_700_000_000_000 });
  const ctx = testContext({
    env: {
      PUBSUB_PROJECT: "acme-prod",
      PUBSUB_TOKEN: SECRET_TOKEN,
    },
  });

  await pack.refresh!(ctx);
  const kept = pack.kept()!;
  assert.equal(kept.ok, true);
  assert.equal(kept.subscriptions.length, 3);

  // orders-sub has age 900s (> 600s warn threshold) -> stuckTone: warn
  const orders = kept.subscriptions.find((s) => s.id === "orders-sub")!;
  assert.equal(orders.stuckTone, "warn");
  assert.equal(orders.numUndelivered, 50);
  assert.equal(orders.oldestAgeSecs, 900);
  assert.equal(orders.isDeadLetter, false);
  assert.equal(orders.deadLetterTopicId, "orders-dlq");

  // orders-dlq-sub topic is orders-dlq, which matches orders-sub's deadLetterTopic -> isDeadLetter: true
  // has 5 unacked (> 0) -> dlqTone: warn
  const dlqSub = kept.subscriptions.find((s) => s.id === "orders-dlq-sub")!;
  assert.equal(dlqSub.isDeadLetter, true);
  assert.equal(dlqSub.dlqTone, "warn");
  assert.equal(dlqSub.tone, "warn");

  // metrics-sub has 1500 unacked -> backlog: true
  const metrics = kept.subscriptions.find((s) => s.id === "metrics-sub")!;
  assert.equal(metrics.backlog, true);
  assert.equal(metrics.tone, "ok");

  // Needs generated
  const needs = pack.needs!(ctx);
  assert.equal(needs.length, 2);
  assert.deepEqual(
    needs.map((n) => n.key),
    ["pubsub:orders-sub:stuck:warn", "pubsub:orders-dlq-sub:dlq:warn"],
  );
  assert.equal(needs[0]?.ring, RING);

  // Avatar has storm trouble for warnings
  const avatar = pack.avatar!(ctx);
  assert.equal(avatar?.trouble?.level, "storm");
  assert.match(avatar?.trouble?.why ?? "", /2 subscriptions need attention/);

  // Bino output contains names and numbers only
  const bino = pack.bino!(ctx);
  assert.match(bino, /acme-prod/);
  assert.match(bino, /orders-sub/);
  assert.match(bino, /50 unacked/);
});

test("pubsub: flags dead-letter topics that no subscription reads as orphan", async () => {
  const calls: Call[] = [];
  const routes = defaultGcpRoutes({
    subs: [
      mockSub("events-sub", "events", "unmonitored-dlq"),
    ],
    undelivered: { "events-sub": 0 },
    ages: { "events-sub": 0 },
  });
  const fetchFn = routerWrapper(routes, calls);
  const pack = createPubsubPack({ fetchFn });
  const ctx = testContext({
    env: { PUBSUB_PROJECT: "acme-prod", PUBSUB_TOKEN: SECRET_TOKEN },
  });

  await pack.refresh!(ctx);
  const kept = pack.kept()!;
  assert.deepEqual(kept.orphanDeadLetterTopics, ["unmonitored-dlq"]);

  const page = String(pubsubPage(kept, "acme-prod"));
  assert.match(page, /unmonitored-dlq/);
  assert.match(page, /no subscription reading/);
});

test("pubsub: stable keys and since-times across refreshes, escalating to bad", async () => {
  let age = 700;
  let dlqCount = 10;
  const routes: Record<string, unknown> = {
    "/v1/projects/acme-prod/subscriptions": {
      subscriptions: [
        mockSub("orders-sub", "orders", "orders-dlq"),
        mockSub("orders-dlq-sub", "orders-dlq"),
      ],
    },
    "/v3/projects/acme-prod/timeSeries": (call: Call) => {
      const u = new URL(call.url);
      const filter = u.searchParams.get("filter") ?? "";
      if (filter.includes("num_undelivered_messages")) {
        return {
          timeSeries: [
            mockTimeSeries("orders-sub", 10),
            mockTimeSeries("orders-dlq-sub", dlqCount),
          ],
        };
      }
      return {
        timeSeries: [
          mockTimeSeries("orders-sub", age),
          mockTimeSeries("orders-dlq-sub", 10),
        ],
      };
    },
  };

  const calls: Call[] = [];
  let currentTime = 1_000_000;
  const pack = createPubsubPack({
    fetchFn: routerWrapper(routes, calls),
    now: () => currentTime,
  });
  const ctx = testContext({
    env: { PUBSUB_PROJECT: "acme-prod", PUBSUB_TOKEN: SECRET_TOKEN },
  });

  // Turn 1: warned
  await pack.refresh!(ctx);
  let kept = pack.kept()!;
  let orders = kept.subscriptions.find((s) => s.id === "orders-sub")!;
  let dlq = kept.subscriptions.find((s) => s.id === "orders-dlq-sub")!;
  assert.equal(orders.stuckSince, 1_000_000);
  assert.equal(dlq.dlqSince, 1_000_000);
  assert.equal(orders.stuckTone, "warn");
  assert.equal(dlq.dlqTone, "warn");

  // Turn 2: 5 minutes later, still warned -> since timestamps must not change
  currentTime = 1_300_000;
  age = 1000;
  await pack.refresh!(ctx);
  kept = pack.kept()!;
  orders = kept.subscriptions.find((s) => s.id === "orders-sub")!;
  dlq = kept.subscriptions.find((s) => s.id === "orders-dlq-sub")!;
  assert.equal(orders.stuckSince, 1_000_000);
  assert.equal(dlq.dlqSince, 1_000_000);
  let needs = pack.needs!(ctx);
  assert.deepEqual(needs.map((n) => n.key).sort(), [
    "pubsub:orders-dlq-sub:dlq:warn",
    "pubsub:orders-sub:stuck:warn",
  ]);

  // Turn 3: escalate! age > 3600 (bad) and dlqCount >= 100 (bad)
  currentTime = 1_600_000;
  age = 3700;
  dlqCount = 150;
  await pack.refresh!(ctx);
  kept = pack.kept()!;
  orders = kept.subscriptions.find((s) => s.id === "orders-sub")!;
  dlq = kept.subscriptions.find((s) => s.id === "orders-dlq-sub")!;
  assert.equal(orders.stuckTone, "bad");
  assert.equal(dlq.dlqTone, "bad");
  // Timestamps preserved from first troubled time
  assert.equal(orders.stuckSince, 1_000_000);
  assert.equal(dlq.dlqSince, 1_000_000);

  needs = pack.needs!(ctx);
  assert.deepEqual(needs.map((n) => n.key).sort(), [
    "pubsub:orders-dlq-sub:dlq:bad",
    "pubsub:orders-sub:stuck:bad",
  ]);
  const avatar = pack.avatar!(ctx);
  assert.equal(avatar?.trouble?.level, "fire");

  // Turn 4: drained/caught up -> needs clear!
  age = 10;
  dlqCount = 0;
  await pack.refresh!(ctx);
  assert.equal(pack.needs!(ctx).length, 0);
  assert.equal(pack.avatar!(ctx), undefined);
});

test("pubsub: service account JSON mints RS256 JWT, caches token and refreshes on expiry", async () => {
  clearTokenCache();

  // Generate real WebCrypto RSA keypair for the fake service account
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;

  const saJson = JSON.stringify({
    type: "service_account",
    project_id: "acme-prod",
    client_email: "test-sa@acme-prod.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: "https://oauth2.googleapis.com/token",
  });

  let tokenRequests = 0;
  const calls: Call[] = [];
  const fakeTokenFetch: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === "/token") {
      tokenRequests++;
      const body = String(init?.body);
      const params = new URLSearchParams(body);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = params.get("assertion") ?? "";
      const [headB64, payB64, sigB64] = assertion.split(".");
      assert.ok(headB64 && payB64 && sigB64);

      // Verify JWT signature using public key!
      const data = new TextEncoder().encode(`${headB64}.${payB64}`);
      const rawSig = atob(sigB64.replace(/-/g, "+").replace(/_/g, "/"));
      const sigBuf = new Uint8Array(rawSig.length);
      for (let i = 0; i < rawSig.length; i++) sigBuf[i] = rawSig.charCodeAt(i);

      const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keyPair.publicKey, sigBuf, data);
      assert.equal(verified, true, "JWT assertion signature must verify");

      return new Response(JSON.stringify({ access_token: `token-${tokenRequests}`, expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Default subscriptions & monitoring routes
    const routes = defaultGcpRoutes();
    return routerWrapper(routes, calls)(input, init);
  };

  let testNow = 1_000_000;
  const pack = createPubsubPack({ fetchFn: fakeTokenFetch, now: () => testNow });
  const ctx = testContext({
    env: { PUBSUB_PROJECT: "acme-prod", PUBSUB_TOKEN: saJson },
  });

  // First refresh: exchanges token
  await pack.refresh!(ctx);
  assert.equal(tokenRequests, 1);
  assert.equal(pack.kept()!.ok, true);

  // Second refresh: uses cached token, does NOT hit token endpoint
  testNow += 60_000;
  await pack.refresh!(ctx);
  assert.equal(tokenRequests, 1, "token should have been cached");

  // Advance time past expiry (3600s - 60s cache buffer): refreshes token
  testNow += 3600 * 1000;
  await pack.refresh!(ctx);
  assert.equal(tokenRequests, 2, "token refreshed after expiry");
});

test("pubsub: soft failure on monitoring 403, and keeps last counts on full failure", async () => {
  // Case 1: Subscriptions work, but Monitoring returns 403 Forbidden
  const routes403 = defaultGcpRoutes({ monitoringStatus: 403 });
  const calls: Call[] = [];
  const pack = createPubsubPack({ fetchFn: routerWrapper(routes403, calls) });
  const ctx = testContext({
    env: { PUBSUB_PROJECT: "acme-prod", PUBSUB_TOKEN: SECRET_TOKEN },
  });

  await pack.refresh!(ctx);
  let kept = pack.kept()!;
  assert.equal(kept.ok, true, "subscriptions still ok");
  assert.equal(kept.subscriptions.length, 3);
  assert.ok(kept.errors.length > 0);
  assert.match(kept.errors[0]!, /Cloud Monitoring/);

  // Case 2: Full API failure after good read keeps last good counts
  let down = false;
  const goodRoutes = defaultGcpRoutes();
  const flakyFetch: typeof fetch = async (input, init) => {
    if (down) return new Response("service unavailable", { status: 503 });
    return routerWrapper(goodRoutes, [])(input, init);
  };

  const durablePack = createPubsubPack({ fetchFn: flakyFetch, now: () => 10_000 });
  await durablePack.refresh!(ctx);
  assert.equal(durablePack.kept()!.ok, true);
  assert.equal(durablePack.kept()!.subscriptions.length, 3);

  // Go down
  down = true;
  await durablePack.refresh!(ctx);
  kept = durablePack.kept()!;
  assert.equal(kept.ok, false);
  assert.match(kept.error!, /503/);
  assert.equal(kept.subscriptions.length, 3, "last subscriptions kept");
  assert.equal(durablePack.needs!(ctx).length, 2, "needs do not flap on hiccup");

  const page = String(pubsubPage(kept, "acme-prod", 20_000));
  assert.match(page, /showing the last counts/);

  // Case 3: Thrown network exception caught cleanly
  const throwsPack = createPubsubPack({
    fetchFn: async () => Promise.reject(new Error("socket timeout")),
  });
  await throwsPack.refresh!(ctx);
  assert.equal(throwsPack.kept()!.ok, false);
  assert.match(throwsPack.kept()!.error!, /socket timeout/);
});

test("pubsub: metadata only: never logs token, never calls action verbs, never leaks message payloads", async () => {
  const leakySub = {
    ...mockSub("leaky-sub", "orders"),
    payload: BODY,
    message: BODY,
    lastPayload: BODY,
  };

  const routes = defaultGcpRoutes({
    subs: [leakySub],
    undelivered: { "leaky-sub": 10 },
    ages: { "leaky-sub": 100 },
  });

  const calls: Call[] = [];
  const pack = createPubsubPack({ fetchFn: routerWrapper(routes, calls) });
  const ctx = testContext({
    env: {
      PUBSUB_PROJECT: "acme-prod",
      PUBSUB_TOKEN: SECRET_TOKEN,
    },
  });

  await pack.refresh!(ctx);
  const everything = [
    JSON.stringify(pack.kept()),
    pack.bino!(ctx),
    JSON.stringify(pack.needs!(ctx)),
    String(pubsubPage(pack.kept(), "acme-prod")),
    String(pubsubCard(pack.kept()!)),
  ].join("\n");

  assert.ok(!everything.includes(BODY), "message payload must never reach view, bino, or state");
  assert.ok(!everything.includes(SECRET_TOKEN), "secret token must never leak into output");

  // Verify none of the calls contain forbidden pull/ack/seek verbs
  for (const c of calls) {
    assert.ok(!c.url.includes(":pull"));
    assert.ok(!c.url.includes(":acknowledge"));
    assert.ok(!c.url.includes(":modifyAckDeadline"));
    assert.ok(!c.url.includes(":seek"));
  }
});

test("pubsub: hostile input is inert in page, card, links, and notices", () => {
  const kept: PubsubKept = {
    at: 0,
    ok: false,
    error: H,
    errors: [H],
    countsAt: 0,
    project: H,
    subscriptions: [
      {
        id: H,
        name: `projects/p/subscriptions/${H}`,
        topic: `projects/p/topics/${H}`,
        topicId: H,
        deadLetterTopic: `projects/p/topics/${H}-dlq`,
        deadLetterTopicId: `${H}-dlq`,
        maxDeliveryAttempts: 5,
        numUndelivered: 5000,
        oldestAgeSecs: 4000,
        isDeadLetter: true,
        tone: "bad",
        backlog: true,
        stuckTone: "bad",
        dlqTone: "bad",
        stuckSince: 1,
        dlqSince: 1,
      },
      {
        id: "javascript:alert(1)",
        name: "projects/p/subscriptions/javascript:alert(1)",
        topic: "projects/p/topics/clean",
        topicId: "clean",
        numUndelivered: 1,
        oldestAgeSecs: 10,
        isDeadLetter: false,
        tone: "warn",
        backlog: false,
        dlqTone: "warn",
        stuckSince: 1,
      },
    ],
    orphanDeadLetterTopics: [H],
  };

  const renderedPage = String(pubsubPage(kept, H, 10));
  const renderedCard = String(pubsubCard(kept, 10));

  for (const out of [renderedPage, renderedCard]) {
    assert.ok(!out.includes("<script>"), "script tag must not appear raw in output");
    assert.ok(!out.includes("<img src=x"), "img onerror tag must not appear raw in output");
    assert.ok(!out.includes('href="javascript:'), "javascript: link must never be rendered in href");
  }

  // Not read yet page
  assert.match(String(pubsubPage(undefined, undefined)), /Not read yet/);
});
