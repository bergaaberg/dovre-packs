/**
 * Azure Service Bus Pack (`service-bus`): what the pack keeps between refreshes, and what it
 * makes of it (the DLQ radar): a dead-letter queue with anything in it is a need and trouble for
 * the avatar, a full one (DLQ_BAD or more) a bad need and a fire.
 */
import type { AvatarFeed, PackNeed } from "dovre/packs/types.ts";
import type { Entity, ServiceBusRead } from "./data.ts";

/** Dead-lettered messages (both dead-letter queues) from which a need is bad, not a warning. */
export const DLQ_BAD = 100;
/** Active messages from which a queue or subscription counts as backed up. */
export const BACKLOG_WARN = 1000;
/** The ring a filling dead-letter queue sounds (manifest `rings`). */
export const RING = "service-bus-dlq";

export type Watched = Entity & {
  /** Dead-lettered in both dead-letter queues (`$DeadLetterQueue` and the transfer one). */
  dlq: number;
  tone: "ok" | "warn" | "bad";
  backlog: boolean;
  /**
   * Since when its dead-letter queue has held anything, as far as this pack has seen: the first
   * refresh that found it non-empty. Message ages would mean peeking at messages, which it never does.
   */
  dlqSince?: number;
};

export type ServiceBusKept = {
  at: number;
  ok: boolean;
  /** Why the last refresh read nothing (the entities are then the last good ones). */
  error?: string;
  /** Entities the last refresh couldn't read, beside the ones it could. */
  errors: string[];
  /** When the entities' counts were read. */
  countsAt?: number;
  entities: Watched[];
};

const toneOf = (dlq: number): Watched["tone"] => (dlq >= DLQ_BAD ? "bad" : dlq > 0 ? "warn" : "ok");

/**
 * The new state from a read and the one before: a failed read keeps the last good counts (so a
 * hiccup doesn't drop and re-ring every need), and `dlqSince` carries over while a DLQ stays non-empty.
 */
export function watch(prev: ServiceBusKept | undefined, read: ServiceBusRead, now: number): ServiceBusKept {
  if (!read.ok) return { at: now, ok: false, error: read.error, errors: [], countsAt: prev?.countsAt, entities: prev?.entities ?? [] };
  const before = new Map((prev?.entities ?? []).map((e) => [`${e.kind}:${e.name}`, e]));
  const entities = read.entities.map((e): Watched => {
    const dlq = e.deadLetter + e.transferDeadLetter;
    const was = before.get(`${e.kind}:${e.name}`);
    return { ...e, dlq, tone: toneOf(dlq), backlog: e.active >= BACKLOG_WARN, dlqSince: dlq > 0 ? (was?.dlqSince ?? now) : undefined };
  });
  entities.sort((a, b) => b.dlq - a.dlq || b.active - a.active || a.name.localeCompare(b.name));
  return { at: now, ok: true, errors: read.errors, countsAt: now, entities };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every non-empty DLQ is a need; its key changes only when it turns bad, so it rings once, and once more then. */
export function needsOf(k: ServiceBusKept | undefined): PackNeed[] {
  return (k?.entities ?? [])
    .filter((e) => e.dlq > 0)
    .map((e) => ({
      key: `service-bus:${e.kind}:${e.name}:${e.tone}`,
      title: `Service Bus ${e.kind} ${e.name} has ${plural(e.dlq, "dead-lettered message")}`,
      line: `${e.active.toLocaleString("en-US")} active`,
      href: "/service-bus",
      tone: e.tone === "bad" ? "bad" : "warn",
      rank: e.tone === "bad" ? 1 : 2,
      at: e.dlqSince ?? k!.at,
      ring: RING,
      label: "Service Bus",
    }));
}

/** A fire for a full DLQ, a storm for any non-empty one; counts only. */
export function avatarOf(k: ServiceBusKept | undefined): AvatarFeed | undefined {
  const bad = k?.entities.filter((e) => e.tone === "bad").length ?? 0;
  const warn = k?.entities.filter((e) => e.tone === "warn").length ?? 0;
  if (bad) return { trouble: { level: "fire", why: `${plural(bad, "dead-letter queue")} over ${DLQ_BAD}`, href: "/service-bus" } };
  if (warn) return { trouble: { level: "storm", why: `${plural(warn, "dead-letter queue")} not empty`, href: "/service-bus" } };
  return undefined;
}

/** For Bino: entity names and counts, never a message. */
export function binoOf(k: ServiceBusKept | undefined): string {
  if (!k) return "";
  const lines: string[] = [];
  if (!k.ok) lines.push(`Azure Service Bus: last read failed (${k.error ?? "unavailable"})`);
  const hot = k.entities.filter((e) => e.dlq > 0 || e.backlog);
  if (k.entities.length) {
    lines.push(`Azure Service Bus: ${plural(k.entities.length, "queue/subscription", "queues/subscriptions")}, ${plural(k.entities.filter((e) => e.dlq > 0).length, "non-empty dead-letter queue")}`);
  }
  for (const e of hot.slice(0, 15)) lines.push(`${e.kind} ${e.name}: ${e.active} active, ${e.dlq} dead-lettered, ${e.scheduled} scheduled`);
  return lines.join("\n");
}
