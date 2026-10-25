/**
 * Docker Containers Pack (`docker`): inspects local containers via `docker ps -a --format json`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PackContext } from "dovre/packs/types.ts";

const execFileAsync = promisify(execFile);

export type ContainerRow = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
};

export type DockerKept = {
  at: number;
  ok: boolean;
  error?: string;
  containers: ContainerRow[];
};

export type DockerRunner = () => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: DockerRunner = () =>
  execFileAsync("docker", ["ps", "-a", "--format", "{{json .}}"], { timeout: 6000 });

export async function readDocker(_ctx: PackContext, run: DockerRunner = defaultRunner, now = Date.now()): Promise<DockerKept> {
  try {
    const { stdout } = await run();
    const containers: ContainerRow[] = [];
    for (const line of stdout.split(/\r?\n/).filter((l) => l.trim())) {
      try {
        const j = JSON.parse(line) as { ID?: string; Names?: string; Image?: string; State?: string; Status?: string; Ports?: string };
        containers.push({
          id: String(j.ID ?? "").slice(0, 12),
          name: String(j.Names ?? "unnamed"),
          image: String(j.Image ?? ""),
          state: String(j.State ?? "unknown").toLowerCase(),
          status: String(j.Status ?? ""),
          ports: String(j.Ports ?? ""),
        });
      } catch {}
    }
    return { at: now, ok: true, containers };
  } catch (e) {
    return { at: now, ok: false, error: String((e as Error)?.message ?? e).slice(0, 160), containers: [] };
  }
}
