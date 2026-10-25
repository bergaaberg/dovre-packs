/**
 * Jira Pack (`jira`): queries open Jira issues assigned to you via Jira REST API v3 (`/rest/api/3/search/jql`).
 */
import type { PackContext } from "dovre/packs/types.ts";

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  priority?: string;
  url: string;
};

export type JiraKept = {
  at: number;
  ok: boolean;
  site: string;
  error?: string;
  issues: JiraIssue[];
};

export async function readJira(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<JiraKept> {
  const site = (ctx.env.JIRA_SITE ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
  const email = (ctx.env.JIRA_EMAIL ?? "").trim();
  const token = (ctx.env.JIRA_TOKEN ?? "").trim();

  if (!site || !token) {
    return { at: now, ok: false, site, error: "Set JIRA_SITE and JIRA_TOKEN to read Jira issues.", issues: [] };
  }

  const auth = email ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` : `Bearer ${token}`;
  const jql = ctx.env.JIRA_JQL?.trim() || "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
  const url = `https://${site}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=30&fields=summary,status,priority`;

  try {
    const res = await fetchFn(url, {
      headers: { accept: "application/json", authorization: auth },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { at: now, ok: false, site, error: `Jira HTTP ${res.status}`, issues: [] };
    const j = (await res.json()) as {
      issues?: {
        key?: string;
        fields?: { summary?: string; status?: { name?: string }; priority?: { name?: string } };
      }[];
    };
    const issues: JiraIssue[] = (j.issues ?? []).flatMap((i) => {
      const key = String(i.key ?? "").trim();
      if (!/^[A-Z][A-Z0-9_]{1,15}-\d+$/.test(key)) return [];
      return [
        {
          key,
          summary: String(i.fields?.summary ?? key).slice(0, 200),
          status: String(i.fields?.status?.name ?? "Open").slice(0, 60),
          priority: i.fields?.priority?.name ? String(i.fields.priority.name).slice(0, 40) : undefined,
          url: `https://${site}/browse/${key}`,
        },
      ];
    });
    return { at: now, ok: true, site, issues };
  } catch (e) {
    return { at: now, ok: false, site, error: String((e as Error)?.message ?? e).slice(0, 180), issues: [] };
  }
}
