/**
 * HTTP client (`http`): a response next to the one before it, from the same request (method and
 * URL as they went out) in this session's history. Status, headers (by name), and the body: for two
 * JSON bodies a structural diff (key order ignored, the JSON tools' own), else whether they differ.
 */
import { type Change, diff, parse } from "../json/tools.ts";
import type { Resp, Sent } from "./send.ts";

/** The send before `s` to the same method and URL that came back, from a newest-first list. */
export function previous(list: Sent[], s: Sent): Sent | undefined {
  const i = list.findIndex((x) => x.id === s.id);
  if (i < 0) return undefined;
  return list.slice(i + 1).find((x) => x.state === "done" && !!x.resp && x.out.method === s.out.method && x.out.url === s.out.url);
}

export type HeaderChange = { name: string; kind: "added" | "removed" | "changed"; before?: string; after?: string };

export type Compared = {
  status?: { before: number; after: number };
  headers: HeaderChange[];
  body: { kind: "json"; changes: Change[]; more: boolean } | { kind: "text"; same: boolean; before: number; after: number } | { kind: "binary"; same: boolean };
};

/** Headers by lower-cased name; a repeated header's values joined, as fetch does. */
function byName(h: [string, string][]): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of h) {
    const n = k.toLowerCase();
    m.set(n, m.has(n) ? `${m.get(n)}, ${v}` : v);
  }
  return m;
}

const asJson = (r: Resp) => {
  if (r.binary || r.truncated || !/^\s*[[{]/.test(r.body)) return undefined;
  const p = parse(r.body);
  return p.ok ? p.value : undefined;
};

export function compare(before: Resp, after: Resp): Compared {
  const headers: HeaderChange[] = [];
  const a = byName(before.headers), b = byName(after.headers);
  for (const [name, v] of b) {
    if (!a.has(name)) headers.push({ name, kind: "added", after: v });
    else if (a.get(name) !== v) headers.push({ name, kind: "changed", before: a.get(name), after: v });
  }
  for (const [name, v] of a) if (!b.has(name)) headers.push({ name, kind: "removed", before: v });
  headers.sort((x, y) => x.name.localeCompare(y.name));

  let body: Compared["body"];
  const ja = asJson(before), jb = asJson(after);
  if (ja !== undefined && jb !== undefined) body = { kind: "json", ...diff(ja, jb) };
  else if (before.binary || after.binary) body = { kind: "binary", same: before.binary === after.binary && before.size === after.size && before.body === after.body };
  else body = { kind: "text", same: before.body === after.body, before: before.size, after: after.size };

  return { status: before.status !== after.status ? { before: before.status, after: after.status } : undefined, headers, body };
}
