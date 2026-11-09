/**
 * berth (github.com/bergaaberg/berth): Docker Engine on Windows without Docker Desktop, in a WSL
 * distro of its own. Dovre doesn't run the engine; when berth is installed the Docker page talks to
 * berth's own pipe and switches the engine with `berth start` and `berth stop`. Only those two
 * and `berth status --json` are ever run, with fixed arguments.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** berth's own pipe: it serves this whenever it's on, and docker_engine too when that's free. */
export const BERTH_PIPE = "\\\\.\\pipe\\berth";
/** Docker's default pipe on Windows (Docker Desktop's, or berth's once Desktop is gone). */
export const DEFAULT_PIPE = "\\\\.\\pipe\\docker_engine";

/** What the Docker page can do with an engine it doesn't run itself. */
export type EngineControl = {
  /** For the actions log. */
  name: string;
  /** Whether it's switched on; undefined when it can't say. */
  on(): Promise<boolean | undefined>;
  start(): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<{ ok: boolean; error?: string }>;
};

/** berth.exe: where `berth setup` puts it, else in an absolute folder on the PATH. Windows paths on any OS, so tests run anywhere. */
export function findBerth(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter((d) => d && win32.isAbsolute(d));
  const at = [env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "berth", "bin", "berth.exe") : undefined, ...dirs.map((d) => win32.join(d, "berth.exe"))];
  return at.find((p): p is string => !!p && exists(p));
}

/** `berth status --json`'s `on`, read strictly. */
export function berthOn(out: string): boolean | undefined {
  try {
    const on = (JSON.parse(out) as { on?: unknown }).on;
    return typeof on === "boolean" ? on : undefined;
  } catch {
    return undefined;
  }
}

type Run = (args: string[], ms: number) => Promise<{ ok: boolean; out: string; err: string }>;

export function berthControl(exe: string, run?: Run): EngineControl {
  const go: Run =
    run ??
    ((args, ms) => new Promise((res) => execFile(exe, args, { timeout: ms, windowsHide: true }, (e, out, err) => res({ ok: !e, out: String(out ?? ""), err: String(err ?? "") }))));
  const why = (r: { out: string; err: string }) => (r.err || r.out).trim().split("\n").slice(-1)[0]?.replace(/^berth: /, "").slice(0, 300) || "berth failed";
  return {
    name: "berth",
    async on() {
      const r = await go(["status", "--json"], 15_000);
      return r.ok ? berthOn(r.out) : undefined;
    },
    async start() {
      const r = await go(["start"], 120_000);
      return r.ok ? { ok: true } : { ok: false, error: why(r) };
    },
    async stop() {
      const r = await go(["stop"], 120_000);
      return r.ok ? { ok: true } : { ok: false, error: why(r) };
    },
  };
}
