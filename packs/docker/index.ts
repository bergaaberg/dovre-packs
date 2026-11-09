/**
 * Docker Pack (`docker`): the containers on this machine's Docker Engine, with start, stop,
 * restart and remove, a compose project's at once, and a container's logs as they come. On Windows
 * the engine is berth's (berth.ts) or Docker Desktop's; on macOS and Linux a Unix socket
 * (findEngineSocket; colima.sh sets up Colima on a Mac). What it may do, and that logs are never
 * kept, is docker.ts's header. Its routes take the stricter guard (exact Origin on every write).
 */
import { homedir } from "node:os";
import type { Pack, PackContext } from "dovre/pack.ts";
import { BERTH_PIPE, DEFAULT_PIPE, berthControl, findBerth } from "./berth.ts";
import { createDocker, type Docker, findEngineSocket } from "./docker.ts";
import { createEngine } from "./engine.ts";
import { DOCKER_LOGS_JS } from "./logs.js.ts";
import { dockerRoutes } from "./routes.ts";

const STYLES = `pre.docker-logs { margin: 0; border: 0; border-radius: 0; min-height: 12rem; max-height: 70vh; overflow-y: auto; }`;

/** At most one call per `ms`, the last one carried to the end of the window. */
function throttle(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
}

/** This machine's engine: Windows' pipe (DOCKER_PIPE, else berth's, else Docker's default), or a socket elsewhere. */
export function machineDocker(ctx: PackContext, o: { windows?: boolean; env?: Record<string, string | undefined>; home?: string } = {}): Docker {
  const windows = o.windows ?? process.platform === "win32";
  const env = { ...(o.env ?? process.env), ...(ctx.env.DOCKER_PIPE ? { DOCKER_PIPE: ctx.env.DOCKER_PIPE } : {}) };
  const berthExe = windows && !env.DOCKER_PIPE ? findBerth(env) : undefined;
  const pipe = () => (windows ? env.DOCKER_PIPE || (berthExe ? BERTH_PIPE : DEFAULT_PIPE) : findEngineSocket(env, o.home ?? homedir()));
  return createDocker({
    engine: createEngine(pipe),
    pipe,
    control: berthExe ? berthControl(berthExe) : undefined,
    windows,
    onChange: throttle(() => ctx.publish(["docker"]), 500),
    log: (kind, target, ok, error) => ctx.logged({ kind, target, ok, error }),
  });
}

/** `make` builds the service once the pack starts, from its context (tests pass their own). */
export function createDockerPack(make: (ctx: PackContext) => Docker = (ctx) => machineDocker(ctx)): Pack {
  let docker: Docker | undefined;
  // Started by init, or by the first page that needs it (a host that mounts routes before init).
  let started: PackContext | undefined;
  const get = () => {
    if (!docker && started) docker = make(started);
    if (!docker) throw new Error("docker hasn't started");
    return docker;
  };
  return {
    manifest: {
      api: "1.25",
      version: "2.0.3",
      id: "docker",
      name: "Docker",
      description: "Containers on Docker Engine: start, stop, logs",
      domain: "general",
      answers: ["run:containers"],
      markers: ["Dockerfile", "compose.yaml", "compose.yml", "docker-compose.yml"],
      execution: "local-only",
      settings: [{ key: "DOCKER_PIPE", label: "Another engine's pipe or socket instead of the default" }],
    },
    writes: [
      { kind: "engine-off", label: "Stop Docker" },
      { kind: "remove", label: "Remove a container" },
    ],
    styles: STYLES,
    script: DOCKER_LOGS_JS,
    init(ctx) {
      started = ctx;
      docker ??= make(ctx);
    },
    // The engine's event stream keeps it fresh; this is the slow fallback.
    refresh: async () => get().refresh(),
    dispose: () => docker?.stop(),
    nav: () => [{ href: "/docker", title: "Docker", icon: "box", group: "Ops" }],
    pages: () => [{ title: "Docker", href: "/docker", icon: "▣", about: "Containers: start, stop, logs", also: ["containers", "compose", "engine", "wsl", "logs"] }],
    routes: (app, ctx) => {
      started ??= ctx;
      dockerRoutes(app as never, get, ctx.page);
    },
  };
}

export const dockerPack: Pack = createDockerPack();
