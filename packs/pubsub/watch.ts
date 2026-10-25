/**
 * Google Cloud Pub/Sub Pack (`pubsub`): radar for stuck unacked messages and dead-letter
 * topic depth. A subscription whose oldest unacked message exceeds the threshold or a DLQ
 * with unacked messages creates a need, rings the pubsub-stuck bell, and sets the avatar.
 */
import type { AvatarFeed, PackNeed } from "dovre/packs/types.ts";
import type { PubsubRead, PubsubSubscription } from "./data.ts";

/** Oldest unacked message age threshold for warning (10 minutes). */
export const AGE_WARN_SECS = 600;
/** Oldest unacked message age threshold for critical/bad (1 hour). */
export const AGE_BAD_SECS = 3600;
/** Dead-letter subscription unacked count for critical/bad. */
export const DLQ_BAD = 100;
/** Backlog threshold for display notice (1000 messages). */
export const BACKLOG_WARN = 1000;
/** Manifest ring kind. */
export const RING = "pubsub-stuck";

export type WatchedSub = PubsubSubscription & {
  tone: "ok" | "warn" | "bad";
  backlog: boolean;
  stuckTone?: "warn" | "bad";
  dlqTone?: "warn" | "bad";
  stuckSince?: number;
  dlqSince?: number;
};

export type PubsubKept = {
  at: number;
  ok: boolean;
  error?: string;
  errors: string[];
  countsAt?: number;
  project: string;
  subscriptions: WatchedSub[];
  orphanDeadLetterTopics: string[];
};

export const n = (v: number) => v.toLocaleString("en-US");
export const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

export function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

/**
 * Derives watched subscriptions and retains previous timestamps (stuckSince, dlqSince)
 * while conditions persist. Failed reads keep last good counts to avoid alert flapping.
 */
export function watch(prev: PubsubKept | undefined, read: PubsubRead, now: number): PubsubKept {
  if (!read.ok) {
    return {
      at: now,
      ok: false,
      error: read.error,
      errors: [],
      countsAt: prev?.countsAt,
      project: prev?.project ?? "",
      subscriptions: prev?.subscriptions ?? [],
      orphanDeadLetterTopics: prev?.orphanDeadLetterTopics ?? [],
    };
  }

  const before = new Map((prev?.subscriptions ?? []).map((s) => [s.id, s]));

  const subscriptions: WatchedSub[] = read.subscriptions.map((s) => {
    const was = before.get(s.id);
    const unacked = s.numUndelivered ?? 0;
    const age = s.oldestAgeSecs;

    const backlog = unacked >= BACKLOG_WARN;

    let stuckTone: "warn" | "bad" | undefined;
    if (age !== undefined) {
      if (age >= AGE_BAD_SECS) stuckTone = "bad";
      else if (age >= AGE_WARN_SECS) stuckTone = "warn";
    }

    let dlqTone: "warn" | "bad" | undefined;
    if (s.isDeadLetter && s.numUndelivered !== undefined) {
      if (unacked >= DLQ_BAD) dlqTone = "bad";
      else if (unacked > 0) dlqTone = "warn";
    }

    const tone: "ok" | "warn" | "bad" =
      stuckTone === "bad" || dlqTone === "bad"
        ? "bad"
        : stuckTone === "warn" || dlqTone === "warn"
          ? "warn"
          : "ok";

    const stuckSince = stuckTone ? (was?.stuckTone ? (was.stuckSince ?? now) : now) : undefined;
    const dlqSince = dlqTone ? (was?.dlqTone ? (was.dlqSince ?? now) : now) : undefined;

    return {
      ...s,
      tone,
      backlog,
      stuckTone,
      dlqTone,
      stuckSince,
      dlqSince,
    };
  });

  // Sort: bad first, then warn, then backlog, then highest unacked, then id
  subscriptions.sort((a, b) => {
    const toneRank = (t: string) => (t === "bad" ? 2 : t === "warn" ? 1 : 0);
    const tr = toneRank(b.tone) - toneRank(a.tone);
    if (tr !== 0) return tr;
    const bl = (b.backlog ? 1 : 0) - (a.backlog ? 1 : 0);
    if (bl !== 0) return bl;
    const ua = (b.numUndelivered ?? 0) - (a.numUndelivered ?? 0);
    if (ua !== 0) return ua;
    return a.id.localeCompare(b.id);
  });

  return {
    at: now,
    ok: true,
    errors: read.errors,
    countsAt: now,
    project: read.project,
    subscriptions,
    orphanDeadLetterTopics: read.orphanDeadLetterTopics,
  };
}

/** Needs for stuck subscriptions and dead-letter subscriptions with unacked messages. */
export function needsOf(k: PubsubKept | undefined): PackNeed[] {
  if (!k) return [];
  const needs: PackNeed[] = [];

  for (const s of k.subscriptions) {
    if (s.stuckTone) {
      needs.push({
        key: `pubsub:${s.id}:stuck:${s.stuckTone}`,
        title: `Pub/Sub subscription ${s.id} unacked messages are ${formatAge(s.oldestAgeSecs)} old`,
        line: `${s.numUndelivered !== undefined ? n(s.numUndelivered) : "—"} unacked · topic ${s.topicId}`,
        href: "/pubsub",
        tone: s.stuckTone,
        rank: s.stuckTone === "bad" ? 1 : 2,
        at: s.stuckSince ?? k.at,
        ring: RING,
        label: "Pub/Sub",
      });
    }

    if (s.dlqTone) {
      needs.push({
        key: `pubsub:${s.id}:dlq:${s.dlqTone}`,
        title: `Pub/Sub dead-letter subscription ${s.id} has ${plural(s.numUndelivered ?? 0, "unacked message")}`,
        line: `topic ${s.topicId}`,
        href: "/pubsub",
        tone: s.dlqTone,
        rank: s.dlqTone === "bad" ? 1 : 2,
        at: s.dlqSince ?? k.at,
        ring: RING,
        label: "Pub/Sub",
      });
    }
  }

  return needs;
}

/** Fire for any bad condition, storm for any warning condition; counts only. */
export function avatarOf(k: PubsubKept | undefined): AvatarFeed | undefined {
  if (!k) return undefined;
  const bad = k.subscriptions.filter((s) => s.tone === "bad").length;
  const warn = k.subscriptions.filter((s) => s.tone === "warn").length;

  if (bad > 0) {
    return {
      trouble: {
        level: "fire",
        why: `${plural(bad, "subscription")} critical`,
        href: "/pubsub",
      },
    };
  }
  if (warn > 0) {
    return {
      trouble: {
        level: "storm",
        why: `${plural(warn, "subscription")} need attention`,
        href: "/pubsub",
      },
    };
  }
  return undefined;
}

/** Bino context: subscription names and numbers only. */
export function binoOf(k: PubsubKept | undefined): string {
  if (!k) return "";
  const lines: string[] = [];
  if (!k.ok) {
    lines.push(`Google Cloud Pub/Sub: last read failed (${k.error ?? "unavailable"})`);
  }
  if (k.subscriptions.length) {
    const bad = k.subscriptions.filter((s) => s.tone === "bad").length;
    const warn = k.subscriptions.filter((s) => s.tone === "warn").length;
    lines.push(
      `Google Cloud Pub/Sub (${k.project}): ${plural(k.subscriptions.length, "subscription")}, ${bad} critical, ${warn} warning`,
    );
  }
  const hot = k.subscriptions.filter((s) => s.tone !== "ok" || s.backlog);
  for (const s of hot.slice(0, 15)) {
    const unacked = s.numUndelivered !== undefined ? `${s.numUndelivered} unacked` : "unacked unknown";
    const age = s.oldestAgeSecs !== undefined ? `${s.oldestAgeSecs}s oldest` : "age unknown";
    lines.push(`subscription ${s.id} (topic ${s.topicId}): ${unacked}, ${age}`);
  }
  return lines.join("\n");
}
