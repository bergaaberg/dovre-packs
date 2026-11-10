/**
 * Jira's Bino lookups (REST only: a job through the MCP takes longer than a lookup may): one issue
 * by key, in full, and a search of summaries. The fields come from the model, so a key must look
 * like one and a search loses JQL's special characters before it goes in a query.
 */
import { authOf, siteOf, siteOk, viaOf } from "./data.ts";

const cut = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const oneLine = (v: unknown, max: number) => cut(v, max * 2).replace(/\s+/g, " ").trim().slice(0, max);
const para = (t: string, max: number) => {
  const s = t.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export const KEY = /^[A-Z][A-Z0-9_]{0,20}-\d{1,9}$/;

type Adf = { type?: string; text?: string; attrs?: { text?: string }; content?: Adf[] };
const BLOCKS = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock", "rule", "tableRow", "panel"]);

/** Jira's rich text (Atlassian Document Format) as plain text: its words, mentions by name, a line per block; nothing else (no links, no media). */
export function adfText(node: unknown, depth = 0): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object" || depth > 30) return "";
  const n = node as Adf;
  if (n.type === "text") return typeof n.text === "string" ? n.text : "";
  if (n.type === "mention" || n.type === "emoji") return typeof n.attrs?.text === "string" ? n.attrs.text : "";
  if (n.type === "hardBreak") return "\n";
  const inner = Array.isArray(n.content) ? n.content.map((c) => adfText(c, depth + 1)).join(n.type === "tableRow" ? " | " : "") : "";
  return BLOCKS.has(n.type ?? "") ? `${n.type === "listItem" ? "- " : ""}${inner.trim()}\n` : inner;
}

type Raw = {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    priority?: { name?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    duedate?: string | null;
    labels?: string[];
    comment?: { comments?: { author?: { displayName?: string }; created?: string; body?: unknown }[] };
  };
};

async function get<T>(env: Record<string, string | undefined>, path: string, fetchFn: typeof fetch): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const site = siteOf(env);
  try {
    const res = await fetchFn(`https://${site}${path}`, { headers: { accept: "application/json", authorization: authOf(env) }, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: oneLine(String((e as Error)?.message ?? e), 120) };
  }
}

/** One issue as Bino reads it: its facts, its description and its latest comments, cut to size. */
export async function lookIssue(env: Record<string, string | undefined>, key: string, fetchFn: typeof fetch): Promise<string> {
  const k = key.trim().toUpperCase();
  if (!KEY.test(k)) return `${oneLine(key, 40)} isn't an issue key (like PLAT-42).`;
  const fields = "summary,description,status,priority,issuetype,assignee,reporter,duedate,labels,comment";
  const r = await get<Raw>(env, `/rest/api/3/issue/${encodeURIComponent(k)}?fields=${fields}`, fetchFn);
  if (!r.ok) return r.status === 404 ? `There's no issue ${k} in Jira (or I can't see it).` : `Jira didn't answer: ${r.error}`;
  const f = r.data.fields ?? {};
  const facts = [
    `Status: ${oneLine(f.status?.name, 60) || "?"}`,
    f.issuetype?.name ? `type: ${oneLine(f.issuetype.name, 40)}` : "",
    f.priority?.name ? `priority: ${oneLine(f.priority.name, 40)}` : "",
    `assignee: ${oneLine(f.assignee?.displayName, 80) || "nobody"}`,
    f.reporter?.displayName ? `reporter: ${oneLine(f.reporter.displayName, 80)}` : "",
    f.duedate ? `due ${oneLine(f.duedate, 10)}` : "",
    Array.isArray(f.labels) && f.labels.length ? `labels: ${f.labels.slice(0, 10).map((l) => oneLine(l, 40)).join(", ")}` : "",
  ].filter(Boolean);
  const description = para(adfText(f.description), 2000);
  const comments = (f.comment?.comments ?? []).slice(-5).map((c) => `- ${oneLine(c.author?.displayName, 60) || "someone"} (${oneLine(c.created, 10)}): ${para(adfText(c.body), 300)}`);
  return [
    `${k}: ${oneLine(f.summary, 200)}`,
    `${facts.join(", ")}.`,
    description ? `Description:\n${description}` : "No description.",
    comments.length ? `Latest comments:\n${comments.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Issues whose summary has the words, newest first: one line each. JQL's special characters are dropped, so the words can't change the query. */
export async function searchIssues(env: Record<string, string | undefined>, q: string, fetchFn: typeof fetch): Promise<string> {
  const term = oneLine(q.replace(/[^\p{L}\p{N}\s._-]/gu, " "), 100);
  if (term.length < 2) return "Say at least two letters or digits to search for.";
  const jql = `summary ~ "${term}" ORDER BY updated DESC`;
  const r = await get<{ issues?: Raw[] }>(env, `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=15&fields=summary,status,assignee`, fetchFn);
  if (!r.ok) return `Jira didn't answer: ${r.error}`;
  const rows = (r.data.issues ?? [])
    .filter((i) => KEY.test(String(i.key ?? "")))
    .map((i) => `- ${i.key} [${oneLine(i.fields?.status?.name, 40) || "?"}] ${oneLine(i.fields?.summary, 160)}${i.fields?.assignee?.displayName ? ` (${oneLine(i.fields.assignee.displayName, 60)})` : ""}`);
  return rows.length ? `Issues with "${term}" in the summary:\n${rows.join("\n")}` : `No issue has "${term}" in its summary.`;
}

/** The lookups, when Jira is reached by REST with a site and a token. */
export function jiraLookups(env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch) {
  if (viaOf(env) !== "rest" || !siteOk(siteOf(env)) || !(env.JIRA_TOKEN ?? "").trim()) return [];
  return [
    {
      kind: "issue",
      when: "One Jira issue by its key (PLAT-42): its status, type, priority, assignee, description and latest comments.",
      fields: [{ name: "key", about: "the issue key, e.g. PLAT-42", required: true, max: 30 }],
      run: (a: Record<string, string>) => lookIssue(env, a.key ?? "", fetchFn),
    },
    {
      kind: "search",
      when: "Jira issues whose summary has some words, newest first (15 at most): key, status, summary, assignee.",
      fields: [{ name: "q", about: "words in the summary", required: true, max: 100 }],
      run: (a: Record<string, string>) => searchIssues(env, a.q ?? "", fetchFn),
    },
  ];
}
