/**
 * Summaries made in the background and kept in the database by key (what, at which commit).
 * Pages ask `get(key)`: the text when it's made, "pending" while it's being made, nothing if
 * never asked. `want(key, prompt)` queues one; a few run at a time.
 */
import type { D1 } from "dovre/db.ts";
import type { AiSummary, PackContext } from "dovre/packs/types.ts";
import { inFiles } from "dovre/sources/ghe.ts";

export type Summary = AiSummary;
/** The model, as the pack is lent it (`ctx.complete`). */
export type Complete = PackContext["complete"];

export type Summaries = {
  get(key: string): Summary | undefined;
  want(key: string, prompt: () => { system: string; user: string }): void;
  /** Loads what's stored, so pages see summaries made before a restart. */
  load(): Promise<void>;
  idle(): Promise<void>;
};

export function createSummaries(db: D1, complete: Complete, opts: { concurrency?: number; onReady?: (key: string) => void } = {}): Summaries {
  const known = new Map<string, Summary>();
  const queue: { key: string; prompt: () => { system: string; user: string } }[] = [];
  let running = 0;
  let waiters: (() => void)[] = [];
  const limit = opts.concurrency ?? 2;

  const pump = () => {
    while (running < limit && queue.length) {
      const job = queue.shift()!;
      running++;
      (async () => {
        try {
          const { text, cost } = await complete(job.prompt());
          known.set(job.key, { state: "ready", text });
          await db.prepare("INSERT OR REPLACE INTO summaries (key, text, error, cost, at) VALUES (?, ?, NULL, ?, ?)").bind(job.key, text, cost, new Date().toISOString()).run();
          opts.onReady?.(job.key);
        } catch (e) {
          const error = String((e as Error).message ?? e);
          // Not allowed now, or today's dollars are spent: forgotten, so a later refresh asks again.
          if (error.startsWith("AI: ")) known.delete(job.key);
          else known.set(job.key, { state: "failed", error });
        } finally {
          running--;
          pump();
          if (!running && !queue.length) {
            waiters.forEach((w) => w());
            waiters = [];
          }
        }
      })();
    }
  };

  return {
    get: (key) => known.get(key),
    want(key, prompt) {
      if (known.has(key)) return;
      known.set(key, { state: "pending" });
      queue.push({ key, prompt });
      pump();
    },
    async load() {
      // Dovre's core made this table when summaries were core's; a new database gets it here.
      await db.prepare("CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY, text TEXT, error TEXT, cost REAL, at TEXT NOT NULL)").run();
      const rows = (await db.prepare("SELECT key, text FROM summaries WHERE text IS NOT NULL").all<{ key: string; text: string }>()).results;
      for (const r of rows) known.set(r.key, { state: "ready", text: r.text });
    },
    idle: () => (running || queue.length ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
  };
}

const SYSTEM = `You summarize software changes for a busy tech lead at a Norwegian insurance company. Write in English; keep Norwegian product terms as they are. Plain text, no markdown, no preamble, no "This PR". Be concrete about what changes for users or systems. Mention risk only when there is a specific one (migrations, auth, payments, prod config, deleted code paths).`;

export function prPrompt(p: { repo: string; number: number; title: string; author: string; body: string; additions: number; deletions: number; changedFiles?: number; files: { path: string; additions: number; deletions: number }[] }) {
  return {
    system: SYSTEM,
    user: [
      `Summarize this pull request in at most two sentences.`,
      `Repo: ${p.repo} #${p.number} by ${p.author}`,
      `Title: ${p.title}`,
      `Size: +${p.additions} −${p.deletions}${inFiles(p)}`,
      `Files:\n${p.files.slice(0, 40).map((f) => `- ${f.path} (+${f.additions} −${f.deletions})`).join("\n")}`,
      `Description:\n${p.body.slice(0, 6000) || "(none)"}`,
    ].join("\n\n"),
  };
}

export function deployPrompt(d: { repo: string; days: number; items: { kind: string; title: string; author: string }[] }) {
  return {
    system: SYSTEM,
    user: [
      `This deploy to production of ${d.repo} ships everything merged in the last ${d.days} days since the last prod deploy. In at most two sentences, say what it changes for users, then name anything risky. Ignore dependency bumps unless one is a major version.`,
      d.items.map((i) => `- [${i.kind}] ${i.title} (${i.author})`).join("\n"),
    ].join("\n\n"),
  };
}
