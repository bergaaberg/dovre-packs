/**
 * Custom App Starter Pack (`custom-app`): a clean 3-file template for plugging your own
 * product, database, or internal tool into Dovre's Today view, sidebar, and Assistant context.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { type Kept, read } from "./data.ts";
import { customAppCard, customAppPage } from "./view.ts";

let kept: Kept | undefined;

export const customAppPack: Pack = {
  manifest: {
    api: PACK_API,
    id: "custom-app",
    name: "Custom App",
    description: "Starter 3-file pack for your own app, D1 database, or API.",
    domain: "personal",
    execution: "any",
    settings: [{ key: "CUSTOM_APP_URL", label: "Optional JSON status endpoint" }],
    everyMs: 5 * 60_000,
  },
  async refresh(ctx) {
    kept = await read(ctx);
    ctx.publish(["custom-app"]);
  },
  nav: () => [{ href: "/custom-app", title: "Custom App", icon: "layers", group: "Ops" }],
  pages: () => [{ title: "Custom App", href: "/custom-app", icon: "▦", about: "Your custom app pack", also: ["starter"] }],
  routes(app, ctx) {
    app.get("/custom-app", (c) => ctx.page(c, { title: "Custom App", body: customAppPage(kept) }));
  },
  today: () => (kept ? [{ id: "now", render: customAppCard(kept) }] : []),
  bino: () => (kept ? `${kept.summary} (${kept.items.length} items)` : ""),
};

export const customAppCrate = customAppPack;
