/**
 * Topo's Cloudflare inventory (dovre-packs#68 step 2): what exists in the account, by peak's kinds
 * (workers, databases = D1, stores = KV, buckets = R2, queues), and the Durable Object classes each
 * worker holds. It only reads (a read-only token is enough). A load is kept `ttlMs`; a kind it
 * couldn't read is named in `failed` and left out, so drift never takes it for one that's empty.
 */
import type { Kind } from "@bergaaberg/peak";

const BASE = "https://api.cloudflare.com/client/v4";
/** Pages read per kind at most (100 a page), so a load stays within a Worker's subrequests. */
const PAGES = 20;

export type CloudWhat = Kind | "objects";

export type CloudRead = {
  at: number;
  account: string;
  /** Names by kind, for the kinds it could read. */
  have: Partial<Record<Kind, string[]>>;
  /** Durable Object classes by worker name, when it could read them. */
  objects?: Record<string, string[]>;
  /** What it couldn't read this time, and why. */
  failed: { what: CloudWhat; why: string }[];
};

/** The token permission each read needs, for the message when it's refused. */
const SCOPE: Record<CloudWhat, string> = {
  workers: "Workers Scripts Read",
  objects: "Workers Scripts Read",
  databases: "D1 Read",
  stores: "Workers KV Storage Read",
  buckets: "Workers R2 Storage Read",
  queues: "Queues Read",
};

type Envelope = { success?: boolean; errors?: { message?: string }[]; result?: unknown; result_info?: { page?: number; total_pages?: number; cursor?: string } };

export class CloudInventory {
  private env: () => { account?: string; token?: string };
  private fetchFn: typeof fetch;
  private ttlMs: number;
  private now: () => number;
  private last?: CloudRead;
  private loading?: Promise<CloudRead | undefined>;

  constructor(o: { env: () => { account?: string; token?: string }; fetchFn?: typeof fetch; ttlMs?: number; now?: () => number }) {
    this.env = o.env;
    this.fetchFn = o.fetchFn ?? ((input, init) => fetch(input, init));
    this.ttlMs = o.ttlMs ?? 15 * 60_000;
    this.now = o.now ?? Date.now;
  }

  /** An account and a token are set. */
  configured(): boolean {
    const { account, token } = this.env();
    return !!(account?.trim() && token?.trim());
  }

  /** The last load, however old. */
  peek(): CloudRead | undefined {
    return this.last;
  }

  /** The last load while it's fresh, else a new one (one at a time). Undefined when it's not configured. */
  load(force = false): Promise<CloudRead | undefined> {
    if (!this.configured()) return Promise.resolve((this.last = undefined));
    if (!force && this.last && this.now() - this.last.at < this.ttlMs) return Promise.resolve(this.last);
    if (this.loading) return this.loading;
    const p = this.read().finally(() => {
      if (this.loading === p) this.loading = undefined;
    });
    return (this.loading = p);
  }

  private async read(): Promise<CloudRead> {
    const account = this.env().account!.trim();
    const token = this.env().token!.trim();
    const out: CloudRead = { at: this.now(), account, have: {}, failed: [] };
    const root = `/accounts/${encodeURIComponent(account)}`;

    const call = async (path: string): Promise<Envelope> => {
      const res = await this.fetchFn(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      const j = (await res.json().catch(() => ({}))) as Envelope;
      if (!res.ok || j.success === false) {
        const msg = j.errors?.[0]?.message;
        throw new Error(`HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
      }
      return j;
    };
    /** A list read page by page (`page`/`per_page`). */
    const paged = async <T>(path: string): Promise<T[]> => {
      const rows: T[] = [];
      for (let page = 1; page <= PAGES; page++) {
        const j = await call(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
        const got = Array.isArray(j.result) ? (j.result as T[]) : [];
        rows.push(...got);
        const total = j.result_info?.total_pages;
        if (total ? page >= total : got.length < 100) break;
      }
      return rows;
    };
    /** R2's list goes by cursor. */
    const buckets = async (): Promise<string[]> => {
      const names: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < PAGES; i++) {
        const j = await call(`${root}/r2/buckets?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        const got = (j.result as { buckets?: { name?: string }[] } | undefined)?.buckets ?? [];
        names.push(...got.map((b) => b.name ?? ""));
        cursor = j.result_info?.cursor;
        if (!cursor || !got.length) break;
      }
      return names;
    };

    const reads: [CloudWhat, () => Promise<void>][] = [
      ["workers", async () => void (out.have.workers = (await call(`${root}/workers/scripts`).then((j) => (Array.isArray(j.result) ? j.result : []) as { id?: string }[])).map((s) => s.id ?? ""))],
      [
        "objects",
        async () => {
          const by: Record<string, string[]> = {};
          for (const n of await paged<{ script?: string; class?: string }>(`${root}/workers/durable_objects/namespaces`)) {
            if (n.script && n.class) (by[n.script] ??= []).push(n.class);
          }
          out.objects = by;
        },
      ],
      ["databases", async () => void (out.have.databases = (await paged<{ name?: string }>(`${root}/d1/database`)).map((d) => d.name ?? ""))],
      ["stores", async () => void (out.have.stores = (await paged<{ title?: string }>(`${root}/storage/kv/namespaces`)).map((n) => n.title ?? ""))],
      ["buckets", async () => void (out.have.buckets = await buckets())],
      ["queues", async () => void (out.have.queues = (await paged<{ queue_name?: string }>(`${root}/queues`)).map((q) => q.queue_name ?? ""))],
    ];
    await Promise.all(
      reads.map(async ([what, read]) => {
        try {
          await read();
        } catch (e) {
          const why = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 160);
          out.failed.push({ what, why: /HTTP 40[13]/.test(why) ? `${why} (does the token have ${SCOPE[what]}?)` : why });
        }
      }),
    );
    for (const k of Object.keys(out.have) as Kind[]) out.have[k] = [...new Set(out.have[k]!.filter(Boolean))].sort();
    out.failed.sort((a, b) => reads.findIndex(([w]) => w === a.what) - reads.findIndex(([w]) => w === b.what));
    return (this.last = out);
  }
}
