/**
 * What the Docker page shows, read strictly from Docker Engine's answers: a container's names,
 * image, state, health, published ports and compose project. Anything that doesn't read is left
 * out, never guessed. Pure; tested in test/docker.test.ts.
 */

export type State = "running" | "exited" | "created" | "paused" | "restarting" | "removing" | "dead";
const STATES: readonly string[] = ["running", "exited", "created", "paused", "restarting", "removing", "dead"];

export type Container = {
  id: string;
  name: string;
  image: string;
  state: State;
  /** Docker's own words ("Up 3 hours (healthy)", "Exited (0) 2 days ago"). */
  status: string;
  health?: "healthy" | "unhealthy" | "starting";
  /** Published ports, "1433→1433/tcp", one per port (IPv4 and IPv6 told once). */
  ports: string[];
  project?: string;
  service?: string;
  created: number;
};

/** What a page may ask of a container: nothing else is ever sent to the engine. */
export const VERBS = ["start", "stop", "restart", "remove"] as const;
export type Verb = (typeof VERBS)[number];
export const isVerb = (v: unknown): v is Verb => typeof v === "string" && (VERBS as readonly string[]).includes(v);

export const ID_RE = /^[0-9a-f]{12,64}$/;
/** Compose project names: lower-case letters, digits, dashes and underscores (compose's own rule). */
export const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : undefined);

export function parseContainers(body: unknown): Container[] {
  if (!Array.isArray(body)) throw new Error("Docker's container list didn't read");
  const out: Container[] = [];
  for (const c of body as Record<string, unknown>[]) {
    const id = str(c?.Id, 64);
    const state = str(c?.State, 20);
    if (!id || !ID_RE.test(id) || !state || !STATES.includes(state)) continue;
    const names = Array.isArray(c.Names) ? c.Names.map((n) => str(n, 200)).filter((n): n is string => !!n) : [];
    const status = str(c.Status) ?? "";
    const labels = (c.Labels && typeof c.Labels === "object" ? c.Labels : {}) as Record<string, unknown>;
    const project = str(labels["com.docker.compose.project"], 63);
    out.push({
      id,
      name: (names[0] ?? id.slice(0, 12)).replace(/^\//, ""),
      image: str(c.Image, 200) ?? "",
      state: state as State,
      status,
      health: /\(healthy\)/.test(status) ? "healthy" : /\(unhealthy\)/.test(status) ? "unhealthy" : /health: starting/.test(status) ? "starting" : undefined,
      ports: portsOf(c.Ports),
      project: project && PROJECT_RE.test(project) ? project : undefined,
      service: str(labels["com.docker.compose.service"], 100),
      created: typeof c.Created === "number" ? c.Created * 1000 : 0,
    });
  }
  return out;
}

function portsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const p of v as Record<string, unknown>[]) {
    if (typeof p?.PublicPort !== "number" || typeof p.PrivatePort !== "number") continue;
    seen.add(`${p.PublicPort}→${p.PrivatePort}/${p.Type === "udp" ? "udp" : "tcp"}`);
  }
  return [...seen].sort((a, b) => parseInt(a) - parseInt(b));
}

export type Group = { project?: string; containers: Container[]; running: number };

/** Compose projects by name, then the containers outside any; running ones first in each. */
export function groupsOf(list: Container[]): Group[] {
  const by = new Map<string, Container[]>();
  for (const c of list) by.set(c.project ?? "", [...(by.get(c.project ?? "") ?? []), c]);
  const rank = (c: Container) => (c.state === "running" || c.state === "restarting" ? 0 : 1);
  return [...by]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([project, cs]) => ({
      project: project || undefined,
      containers: cs.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
      running: cs.filter((c) => c.state === "running").length,
    }));
}

/** Whether a verb makes sense for a container as it is now (the re-check before acting). */
export function allowed(verb: Verb, state: State): boolean {
  if (verb === "start") return state === "exited" || state === "created" || state === "dead";
  if (verb === "stop" || verb === "restart") return state === "running" || state === "restarting" || state === "paused";
  return state !== "running" && state !== "restarting" && state !== "removing";
}

/** What the page draws, without the parts that tick by themselves ("Up 3 minutes"). */
export function shapeOf(list: Container[]): string {
  return JSON.stringify(list.map((c) => [c.id, c.name, c.state, c.health, c.ports, c.image]));
}
