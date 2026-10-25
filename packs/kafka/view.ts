/** Kafka Pack (`kafka`) views. */
import { html } from "hono/html";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import type { GroupLag, KafkaKept } from "./data.ts";

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

function lagItem(g: GroupLag, tone: "bad" | "warn" | "ok") {
  return Item({
    href: "/kafka",
    title: html`<strong>${g.group}</strong> ${g.topic}`,
    line: [g.partitions ? `${g.partitions} partitions` : undefined, g.maxLagPartition ? `worst partition ${g.maxLagPartition}` : undefined].filter(Boolean).join(" · "),
    trail: Pill({ tone: g.dlq && g.totalLag > 0 ? "bad" : tone === "ok" ? "neutral" : tone, children: g.dlq ? `DLQ ${fmt(g.totalLag)}` : `lag ${fmt(g.totalLag)}` }),
  });
}

export function kafkaPage(k: KafkaKept | undefined) {
  const groups = [...(k?.groups ?? [])].sort((a, b) => b.totalLag - a.totalLag);
  const dlq = groups.filter((g) => g.dlq);
  const rest = groups.filter((g) => !g.dlq);
  const cl = k?.cluster;
  return html`${PageHeader({ title: "Kafka", sub: k?.url ? `Lag from ${k.url.replace(/^https?:\/\//, "")}` : "Consumer group lag" })}
<div data-live id="kafka">
${k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Kafka endpoint unavailable" }) : ""}
${cl ? Panel({
    title: "Cluster",
    meta: cl.brokers ? `${cl.brokers} brokers` : undefined,
    children: html`${cl.underReplicatedPartitions > 0 ? Pill({ tone: "warn", children: `${cl.underReplicatedPartitions} under-replicated` }) : Pill({ tone: "ok", children: "replication healthy" })}
${cl.offlinePartitions ? html` ${Pill({ tone: "bad", children: `${cl.offlinePartitions} offline` })}` : ""}${cl.topics ? html` <span class="t2">${cl.topics} topics</span>` : ""}`,
  }) : ""}
${Panel({
    title: "Consumer groups",
    meta: String(rest.length),
    flush: true,
    children: rest.length
      ? List(rest.slice(0, 30).map((g) => lagItem(g, g.totalLag > 0 ? "warn" : "ok")))
      : Empty({ title: k ? "No consumer groups behind" : "Not read yet" }),
  })}
${dlq.length ? Panel({ title: "Dead-letter topics", meta: String(dlq.length), flush: true, children: List(dlq.map((g) => lagItem(g, "bad"))) }) : ""}
</div>`;
}

export function kafkaCard(k: KafkaKept) {
  const worst = [...k.groups].sort((a, b) => b.totalLag - a.totalLag).slice(0, 5);
  const behind = k.groups.filter((g) => g.totalLag > 0).length;
  return Card({
    id: "kafka-now",
    title: "Kafka",
    meta: html`<a href="/kafka">Open</a>`,
    children: k.ok
      ? worst.length
        ? List(worst.map((g) => lagItem(g, g.totalLag > 0 ? "warn" : "ok")))
        : html`<p class="t2">${behind} groups, all caught up</p>`
      : html`<p class="t2">${k.error ?? "Kafka endpoint unavailable"}</p>`,
  });
}
