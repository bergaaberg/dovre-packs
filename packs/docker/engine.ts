/**
 * Docker Engine's API over its pipe (\\.\pipe\… on Windows, a unix socket elsewhere): plain HTTP,
 * one keep-alive connection pool, so a call costs the relay's start (launcher/docker.go) once.
 * Only the calls the Docker page makes exist here; nothing builds a path from outside this folder.
 */
import { Agent, request } from "node:http";

/** The API version every path is pinned to (Docker Engine 25 and later answer it). */
export const API = "/v1.44";

export type Engine = {
  json(method: "GET" | "POST" | "DELETE", path: string): Promise<{ status: number; body: unknown }>;
  /** A response read as it arrives (events, logs) until it ends or `signal` aborts. */
  stream(path: string, onData: (b: Buffer) => void, signal: AbortSignal): Promise<number>;
};

export function createEngine(socketPath: () => string | undefined, timeoutMs = 15_000): Engine {
  const agent = new Agent({ keepAlive: true, maxSockets: 6 });
  const open = (method: string, path: string, signal?: AbortSignal) => {
    const at = socketPath();
    if (!at) throw new Error("no Docker pipe");
    return request({ socketPath: at, agent, method, path: API + path, headers: { host: "docker" }, signal });
  };
  return {
    json(method, path) {
      return new Promise((resolve, reject) => {
        let req;
        try {
          req = open(method, path);
        } catch (e) {
          return reject(e);
        }
        req.setTimeout(timeoutMs, () => req.destroy(new Error("Docker didn't answer in time")));
        req.on("error", reject);
        req.on("response", (res) => {
          const parts: Buffer[] = [];
          res.on("data", (b: Buffer) => parts.push(b));
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(parts).toString("utf8");
            let body: unknown = text;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {}
            resolve({ status: res.statusCode ?? 0, body });
          });
        });
        req.end();
      });
    },
    stream(path, onData, signal) {
      return new Promise((resolve, reject) => {
        let req;
        try {
          req = open("GET", path, signal);
        } catch (e) {
          return reject(e);
        }
        req.on("error", (e) => (signal.aborted ? resolve(0) : reject(e)));
        req.on("response", (res) => {
          res.on("data", (b: Buffer) => onData(b));
          res.on("error", () => resolve(res.statusCode ?? 0));
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.end();
      });
    },
  };
}

/**
 * Logs of a container without a TTY come multiplexed: frames of an 8-byte header (stream, three
 * zero bytes, a big-endian length) and that many bytes. Feeds whole frames' payloads out, keeps
 * a partial frame for the next chunk.
 */
export function demuxer(out: (b: Buffer) => void): (chunk: Buffer) => void {
  let rest: Buffer = Buffer.alloc(0);
  return (chunk) => {
    rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    while (rest.length >= 8) {
      const size = rest.readUInt32BE(4);
      if (rest.length < 8 + size) break;
      out(rest.subarray(8, 8 + size));
      rest = rest.subarray(8 + size);
    }
  };
}
