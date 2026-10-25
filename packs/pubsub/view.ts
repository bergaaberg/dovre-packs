/** Google Cloud Pub/Sub Pack (`pubsub`) views: Today card and the `/pubsub` page. */
import { html } from "hono/html";
import { Ago, Link } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import {
  AGE_BAD_SECS,
  AGE_WARN_SECS,
  BACKLOG_WARN,
  DLQ_BAD,
  formatAge,
  n,
  type PubsubKept,
  type WatchedSub,
} from "./watch.ts";

function unackedPill(s: WatchedSub) {
  if (s.dlqTone) return Pill({ tone: s.dlqTone, children: `${n(s.numUndelivered ?? 0)} DLQ unacked` });
  if (s.backlog) return Pill({ tone: "warn", children: `${n(s.numUndelivered ?? 0)} backlog` });
  return "";
}

function agePill(s: WatchedSub) {
  if (s.stuckTone) return Pill({ tone: s.stuckTone, children: `${formatAge(s.oldestAgeSecs)} oldest` });
  return "";
}

function problems(k: PubsubKept, now: number) {
  return html`${
    !k.ok
      ? Notice({
          tone: "bad",
          children: html`${k.error ?? "Pub/Sub read failed"}${
            k.countsAt ? html` · showing the last counts, read ${Ago(k.countsAt, now)}` : ""
          }`,
        })
      : ""
  }${
    k.errors.length
      ? Notice({
          tone: "warn",
          children: html`Partial read: ${k.errors.slice(0, 5).join("; ")}`,
        })
      : ""
  }${
    k.orphanDeadLetterTopics.length
      ? Notice({
          tone: "warn",
          children: html`Unmonitored dead-letter ${
            k.orphanDeadLetterTopics.length === 1 ? "topic" : "topics"
          } (no subscription reading): ${k.orphanDeadLetterTopics.join(", ")}`,
        })
      : ""
  }`;
}

function table(subs: WatchedSub[], project: string, now: number) {
  return html`<div class="table-wrap"><table class="data"><thead><tr><th scope="col">Subscription</th><th scope="col">Topic</th><th scope="col">Dead-letter target</th><th scope="col" class="num">Unacked</th><th scope="col" class="num">Oldest unacked age</th><th scope="col">Troubled for</th></tr></thead><tbody>${subs.map((s) => {
    const detailUrl = project
      ? `https://console.cloud.google.com/cloudpubsub/subscription/detail/${encodeURIComponent(s.id)}?project=${encodeURIComponent(project)}`
      : undefined;
    const since = s.stuckSince || s.dlqSince ? Math.min(s.stuckSince ?? Infinity, s.dlqSince ?? Infinity) : undefined;

    return html`<tr><td><strong>${detailUrl ? Link(detailUrl, s.id) : s.id}</strong></td><td>${s.topicId}</td><td>${
      s.deadLetterTopicId
        ? html`→ ${s.deadLetterTopicId}${s.maxDeliveryAttempts ? html` (max ${s.maxDeliveryAttempts})` : ""}`
        : s.isDeadLetter
          ? Pill({ tone: s.dlqTone ?? "ok", children: "DLQ target" })
          : "—"
    }</td><td class="num">${
      s.dlqTone
        ? Pill({ tone: s.dlqTone, children: n(s.numUndelivered ?? 0) })
        : s.backlog
          ? Pill({ tone: "warn", children: n(s.numUndelivered ?? 0) })
          : s.numUndelivered !== undefined
            ? n(s.numUndelivered)
            : "—"
    }</td><td class="num">${
      s.stuckTone
        ? Pill({ tone: s.stuckTone, children: formatAge(s.oldestAgeSecs) })
        : s.oldestAgeSecs !== undefined
          ? formatAge(s.oldestAgeSecs)
          : "—"
    }</td><td>${since ? html`${Ago(since, now)}` : "—"}</td></tr>`;
  })}</tbody></table></div>`;
}

export function pubsubPage(k: PubsubKept | undefined, rawProject: string | undefined, now = Date.now()) {
  const project = k?.project || rawProject || "";
  const consoleUrl = project
    ? `https://console.cloud.google.com/cloudpubsub/subscription/list?project=${encodeURIComponent(project)}`
    : undefined;
  const sub = project
    ? html`Project <strong>${project}</strong>${consoleUrl ? html` · ${Link(consoleUrl, "GCP Console")}` : ""} · counts and age only, never message payloads`
    : "Counts and age only, never message payloads";

  const troubled = k?.subscriptions.filter((s) => s.tone !== "ok").length ?? 0;

  return html`${PageHeader({ title: "Google Cloud Pub/Sub", sub })}
<div data-live id="pubsub">
${k ? problems(k, now) : ""}
${Panel({
  title: "Subscriptions",
  meta: k
    ? html`${k.subscriptions.length} tracked · ${troubled} troubled${k.countsAt ? html` · read ${Ago(k.countsAt, now)}` : ""}`
    : "loading",
  flush: true,
  children: k?.subscriptions.length
    ? table(k.subscriptions, project, now)
    : Empty({ title: k ? "No subscriptions found" : "Not read yet" }),
})}
<p class="t2">Unacked messages older than ${Math.floor(AGE_WARN_SECS / 60)} minutes warn, ${Math.floor(AGE_BAD_SECS / 3600)} hour bad. Dead-letter subscriptions with unacked messages warn; ${DLQ_BAD} or more bad. ${BACKLOG_WARN.toLocaleString("en-US")} or more unacked messages counts as a backlog.</p>
</div>`;
}

export function pubsubCard(k: PubsubKept, now = Date.now()) {
  const hot = k.subscriptions.filter((s) => s.tone !== "ok" || s.backlog);
  const body = hot.length
    ? List(
        hot.slice(0, 6).map((s) =>
          Item({
            href: "/pubsub",
            lead: html`<span class="dot ${s.tone}" role="img" aria-label="${s.tone}"></span>`,
            title: html`<strong>${s.id}</strong> ${unackedPill(s)} ${agePill(s)}`,
            line: html`topic: ${s.topicId}${s.isDeadLetter ? " · DLQ" : ""}${
              s.stuckSince || s.dlqSince
                ? html` · troubled ${Ago(Math.min(s.stuckSince ?? Infinity, s.dlqSince ?? Infinity), now)}`
                : ""
            }`,
          }),
        ),
      )
    : html`<p class="t2">${
        k.ok
          ? k.subscriptions.length
            ? `${n(k.subscriptions.length)} subscriptions, no stuck messages or DLQ backlog.`
            : "No subscriptions found."
          : (k.error ?? "Pub/Sub unavailable")
      }</p>`;

  return Card({
    id: "pubsub-now",
    title: "Pub/Sub",
    meta: html`<a href="/pubsub">Open</a>`,
    foot: hot.length > 6 ? html`<a href="/pubsub">${hot.length - 6} more</a>` : undefined,
    children: html`${hot.length && !k.ok ? html`<p class="t2">${k.error ?? "Pub/Sub read failed"} · last counts shown</p>` : ""}${body}`,
  });
}
