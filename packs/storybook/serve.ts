/**
 * Serves the Storybooks built here (build.ts), apart from Dovre (#166). A build is the PR's own
 * JavaScript, so it never comes from Dovre's origin: this server has a port of its own, reads files
 * only (GET and HEAD, no cookies, nothing written), answers only to `localhost:<port>` and
 * `127.0.0.1:<port>` (a page elsewhere can't reach it through DNS), and serves nothing outside a
 * finished build's folder.
 *
 * The page frames a build from whichever of the two hosts Dovre's page isn't on (`frameOrigin`): the
 * two are different sites, so a build never gets Dovre's launch-token cookie and Dovre treats its
 * requests as cross-site.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { SHA } from "./build.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** The two origins a build can be served from. */
export const buildOrigins = (port: number) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

/** The origin to frame a build from, for a Dovre page on `host`: the other of localhost and 127.0.0.1. */
export const frameFrom = (host: string | undefined, port: number) => (/^127\.0\.0\.1(:\d+)?$/.test(host ?? "") ? `http://localhost:${port}` : `http://127.0.0.1:${port}`);

/** The file a request asks for, under `root/<repo>/<sha>/`, or undefined. */
export function fileFor(root: string, path: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(path.split("?")[0]!);
  } catch {
    return undefined;
  }
  const parts = rel.split("/").filter(Boolean);
  if (parts.length < 2 || !/^[a-z0-9._-]+$/.test(parts[0]!) || !SHA.test(parts[1]!) || parts.some((p) => p === ".." || p === "." || p.includes("\\") || p.includes("\0"))) return undefined;
  const base = resolve(root, parts[0]!, parts[1]!);
  let file = resolve(base, ...parts.slice(2));
  if (file !== base && !file.startsWith(base + sep)) return undefined;
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

export function buildHandler(root: string, port: number) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return (req: IncomingMessage, res: ServerResponse) => {
    const no = (code: number) => {
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
      res.end(code === 405 ? "Read only." : "Not found.");
    };
    if (!hosts.has(String(req.headers.host ?? "").toLowerCase())) return no(404);
    if (req.method !== "GET" && req.method !== "HEAD") return no(405);
    const file = fileFor(root, req.url ?? "/");
    if (!file) return no(404);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=3600",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  };
}

/** Starts the server on first use, on 127.0.0.1 and ::1 (`localhost` may be either). */
export function buildServer(root: string, port: number, log: (line: string) => void = () => {}): { ensure(): void } {
  let servers: Server[] | undefined;
  return {
    ensure() {
      if (servers) return;
      const handler = buildHandler(root, port);
      servers = ["127.0.0.1", "::1"].map((host) => {
        const s = createServer(handler);
        s.on("error", (e) => log(`storybook: can't serve builds on ${host}:${port}: ${(e as Error).message}`));
        s.listen(port, host);
        s.unref();
        return s;
      });
    },
  };
}
