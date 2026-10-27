/**
 * HTTP client (`http`): sending one request, and the history of what was sent (memory only).
 *
 * A send is always one click on a POST (never a GET, never in the background). It goes out with no
 * redirects followed (a 3xx is shown as it came, so a secret never follows a Location elsewhere),
 * times out, and reads at most MAX_RESPONSE bytes of the body. What comes back is kept in memory,
 * with every secret's value masked, the newest MAX_HISTORY sends only, and gone on restart.
 */
import type { Prepared, Req } from "./model.ts";

/** Most bytes of a response body read (the rest is cut off, and the page says so). */
export const MAX_RESPONSE = 1_000_000;
/** How long a send may take, start to last byte. */
export const TIMEOUT_MS = 30_000;
/** Sends kept in memory. */
export const MAX_HISTORY = 25;
const MAX_RESPONSE_HEADERS = 100;
const MAX_HEADER_VALUE = 4_000;

export type Resp = {
  status: number;
  statusText: string;
  ms: number;
  /** Bytes read (up to MAX_RESPONSE). */
  size: number;
  truncated: boolean;
  headers: [string, string][];
  /** Decoded as UTF-8 (when it's text), secrets masked. */
  body: string;
  binary: boolean;
};

export type Sent = {
  id: string;
  at: number;
  /** The request as it was in the editor ({{placeholders}} unresolved), and where it came from. */
  req: Req;
  from: { env: string; repo: string; file: string; n: string; hash: string };
  /** What went out, masked: method, URL, headers. */
  out: { method: string; url: string; headers: [string, string][] };
  state: "sending" | "done" | "failed";
  /** Sent by an agent through the `send` tool (Dovre's MCP server), not from the editor. */
  by?: "agent";
  resp?: Resp;
  error?: string;
};

const TEXTY = /^(text\/|application\/(json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|x-ndjson))/i;

function looksBinary(ct: string, bytes: Uint8Array): boolean {
  if (TEXTY.test(ct)) return false;
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return !!ct && !/charset=/i.test(ct) && /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|wasm)/i.test(ct);
}

/** Reads a body up to `max` bytes, then stops reading. */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw new Error("timed out");
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - size;
      if (value.length > room) {
        chunks.push(value.subarray(0, room));
        size += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, truncated };
}

export async function sendOnce(p: Prepared, o: { fetchFn: typeof fetch; mask: (s: string) => string; now: () => number; timeoutMs?: number }): Promise<Resp> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`no answer within ${Math.round((o.timeoutMs ?? TIMEOUT_MS) / 1000)} s`)), o.timeoutMs ?? TIMEOUT_MS);
  const start = o.now();
  try {
    const res = await o.fetchFn(p.url, { method: p.method, headers: p.headers, body: p.body, redirect: "manual", signal: ac.signal, credentials: "omit" } as RequestInit);
    const { bytes, truncated } = await readCapped(res, MAX_RESPONSE, ac.signal);
    const ms = o.now() - start;
    const ct = res.headers.get("content-type") ?? "";
    const binary = looksBinary(ct, bytes);
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => {
      if (headers.length < MAX_RESPONSE_HEADERS) headers.push([k, o.mask(v.slice(0, MAX_HEADER_VALUE))]);
    });
    return { status: res.status, statusText: o.mask(res.statusText.slice(0, 200)), ms, size: bytes.length, truncated, headers, body: binary ? "" : o.mask(new TextDecoder("utf-8").decode(bytes)), binary };
  } finally {
    clearTimeout(timer);
  }
}

/** The history: newest first, MAX_HISTORY at most, in memory. */
export function createHistory() {
  const list: Sent[] = [];
  return {
    add(s: Sent) {
      list.unshift(s);
      list.length = Math.min(list.length, MAX_HISTORY);
    },
    get: (id: string) => list.find((s) => s.id === id),
    list: () => [...list],
    clear: () => void (list.length = 0),
  };
}
export type History = ReturnType<typeof createHistory>;

const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/** Why a send failed, in words, masked (a fetch error may quote the URL). */
export function failure(e: unknown, mask: (s: string) => string): string {
  const err = e as { name?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code ?? err?.cause?.message;
  return mask(err?.name === "AbortError" ? "timed out" : `${msg(e)}${cause ? ` (${String(cause).slice(0, 120)})` : ""}`);
}
