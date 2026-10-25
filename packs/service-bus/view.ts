/** Azure Service Bus Pack (`service-bus`) views: Today card and the `/service-bus` page. */
import { html } from "hono/html";
import { Ago, Link } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import type { Target } from "./data.ts";
import { BACKLOG_WARN, DLQ_BAD, type ServiceBusKept, type Watched } from "./watch.ts";

const n = (v: number) => v.toLocaleString("en-US");

const dlqPill = (e: Watched) => (e.dlq > 0 ? Pill({ tone: e.tone, children: `${n(e.dlq)} dead-lettered` }) : "");
const backlogPill = (e: Watched) => (e.backlog ? Pill({ tone: "warn", children: `${n(e.active)} active` }) : "");

function problems(k: ServiceBusKept, now: number) {
  return html`${!k.ok ? Notice({ tone: "bad", children: html`${k.error ?? "Service Bus read failed"}${k.countsAt ? html` · showing the last counts, read ${Ago(k.countsAt, now)}` : ""}` }) : ""}${
    k.errors.length ? Notice({ tone: "warn", children: html`Couldn't read ${k.errors.length === 1 ? "one entity" : `${k.errors.length} entities`}: ${k.errors.slice(0, 5).join("; ")}` }) : ""
  }`;
}

function table(entities: Watched[], now: number) {
  return html`<div class="table-wrap"><table class="data"><thead><tr><th scope="col">Queue / subscription</th><th scope="col">Kind</th><th scope="col" class="num">Active</th><th scope="col" class="num">Scheduled</th><th scope="col" class="num">Dead-lettered</th><th scope="col" class="num">Transfer DLQ</th><th scope="col">Dead letters for</th></tr></thead><tbody>${entities.map(
    (e) =>
      html`<tr><td><strong>${e.name}</strong></td><td>${e.kind}</td><td class="num">${e.backlog ? backlogPill(e) : n(e.active)}</td><td class="num">${n(e.scheduled)}</td><td class="num">${
        e.deadLetter > 0 ? Pill({ tone: e.tone, children: n(e.deadLetter) }) : "0"
      }</td><td class="num">${e.transferDeadLetter > 0 ? Pill({ tone: e.tone, children: n(e.transferDeadLetter) }) : "0"}</td><td>${e.dlqSince ? html`${Ago(e.dlqSince, now)}` : "—"}</td></tr>`,
  )}</tbody></table></div>`;
}

export function serviceBusPage(k: ServiceBusKept | undefined, target: Target | undefined, now = Date.now()) {
  const sub = target
    ? html`Namespace <strong>${target.namespace}</strong>${target.portal ? html` · ${Link(target.portal, "Azure portal")}` : ""} · counts only, never message bodies`
    : "Counts only, never message bodies";
  const dlqs = k?.entities.filter((e) => e.dlq > 0).length ?? 0;
  return html`${PageHeader({ title: "Azure Service Bus", sub })}
<div data-live id="service-bus">
${k ? problems(k, now) : ""}
${Panel({
  title: "Queues and subscriptions",
  meta: k ? html`${k.entities.length} tracked · ${dlqs} with dead letters${k.countsAt ? html` · read ${Ago(k.countsAt, now)}` : ""}` : "loading",
  flush: true,
  children: k?.entities.length ? table(k.entities, now) : Empty({ title: k ? "No queues or subscriptions found" : "Not read yet" }),
})}
<p class="t2">A dead-letter queue with anything in it is a warning; ${DLQ_BAD} or more is bad. ${BACKLOG_WARN} or more active messages counts as a backlog. "Dead letters for" counts from the first time this Dovre saw the dead-letter queue non-empty.</p>
</div>`;
}

export function serviceBusCard(k: ServiceBusKept, now = Date.now()) {
  const hot = k.entities.filter((e) => e.dlq > 0 || e.backlog);
  const body = hot.length
    ? List(
        hot.slice(0, 6).map((e) =>
          Item({
            href: "/service-bus",
            lead: html`<span class="dot ${e.dlq > 0 ? e.tone : "warn"}" role="img" aria-label="${e.dlq > 0 ? e.tone : "warn"}"></span>`,
            title: html`<strong>${e.name}</strong> ${dlqPill(e)} ${backlogPill(e)}`,
            line: html`${e.kind} · ${n(e.active)} active${e.dlqSince ? html` · dead letters for ${Ago(e.dlqSince, now)}` : ""}`,
          }),
        ),
      )
    : html`<p class="t2">${k.ok ? (k.entities.length ? `${k.entities.length} queues and subscriptions, no dead letters or backlog.` : "No queues or subscriptions found.") : (k.error ?? "Service Bus unavailable")}</p>`;
  return Card({
    id: "service-bus-now",
    title: "Service Bus",
    meta: html`<a href="/service-bus">Open</a>`,
    foot: hot.length > 6 ? html`<a href="/service-bus">${hot.length - 6} more</a>` : undefined,
    children: html`${hot.length && !k.ok ? html`<p class="t2">${k.error ?? "Service Bus read failed"} · last counts shown</p>` : ""}${body}`,
  });
}
