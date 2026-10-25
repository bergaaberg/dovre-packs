/**
 * Google Cloud Pub/Sub Pack (`pubsub`): reads subscription metadata and Cloud Monitoring
 * metrics (unacked message count and oldest unacked message age). Counts and entity names only:
 * it never pulls, acknowledges, or stores message payloads.
 *
 * Runs locally and hosted on Cloudflare Workers (`execution: "any"`).
 */

export type PubsubSubRaw = {
  name: string;
  topic: string;
  deadLetterPolicy?: {
    deadLetterTopic?: string;
    maxDeliveryAttempts?: number;
  };
  ackDeadlineSeconds?: number;
  state?: string;
};

export type PubsubSubscription = {
  id: string;
  name: string;
  topic: string;
  topicId: string;
  deadLetterTopic?: string;
  deadLetterTopicId?: string;
  maxDeliveryAttempts?: number;
  ackDeadlineSeconds?: number;
  state?: string;
  numUndelivered?: number;
  oldestAgeSecs?: number;
  isDeadLetter: boolean;
};

export type PubsubRead =
  | {
      ok: true;
      project: string;
      subscriptions: PubsubSubscription[];
      orphanDeadLetterTopics: string[];
      errors: string[];
    }
  | {
      ok: false;
      error: string;
    };

export const MAX_SUBSCRIPTIONS = 100;
export const TIMEOUT_MS = 10_000;

/** Valid GCP project ID: 6-30 chars, lowercase letters/digits/hyphens, optional domain prefix. */
export const PROJECT_ID_REGEX = /^(?:[a-z0-9-.]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function validateProject(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  return PROJECT_ID_REGEX.test(s) ? s : undefined;
}

/** Parses comma-separated subscription names or paths. */
export function parseSubscriptions(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim().replace(/^\/+|\/+$/g, "");
    if (!s) continue;
    const short = s.startsWith("projects/") ? s.split("/").pop()! : s;
    if (short && !out.includes(short)) out.push(short);
    if (out.length >= MAX_SUBSCRIPTIONS) break;
  }
  return out;
}

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
};

const saTokenCache = new Map<string, TokenCacheEntry>();

export function clearTokenCache(): void {
  saTokenCache.clear();
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN[ A-Z0-9_-]+-----/g, "")
    .replace(/-----END[ A-Z0-9_-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bufToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Resolves PUBSUB_TOKEN: either returns a bearer token as-is, or mints an OAuth2
 * access token from a service account JSON key via JWT bearer assertion.
 */
export async function resolveToken(
  tokenRaw: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
  now: number,
): Promise<string> {
  const trimmed = tokenRaw.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }

  let sa: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    sa = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid service account JSON");
  }

  if (!sa.client_email || !sa.private_key) {
    throw new Error("Service account JSON must contain client_email and private_key");
  }

  const cached = saTokenCache.get(sa.client_email);
  if (cached && now < cached.expiresAt) {
    return cached.token;
  }

  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  let key: CryptoKey;
  try {
    const pkcs8Buf = pemToPkcs8(sa.private_key);
    key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Buf,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("Failed to parse service account private key");
  }

  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: tokenUri,
    iat,
    exp: iat + 3600,
  };

  const headerB64 = toBase64Url(JSON.stringify(header));
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const toSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, toSign);
  const assertion = `${headerB64}.${payloadB64}.${bufToBase64Url(sig)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetchFn(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Token exchange response missing access_token");
  }

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  saTokenCache.set(sa.client_email, {
    token: data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000,
  });

  return data.access_token;
}

export function authHeader(token: string): string {
  const t = token.trim();
  return /^Bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

/**
 * Reads Pub/Sub subscriptions and Cloud Monitoring metrics.
 * Never throws.
 */
export async function readPubsub(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<PubsubRead> {
  const project = validateProject(env.PUBSUB_PROJECT);
  const tokenRaw = (env.PUBSUB_TOKEN ?? "").trim();

  if (!project) {
    return {
      ok: false,
      error: "Set PUBSUB_PROJECT to a valid GCP Project ID (e.g. my-project-123).",
    };
  }
  if (!tokenRaw) {
    return {
      ok: false,
      error: "Set PUBSUB_TOKEN to an OAuth2 access token or service account private key JSON.",
    };
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let resolvedToken: string;
  try {
    resolvedToken = await resolveToken(tokenRaw, fetchFn, signal, now);
  } catch (e) {
    return {
      ok: false,
      error: `Authentication failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
    };
  }

  const headers = {
    authorization: authHeader(resolvedToken),
    accept: "application/json",
  };

  const wanted = parseSubscriptions(env.PUBSUB_SUBSCRIPTIONS);
  const rawSubs: PubsubSubRaw[] = [];
  const errors: string[] = [];

  try {
    if (wanted.length > 0) {
      await Promise.all(
        wanted.map(async (subName) => {
          try {
            const url = `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(project)}/subscriptions/${encodeURIComponent(subName)}`;
            const res = await fetchFn(url, { headers, signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as PubsubSubRaw;
            if (!body.name) errors.push(`${subName}: invalid subscription response`);
            else rawSubs.push(body);
          } catch (e) {
            errors.push(`${subName}: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
          }
        }),
      );
      if (!rawSubs.length && errors.length) {
        return { ok: false, error: errors[0]! };
      }
    } else {
      const url = `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(project)}/subscriptions?pageSize=${MAX_SUBSCRIPTIONS}`;
      const res = await fetchFn(url, { headers, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { subscriptions?: PubsubSubRaw[] };
      rawSubs.push(...(body.subscriptions ?? []).slice(0, MAX_SUBSCRIPTIONS));
    }
  } catch (e) {
    return {
      ok: false,
      error: `Subscriptions fetch failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
    };
  }

  // Cloud Monitoring metrics queries
  const metricsMap = new Map<string, { numUndelivered?: number; oldestAgeSecs?: number }>();
  const startTime = new Date(now - 10 * 60_000).toISOString();
  const endTime = new Date(now).toISOString();

  const getMetric = async (metricType: string): Promise<Array<{ subId: string; value: number }>> => {
    const filter = `metric.type="${metricType}" AND resource.type="pubsub_subscription"`;
    const q = new URLSearchParams({
      filter,
      "interval.startTime": startTime,
      "interval.endTime": endTime,
    });
    const url = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${q.toString()}`;
    const res = await fetchFn(url, { headers, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      timeSeries?: Array<{
        resource?: { labels?: { subscription_id?: string } };
        points?: Array<{ value?: { int64Value?: string } }>;
      }>;
    };
    const out: Array<{ subId: string; value: number }> = [];
    for (const ts of body.timeSeries ?? []) {
      const subId = ts.resource?.labels?.subscription_id;
      const pt = ts.points?.[0]?.value?.int64Value;
      if (subId && pt !== undefined) {
        const n = parseInt(pt, 10);
        if (Number.isFinite(n) && n >= 0) {
          out.push({ subId, value: n });
        }
      }
    }
    return out;
  };

  const [undeliveredRes, ageRes] = await Promise.allSettled([
    getMetric("pubsub.googleapis.com/subscription/num_undelivered_messages"),
    getMetric("pubsub.googleapis.com/subscription/oldest_unacked_message_age"),
  ]);

  if (undeliveredRes.status === "fulfilled") {
    for (const item of undeliveredRes.value) {
      const entry = metricsMap.get(item.subId) ?? {};
      entry.numUndelivered = item.value;
      metricsMap.set(item.subId, entry);
    }
  } else {
    errors.push(
      `Cloud Monitoring undelivered messages: ${String((undeliveredRes.reason as Error)?.message ?? undeliveredRes.reason).slice(0, 100)}`,
    );
  }

  if (ageRes.status === "fulfilled") {
    for (const item of ageRes.value) {
      const entry = metricsMap.get(item.subId) ?? {};
      entry.oldestAgeSecs = item.value;
      metricsMap.set(item.subId, entry);
    }
  } else {
    errors.push(
      `Cloud Monitoring oldest unacked age: ${String((ageRes.reason as Error)?.message ?? ageRes.reason).slice(0, 100)}`,
    );
  }

  // Dead-letter topics discovery
  const dlTopicSet = new Set<string>();
  const dlTopicShortSet = new Set<string>();
  for (const sub of rawSubs) {
    if (sub.deadLetterPolicy?.deadLetterTopic) {
      dlTopicSet.add(sub.deadLetterPolicy.deadLetterTopic);
      const short = sub.deadLetterPolicy.deadLetterTopic.split("/").pop();
      if (short) dlTopicShortSet.add(short);
    }
  }

  const subscriptions: PubsubSubscription[] = rawSubs.map((raw) => {
    const id = raw.name.split("/").pop() || raw.name;
    const topicId = raw.topic.split("/").pop() || raw.topic;
    const dlTopicId = raw.deadLetterPolicy?.deadLetterTopic
      ? raw.deadLetterPolicy.deadLetterTopic.split("/").pop()
      : undefined;
    const isDeadLetter = dlTopicSet.has(raw.topic) || dlTopicShortSet.has(topicId);
    const metrics = metricsMap.get(id);

    return {
      id,
      name: raw.name,
      topic: raw.topic,
      topicId,
      deadLetterTopic: raw.deadLetterPolicy?.deadLetterTopic,
      deadLetterTopicId: dlTopicId,
      maxDeliveryAttempts: raw.deadLetterPolicy?.maxDeliveryAttempts,
      ackDeadlineSeconds: raw.ackDeadlineSeconds,
      state: raw.state,
      numUndelivered: metrics?.numUndelivered,
      oldestAgeSecs: metrics?.oldestAgeSecs,
      isDeadLetter,
    };
  });

  const orphanDeadLetterTopics: string[] = [];
  for (const dlt of dlTopicSet) {
    const short = dlt.split("/").pop() || dlt;
    const hasReader = subscriptions.some((s) => s.topic === dlt || s.topicId === short);
    if (!hasReader && !orphanDeadLetterTopics.includes(short)) {
      orphanDeadLetterTopics.push(short);
    }
  }

  return {
    ok: true,
    project,
    subscriptions,
    orphanDeadLetterTopics,
    errors,
  };
}
