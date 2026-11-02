/**
 * HTTP client (`http`): sending from the Quick view and the response page.
 *  - POST /http/send: one click, the form's blanks filled in as typed; back to the Quick view it came
 *    from, or to the response page. Refused before anything goes when it can't be prepared.
 *  - GET /http/r/:id: a send in history, swapped in place over the hub when the answer is here.
 *  - POST /http/curl: the request as a curl command, nothing sent.
 */
import { html } from "hono/html";
import type { Hono } from "hono";
import type { AppEnv } from "dovre/env.ts";
import type { PackContext } from "dovre/packs/types.ts";
import { previous } from "./compare.ts";
import { reqOfForm, toCurl } from "./model.ts";
import { blanksOfForm, fillBlanks } from "./quick.ts";
import type { createQuick } from "./quick-routes.ts";
import { quickHref } from "./quick-view.ts";
import { type Draw, type Sending, str, whereOf } from "./sending.ts";
import { sentHref, sentPage } from "./view.ts";

/** How a response's body is shown, or `diff` against the send before it. */
const VIEWS = ["pretty", "tree", "raw", "diff"] as const;

export function mountSend(app: Hono<AppEnv>, ctx: PackContext, d: { sending: Sending; quick: ReturnType<typeof createQuick>; draw: Draw }) {
  const { sending, quick, draw } = d;

  app.post("/http/send", async (c) => {
    const f = await c.req.parseBody();
    const typed = reqOfForm(f);
    const w = whereOf(f);
    // From the Quick view: its blanks go in as typed, and it comes back to the same view.
    const fromQuick = f.back === "quick";
    const blanks = blanksOfForm(f);
    const ep = str(f.ep, 600);
    const filled = fillBlanks(typed, blanks);
    if (!filled.ok) return draw(ctx, c, typed, w, { flash: { tone: "warn", text: filled.error }, blanks, ep }, 400);
    const r = filled.req;
    const p = sending.prepare(ctx, r, w, sending.sentRefs(w));
    if (!p.ok) return draw(ctx, c, typed, w, { flash: { tone: "warn", text: p.error }, blanks, ep }, 400);
    if (w.repo) quick.remember(w.repo, blanks);
    const { s } = sending.start(ctx, r, w, p);
    return c.redirect(fromQuick ? quickHref({ repo: w.repo, env: w.env, ep, file: w.opened, n: w.n }) : sentHref(s.id), 303);
  });

  app.get("/http/r/:id", async (c) => {
    const s = sending.history.get(c.req.param("id"));
    if (!s) return c.redirect("/http", 303);
    c.header("Cache-Control", "no-store");
    return ctx.page(c, {
      title: s.req.name || "HTTP response",
      current: "/http",
      head: html`<meta name="u-topics" content="http http-sent:${s.id}">`,
      body: sentPage({ sent: s, view: VIEWS.find((v) => v === c.req.query("view")) ?? "pretty", prev: previous(sending.history.list(), s) }),
    });
  });

  app.post("/http/curl", async (c) => {
    const f = await c.req.parseBody();
    const typed = reqOfForm(f);
    const w = whereOf(f);
    const blanks = blanksOfForm(f);
    const ep = str(f.ep, 600);
    const filled = fillBlanks(typed, blanks);
    if (!filled.ok) return draw(ctx, c, typed, w, { flash: { tone: "warn", text: filled.error }, blanks, ep }, 400);
    const r = filled.req;
    return draw(ctx, c, typed, w, { curlOut: r.url ? toCurl(r, sending.varsFor(ctx, w).vars, sending.secretsOf(ctx), sending.now()) : "", blanks, ep });
  });
}
