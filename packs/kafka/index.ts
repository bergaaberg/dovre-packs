/**
 * Kafka Pack (`kafka`): consumer group lag, dead-letter topics and partition health for Kafka,
 * Redpanda and Confluent clusters, from an HTTP lag endpoint. Metadata only — never a payload.
 */
import { type AvatarFeed, type Pack, PACK_API, type PackNeed } from "dovre/packs/types.ts";
import { type KafkaKept, lagState, lagWarn, readKafka } from "./data.ts";
import { kafkaCard, kafkaPage } from "./view.ts";

export function createKafkaPack(opts: { fetchFn?: typeof fetch } = {}): Pack & { kept(): KafkaKept | undefined } {
  const fetchFn = opts.fetchFn ?? fetch;
  let kept: KafkaKept | undefined;
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "kafka",
      name: "Kafka",
      description: "Consumer group lag, dead-letter topics and partition health for Kafka, Redpanda and Confluent (metadata only).",
      domain: "work",
      execution: "any",
      everyMs: 60_000,
      settings: [
        { key: "KAFKA_ADMIN_URL", label: "Lag endpoint", required: true, help: "Redpanda Admin API, Confluent REST Proxy v3, or a lag exporter URL" },
        { key: "KAFKA_TOKEN", label: "Credentials", secret: true, help: "Optional: a Bearer token, or a full 'Basic …' header value" },
        { key: "KAFKA_LAG_WARN", label: "Lag warn threshold", help: "Lag that raises a warning (default 1000)" },
      ],
      rings: [{ kind: "lag", label: "Kafka lag", hint: "A consumer group falls behind or a dead-letter topic grows" }],
    },
    async refresh(ctx) {
      kept = await readKafka(ctx, kept, fetchFn);
      ctx.publish(["kafka", "snapshot"]);
    },
    nav: () => [{ href: "/kafka", title: "Kafka", icon: "chart", group: "Ops" }],
    pages: () => [{ title: "Kafka", href: "/kafka", icon: "📊", about: "Consumer group lag and topic health", also: ["lag", "redpanda", "dlq"] }],
    routes(app, ctx) {
      app.get("/kafka", (c) => ctx.page(c, { title: "Kafka", body: kafkaPage(kept) }));
    },
    today: () => (kept ? [{ id: "now", column: "right", render: kafkaCard(kept) }] : []),
    needs(ctx) {
      if (!kept?.ok) return [];
      const warn = lagWarn(ctx.env);
      const out: PackNeed[] = [];
      for (const g of kept.groups) {
        const state = lagState(kept, g, warn);
        if (state.level === "ok") continue;
        out.push({
          key: `lag ${g.key}${state.level === "bad" ? " bad" : ""}`,
          title: `${g.group} is ${state.why}`,
          line: g.dlq ? "Dead-letter topic" : "Consumer group",
          href: "/kafka",
          tone: state.level,
          rank: state.level === "bad" ? 3 : 2,
          at: kept.at,
          ring: "lag",
          label: "Kafka",
        });
      }
      const urp = kept.cluster?.underReplicatedPartitions ?? 0;
      if (urp > 0) {
        out.push({
          key: `under-replicated ${urp}`,
          title: `${urp} partitions under-replicated`,
          line: "Cluster health",
          href: "/kafka",
          tone: urp > 10 ? "bad" : "warn",
          rank: 3,
          at: kept.at,
          ring: "lag",
        });
      }
      return out;
    },
    avatar(ctx): AvatarFeed | null {
      if (!kept?.ok) return null;
      const needs = this.needs?.(ctx) ?? [];
      const bad = needs.filter((n) => n.tone === "bad").length;
      if (!needs.length) return null;
      return {
        asking: needs.length,
        trouble: {
          level: bad ? ("fire" as const) : ("storm" as const),
          why: bad ? `${bad} red lag${bad > 1 ? "s" : ""}` : `${needs.length} lag warning${needs.length > 1 ? "s" : ""}`,
          href: "/kafka",
        },
      };
    },
    bino(ctx) {
      if (!kept?.ok) return "";
      const warn = lagWarn(ctx.env);
      const lines: string[] = [];
      const behind = kept.groups.filter((g) => g.totalLag > 0);
      if (behind.length) {
        lines.push(`${behind.length} of ${kept.groups.length} groups behind:`);
        for (const g of behind.sort((a, b) => b.totalLag - a.totalLag).slice(0, 10)) {
          lines.push(`${g.group} on ${g.topic}: lag ${g.totalLag}${lagState(kept, g, warn).level !== "ok" ? ` (${lagState(kept, g, warn).why})` : ""}.`);
        }
      } else lines.push(`${kept.groups.length} groups, all caught up.`);
      if (kept.cluster) {
        if (kept.cluster.underReplicatedPartitions) lines.push(`${kept.cluster.underReplicatedPartitions} partitions under-replicated.`);
        if (kept.cluster.offlinePartitions) lines.push(`${kept.cluster.offlinePartitions} partitions offline.`);
      }
      return lines.join("\n");
    },
    glance: () => (kept?.ok ? [{ label: "groups behind", value: kept.groups.filter((g) => g.totalLag > 0).length }] : []),
  };
}

export const kafkaPack: Pack = createKafkaPack();
export const kafkaCrate = kafkaPack;
