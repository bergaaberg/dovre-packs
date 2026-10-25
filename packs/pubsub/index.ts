/**
 * Google Cloud Pub/Sub Pack (`pubsub`): unacked backlog, oldest unacked age, and dead-letter
 * topic depth radar (needs, a ring, the avatar's storm or fire).
 * Counts and subscription names only, never a message payload. Works locally and hosted on Cloudflare Workers.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { readPubsub, validateProject } from "./data.ts";
import { pubsubCard, pubsubPage } from "./view.ts";
import { avatarOf, binoOf, needsOf, type PubsubKept, RING, watch } from "./watch.ts";

export function createPubsubPack(
  opts: { fetchFn?: typeof fetch; now?: () => number } = {},
): Pack & { kept(): PubsubKept | undefined } {
  let kept: PubsubKept | undefined;
  const now = opts.now ?? Date.now;

  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "pubsub",
      name: "Google Cloud Pub/Sub",
      description: "Subscription backlog, oldest unacked message age, and dead-letter radar.",
      domain: "general",
      execution: "any",
      everyMs: 2 * 60_000,
      settings: [
        {
          key: "PUBSUB_PROJECT",
          label: "GCP Project ID",
          required: true,
          help: "GCP project ID (e.g. my-project-123)",
        },
        {
          key: "PUBSUB_TOKEN",
          label: "OAuth2 Bearer token or Service Account JSON key",
          secret: true,
          required: true,
          help: "OAuth2 access token or GCP service account private key JSON ({...}) with roles/pubsub.viewer and roles/monitoring.viewer",
        },
        {
          key: "PUBSUB_SUBSCRIPTIONS",
          label: "Subscriptions (comma-separated)",
          help: "Optional, e.g. orders-sub, billing-sub. Default: every subscription in the project",
        },
      ],
      rings: [
        {
          kind: RING,
          label: "A Pub/Sub subscription is stuck or DLQ has unacked messages",
          hint: "Once per subscription condition, and again on escalation",
        },
      ],
    },
    async refresh(ctx) {
      kept = watch(kept, await readPubsub(ctx.env, opts.fetchFn, now()), now());
      ctx.publish(["pubsub", "snapshot"]);
    },
    nav: () => [{ href: "/pubsub", title: "Pub/Sub", icon: "layers", group: "Ops" }],
    pages: () => [
      {
        title: "Google Cloud Pub/Sub",
        href: "/pubsub",
        icon: "📻",
        about: "Pub/Sub subscriptions, message age, and dead-letter topics",
        also: ["gcp", "pubsub", "queue", "dlq", "messaging"],
      },
    ],
    routes(app, ctx) {
      app.get("/pubsub", (c) =>
        ctx.page(c, {
          title: "Google Cloud Pub/Sub",
          body: pubsubPage(kept, validateProject(ctx.env.PUBSUB_PROJECT) ?? ctx.env.PUBSUB_PROJECT, now()),
        }),
      );
    },
    today: () => (kept ? [{ id: "pubsub-now", render: pubsubCard(kept, now()) }] : []),
    needs: () => needsOf(kept),
    avatar: () => avatarOf(kept),
    bino: () => binoOf(kept),
  };
}

export const pubsubPack: Pack = createPubsubPack();
