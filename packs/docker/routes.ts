/**
 * /docker…: the pack's routes, behind the app's cookie and localhost checks, and the
 * stricter guard too (strictOrigin: exact Origin on every write, nothing another site started):
 * the engine runs as root in its distro, with this user's files under /mnt/c.
 * Ids, verbs and project names are checked against fixed patterns before the engine hears them.
 */
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "dovre/env.ts";
import { strictOrigin } from "dovre/strict.ts";
import type { PageOpts } from "dovre/pack.ts";
import type { Docker } from "./docker.ts";
import { ID_RE, PROJECT_RE, isVerb } from "./model.ts";
import { containerGonePage, containerPage, dockerPage } from "./view.ts";

type Page = (c: Context<AppEnv>, o: PageOpts) => Promise<Response>;

/** On `app` (the pack's own sub-app); `get` is the service once the pack has started. */
export function dockerRoutes(app: Hono<AppEnv>, get: () => Docker, page: Page): void {
  app.use("/docker", strictOrigin);
  app.use("/docker/*", strictOrigin);

  app.get("/docker", (c) => page(c, dockerPage(get().view(), get().takeFlash())));

  app.post("/docker/engine/:to", (c) => {
    const to = c.req.param("to");
    if (to !== "on" && to !== "off") return c.notFound();
    get().engine(to === "on");
    return c.redirect("/docker", 303);
  });
  app.post("/docker/p/:project/:verb", (c) => {
    const { project, verb } = c.req.param();
    if (!PROJECT_RE.test(project) || (verb !== "start" && verb !== "stop" && verb !== "restart")) return c.notFound();
    get().project(project, verb);
    return c.redirect("/docker", 303);
  });
  app.post("/docker/c/:id/:verb", (c) => {
    const { id, verb } = c.req.param();
    if (!ID_RE.test(id) || !isVerb(verb)) return c.notFound();
    get().act(id, verb);
    // From a container's own page, back there (unless it was removed).
    const from = c.req.header("referer") ?? "";
    const back = verb !== "remove" && new URL(from, c.req.url).pathname === `/docker/c/${id}` ? `/docker/c/${id}` : "/docker";
    return c.redirect(back, 303);
  });
  app.get("/docker/c/:id", async (c) => {
    const id = c.req.param("id");
    const found = ID_RE.test(id) ? get().find(id) : undefined;
    if (!found) {
      const res = await page(c, containerGonePage());
      return new Response(res.body, { status: 404, headers: res.headers });
    }
    c.header("Cache-Control", "no-store");
    return page(c, containerPage(get().view(), found));
  });
  // The logs, as Server-Sent Events: to this response only.
  app.get("/docker/c/:id/logs", (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id) || !get().find(id)) return c.notFound();
    c.header("Cache-Control", "no-store");
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      let chain: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => ac.abort());
      };
      const r = await get().logs(id, (text) => send("out", text), ac.signal);
      if (!ac.signal.aborted) send("end", r.ok ? "the container stopped" : (r.error ?? "the logs ended"));
      await chain;
    });
  });
}
