/**
 * HTTP & OpenTelemetry Pack (`http-otel`): polls `/healthz` endpoints and OTel collector status.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { type HttpOtelKept, readHttpOtel } from "./data.ts";
import { httpOtelCard, httpOtelPage } from "./view.ts";

export function createHttpOtelPack(opts: { fetchFn?: typeof fetch } = {}): Pack & { kept(): HttpOtelKept | undefined } {
  let kept: HttpOtelKept | undefined;
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "http-otel",
      name: "HTTP & OpenTelemetry",
      description: "Polls HTTP /healthz endpoints and OpenTelemetry collector health.",
      domain: "general",
      execution: "any",
      everyMs: 60_000,
      settings: [
        { key: "HTTP_HEALTH_URLS", label: "Health check URLs (comma-separated)", required: true, help: "https://api.example.com/healthz, https://web.example.com/healthz" },
      ],
    },
    async refresh(ctx) {
      kept = await readHttpOtel(ctx, opts.fetchFn);
      ctx.publish(["http-otel", "snapshot"]);
    },
    nav: () => [{ href: "/http-otel", title: "HTTP Health", icon: "health", group: "Ops" }],
    pages: () => [{ title: "HTTP & OpenTelemetry", href: "/http-otel", icon: "♥", about: "Endpoint /healthz checks and latency", also: ["healthz", "otel", "uptime"] }],
    routes(app, ctx) {
      app.get("/http-otel", (c) => ctx.page(c, { title: "HTTP & OpenTelemetry", body: httpOtelPage(kept) }));
    },
    today: () => (kept ? [{ id: "now", render: httpOtelCard(kept) }] : []),
    avatar: () => {
      if (!kept) return undefined;
      const down = kept.endpoints.filter((e) => !e.ok);
      if (down.length) return { trouble: { level: "fire", why: `${down.length} endpoint${down.length > 1 ? "s" : ""} down`, href: "/http-otel" } };
      return undefined;
    },
    bino: () =>
      kept ? kept.endpoints.map((e) => `${e.name} [${e.status}]: ${e.detail ?? ""}`).join("\n") : "",
  };
}

export const httpOtelPack: Pack = createHttpOtelPack();
export const httpOtelCrate = httpOtelPack;
