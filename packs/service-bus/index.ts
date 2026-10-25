/**
 * Azure Service Bus Pack (`service-bus`): active backlog and dead-letter queue depth per queue
 * and topic subscription, with a DLQ radar (needs, a ring, the avatar's storm or fire).
 * Counts and entity names only, never a message. Works locally and hosted on Cloudflare Workers.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { parseEndpoint, readServiceBus } from "./data.ts";
import { serviceBusCard, serviceBusPage } from "./view.ts";
import { avatarOf, binoOf, needsOf, RING, type ServiceBusKept, watch } from "./watch.ts";

export function createServiceBusPack(opts: { fetchFn?: typeof fetch; now?: () => number } = {}): Pack & { kept(): ServiceBusKept | undefined } {
  let kept: ServiceBusKept | undefined;
  const now = opts.now ?? Date.now;
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "service-bus",
      name: "Azure Service Bus",
      description: "Queue and subscription backlog and dead-letter queue depth, with a DLQ radar.",
      domain: "general",
      execution: "any",
      everyMs: 2 * 60_000,
      settings: [
        {
          key: "SERVICEBUS_ENDPOINT",
          label: "Service Bus namespace or management URL",
          required: true,
          help: "https://<namespace>.servicebus.windows.net, or https://management.azure.com/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.ServiceBus/namespaces/<namespace>",
        },
        {
          key: "SERVICEBUS_TOKEN",
          label: "SAS or Entra ID bearer token",
          secret: true,
          required: true,
          help: "A SAS (SharedAccessSignature sr=…) with Manage rights for the namespace URL, or a bearer token for either URL",
        },
        { key: "SERVICEBUS_ENTITIES", label: "Queues or topic/subscription names (comma-separated)", help: "Optional, e.g. orders, billing/invoices. Default: every queue and subscription" },
      ],
      rings: [{ kind: RING, label: "A Service Bus dead-letter queue fills", hint: "Once per queue or subscription, and again if it reaches 100" }],
    },
    async refresh(ctx) {
      kept = watch(kept, await readServiceBus(ctx.env, opts.fetchFn), now());
      ctx.publish(["service-bus", "snapshot"]);
    },
    nav: () => [{ href: "/service-bus", title: "Service Bus", icon: "layers", group: "Ops" }],
    pages: () => [{ title: "Azure Service Bus", href: "/service-bus", icon: "✉", about: "Service Bus queues, subscriptions and dead-letter queues", also: ["azure", "dlq", "queues", "messaging"] }],
    routes(app, ctx) {
      app.get("/service-bus", (c) => ctx.page(c, { title: "Azure Service Bus", body: serviceBusPage(kept, parseEndpoint(ctx.env.SERVICEBUS_ENDPOINT), now()) }));
    },
    today: () => (kept ? [{ id: "now", render: serviceBusCard(kept, now()) }] : []),
    needs: () => needsOf(kept),
    avatar: () => avatarOf(kept),
    bino: () => binoOf(kept),
  };
}

export const serviceBusPack: Pack = createServiceBusPack();
