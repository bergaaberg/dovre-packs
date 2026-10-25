/**
 * Docker Containers Pack (`docker`): local container list and status.
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { type DockerKept, type DockerRunner, readDocker } from "./data.ts";
import { dockerCard, dockerPage } from "./view.ts";

export function createDockerPack(opts: { run?: DockerRunner } = {}): Pack & { kept(): DockerKept | undefined } {
  let kept: DockerKept | undefined;
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "docker",
      name: "Docker",
      description: "Local Docker containers, images, and port mappings.",
      domain: "general",
      execution: "local-only",
      requiredBinaries: ["docker"],
      everyMs: 30_000,
    },
    async refresh(ctx) {
      kept = await readDocker(ctx, opts.run);
      ctx.publish(["docker"]);
    },
    nav: () => [{ href: "/docker", title: "Docker", icon: "box", group: "Code" }],
    pages: () => [{ title: "Docker", href: "/docker", icon: "▦", about: "Local Docker containers and status", also: ["containers", "images"] }],
    routes(app, ctx) {
      app.get("/docker", (c) => ctx.page(c, { title: "Docker", body: dockerPage(kept) }));
    },
    today: () => (kept && kept.containers.length ? [{ id: "now", render: dockerCard(kept) }] : []),
    bino: () =>
      kept?.ok
        ? kept.containers.map((c) => `container ${c.name} (${c.image}): ${c.state} (${c.status})`).join("\n")
        : "",
  };
}

export const dockerPack: Pack = createDockerPack();
export const dockerCrate = dockerPack;
