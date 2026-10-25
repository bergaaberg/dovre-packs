/**
 * Kafka Pack (`kafka`): consumer group lag, DLQ topics and partition health from an HTTP metrics
 * endpoint (Redpanda Admin API, Confluent REST Proxy v3, or a lag exporter). Metadata only: group
 * and topic names, lags and offsets; a message payload never enters what this pack keeps.
 */
import type { PackContext } from "dovre/packs/types.ts";

const cut = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]+/g, " ").trim().slice(0, max) : fallback);

export type GroupLag = {
  /** `group/topic`: stable while the same pair is behind. */
  key: string;
  group: string;
  topic: string;
  totalLag: number;
  maxLagPartition: number;
  partitions: number;
  /** Its topic is a dead-letter one (`*.dlq`, `*-dlt`…). */
  dlq: boolean;
};

export type ClusterHealth = { brokers?: number; underReplicatedPartitions: number; offlinePartitions?: number; topics?: number };

/** One lag sample per refresh, for growing-lag detection. */
export type LagSample = { at: number; lag: number };

export type KafkaKept = {
  at: number;
  ok: boolean;
  error?: string;
  url?: string;
  groups: GroupLag[];
  cluster?: ClusterHealth;
  /** The last samples of each `group/topic` that is behind, oldest first (at most 12 each). */
  history: Map<string, LagSample[]>;
};

export const LAG_WARN_DEFAULT = 1000;
export const HISTORY_MAX = 12;
/** Samples in a row that must each be higher for lag to count as growing. */
export const GROWING_RUNS = 3;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
const dlqTopic = (topic: string) => /(?:\.|^-)(?:dlq|dlt)(?:$|[.-])/i.test(topic) || /(?:^|[.-])(?:dlq|dlt)(?:$|[.-])/i.test(topic);
/** One raw group row, as far as it names a group and a topic. */
function toGroupLag(row: unknown): GroupLag | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>; // values are re-checked below, field by field
  const group = cut(r.group ?? r.groupId ?? r.consumerGroup, 120);
  const topic = cut(r.topic ?? r.topicName, 200);
  if (!group || !topic) return null;
  return {
    key: `${group}/${topic}`,
    group,
    topic,
    totalLag: num(r.totalLag ?? r.lag),
    maxLagPartition: num(r.maxLagPartition ?? r.partition),
    partitions: num(r.partitions),
    dlq: dlqTopic(topic),
  };
}

/** The endpoint's JSON: either `{groups, cluster}` or a bare array of group rows. */
export function parseKafka(j: unknown): { groups: GroupLag[]; cluster?: ClusterHealth } {
  const rows: unknown[] = Array.isArray(j)
    ? j
    : j && typeof j === "object" && "groups" in j && Array.isArray(j.groups)
      ? j.groups
      : [];
  const groups = rows.flatMap((n) => {
    const g = toGroupLag(n);
    return g ? [g] : [];
  });
  const c = j && typeof j === "object" && "cluster" in j && j.cluster && typeof j.cluster === "object" ? (j.cluster as Record<string, unknown>) : undefined; // fields re-checked below
  return {
    groups,
    cluster: c
      ? {
          brokers: typeof c.brokers === "number" ? num(c.brokers) : undefined,
          underReplicatedPartitions: num(c.underReplicatedPartitions),
          offlinePartitions: typeof c.offlinePartitions === "number" ? num(c.offlinePartitions) : undefined,
          topics: typeof c.topics === "number" ? num(c.topics) : undefined,
        }
      : undefined,
  };
}

/** The lag warn threshold, as settings say it. */
export function lagWarn(env: Record<string, string | undefined>): number {
  const v = Number(env.KAFKA_LAG_WARN);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : LAG_WARN_DEFAULT;
}

export async function readKafka(
  ctx: PackContext,
  kept: KafkaKept | undefined,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<KafkaKept> {
  const url = (ctx.env.KAFKA_ADMIN_URL ?? "").trim();
  const token = (ctx.env.KAFKA_TOKEN ?? "").trim();
  const history = kept?.history ?? new Map<string, LagSample[]>();
  if (!url || !/^https?:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(url)) {
    return { at: now, ok: false, error: "Set KAFKA_ADMIN_URL to a lag endpoint (Redpanda Admin API, Confluent REST Proxy v3, or a lag exporter).", groups: [], cluster: undefined, history };
  }
  try {
    const res = await fetchFn(url, {
      headers: { accept: "application/json", ...(token ? { authorization: /^[Bb]asic\s/.test(token) ? token : `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { at: now, ok: false, url, error: `Kafka endpoint HTTP ${res.status}`, groups: [], cluster: undefined, history };
    const parsed = parseKafka(await res.json());
    for (const g of parsed.groups) {
      const samples = [...(history.get(g.key) ?? []), { at: now, lag: g.totalLag }].slice(-HISTORY_MAX);
      history.set(g.key, samples);
    }
    for (const key of history.keys()) if (!parsed.groups.some((g) => g.key === key)) history.delete(key);
    return { at: now, ok: true, url, groups: parsed.groups, cluster: parsed.cluster, history };
  } catch (e) {
    return { at: now, ok: false, url, error: cut(String((e as Error)?.message ?? e), 180, "Kafka endpoint unreachable"), groups: [], cluster: undefined, history };
  }
}

/** What a group's samples say: behind the threshold, or growing across consecutive refreshes. */
export function lagState(kept: KafkaKept, g: GroupLag, warn: number): { level: "bad" | "warn" | "ok"; why: string } {
  if (g.dlq && g.totalLag > 0) return { level: "bad", why: `dead-letter ${g.topic} is ${g.totalLag} behind` };
  if (g.totalLag >= warn) return { level: g.totalLag >= warn * 10 ? "bad" : "warn", why: `${g.totalLag} behind on ${g.topic}` };
  // Growing: up on each of the last GROWING_RUNS refreshes, and past a tenth of the threshold,
  // so lag that wobbles (1 → 2) doesn't ring.
  const last = (kept.history.get(g.key) ?? []).slice(-GROWING_RUNS);
  const rising = last.length === GROWING_RUNS && last.every((s, i) => i === 0 || s.lag > last[i - 1]!.lag);
  if (rising && g.totalLag >= warn / 10) return { level: "warn", why: `growing (${last[0]!.lag} → ${g.totalLag}) on ${g.topic}` };
  return { level: "ok", why: "" };
}
