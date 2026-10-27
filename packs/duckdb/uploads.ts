/**
 * Files added from this computer (`POST /duckdb/files/upload`): saved under a clean name in one
 * folder beside Dovre's database, which the pack lists as one more folder source ("uploads"). So
 * the viewer, its path checks and DuckDB's lockdown are the same as for any folder: nothing here
 * reads the file, DuckDB does, shut in to that folder. Kept a day, and the folder kept under a
 * total size, oldest removed first.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { type DuckDbTarget, kindOf } from "./data.ts";

export const MAX_UPLOAD = 256 * 1024 * 1024;
export const MAX_KEPT = 2 * 1024 * 1024 * 1024;
export const KEEP_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_KINDS = ".parquet,.csv,.tsv,.json,.jsonl,.ndjson";

/** The folder: beside Dovre's database, as other packs keep their files. */
export const uploadsDir = (env: Record<string, string | undefined>) => join(dirname(resolve(env.U_DB || "data/dovre.sqlite")), "duckdb-uploads");

/** The uploads folder as a folder source, under an id no configured source has (made on the first upload). */
export function uploadsSource(dir: string, taken: DuckDbTarget[]): DuckDbTarget {
  let id = "uploads";
  while (taken.some((s) => s.id === id)) id += "_";
  return { id, label: id, path: dir, isDir: true };
}

/**
 * A name safe to save under: the last part of what the browser sent, only letters, digits, `.`,
 * `_` and `-`, not hidden, at most 120 characters, and one of the kinds the viewer reads. Else
 * undefined.
 */
export function cleanName(raw: string): string | undefined {
  const last = raw.split(/[\\/]/).pop() ?? "";
  const name = last.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-120);
  if (!name || !kindOf(name)) return undefined;
  return name;
}

type Kept = { path: string; size: number; at: number };

function listed(dir: string): Kept[] {
  const out: Kept[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const path = join(dir, n);
    try {
      const st = statSync(path);
      if (st.isFile()) out.push({ path, size: st.size, at: st.mtimeMs });
    } catch {}
  }
  return out;
}

/** Removes files older than a day, then the oldest until the folder plus `room` fits in `cap`. */
export function sweep(dir: string, now: number, room = 0, cap = MAX_KEPT): void {
  const kept: Kept[] = [];
  for (const f of listed(dir)) {
    if (now - f.at > KEEP_MS) rmSync(f.path, { force: true });
    else kept.push(f);
  }
  kept.sort((a, b) => a.at - b.at);
  let total = kept.reduce((n, f) => n + f.size, 0) + room;
  for (const f of kept) {
    if (total <= cap) break;
    rmSync(f.path, { force: true });
    total -= f.size;
  }
}

/** Saves the bytes under `name` (a file of that name is replaced), written aside then renamed in. */
export function save(dir: string, name: string, bytes: Uint8Array, now: number): string {
  mkdirSync(dir, { recursive: true });
  sweep(dir, now, bytes.byteLength);
  const part = join(dir, `.${randomBytes(6).toString("hex")}.part`);
  try {
    writeFileSync(part, bytes, { flag: "wx", mode: 0o600 });
    renameSync(part, join(dir, name));
  } finally {
    rmSync(part, { force: true });
  }
  return name;
}
