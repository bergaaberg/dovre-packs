/**
 * Moved (`movement`): what people and bots did in the org in the last 24 hours, by person or as a
 * timeline. It reads the gathered snapshot (`moves`); the gather itself is core's. In the menu only
 * locally; hosted, Today's feed says the same. It left core in dovre#465.
 */
import { Empty, type Pack } from "dovre/pack.ts";
import { movementBody } from "./view.ts";

const HREF = "/movement";
const VIEWS = ["people", "timeline", "me", "bots"];

export function createMovementPack(): Pack {
  return {
    manifest: {
      api: "1.27",
      version: "1.0.2",
      id: "movement",
      name: "Moved",
      description: "What people and bots did in the org in the last 24 hours, by person or as a timeline",
      domain: "work",
      roles: ["lead"],
      execution: "any",
    },
    nav: (ctx) => (ctx.hosted ? [] : [{ href: HREF, title: "Moved", icon: "health", group: "Code", order: 50 }]),
    pages: () => [{ title: "Moved", href: HREF, icon: "↯", about: "What people did in the org, 24 h", also: ["movement", "activity", "people", "team", "timeline"] }],
    routes(app, ctx) {
      app.get(HREF, async (c) => {
        const s = await ctx.gathered();
        const asked = c.req.query("view") ?? "";
        const view = VIEWS.includes(asked) ? asked : "people";
        return ctx.page(c, { title: "Movement · Dovre", current: HREF, body: s ? movementBody(s, view) : Empty({ title: "Nothing gathered yet" }) });
      });
    },
  };
}

export const movementPack = createMovementPack();
