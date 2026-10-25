/**
 * Jira Pack (`jira`): open assigned Jira issues, Today card, and automatic ticket key linking (`PROJ-123`).
 */
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { type JiraKept, readJira } from "./data.ts";
import { jiraCard, jiraPage } from "./view.ts";

export function createJiraPack(opts: { fetchFn?: typeof fetch } = {}): Pack & { kept(): JiraKept | undefined } {
  let kept: JiraKept | undefined;
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "jira",
      name: "Jira",
      description: "Open assigned Jira issues and automatic ticket key linking.",
      domain: "work",
      execution: "any",
      everyMs: 5 * 60_000,
      settings: [
        { key: "JIRA_SITE", label: "Jira hostname", required: true, help: "e.g. your-org.atlassian.net" },
        { key: "JIRA_EMAIL", label: "Jira account email", help: "For Atlassian Cloud Basic auth" },
        { key: "JIRA_TOKEN", label: "Jira API token", secret: true, required: true },
      ],
    },
    async refresh(ctx) {
      kept = await readJira(ctx, opts.fetchFn);
      ctx.publish(["jira", "snapshot"]);
    },
    nav: () => [{ href: "/jira", title: "Jira", icon: "ticket", group: "Code" }],
    pages: () => [{ title: "Jira", href: "/jira", icon: "🎫", about: "Assigned Jira issues", also: ["tickets", "sprint"] }],
    routes(app, ctx) {
      app.get("/jira", (c) => ctx.page(c, { title: "Jira", body: jiraPage(kept) }));
    },
    today: () => (kept ? [{ id: "now", render: jiraCard(kept) }] : []),
    refs: (ctx) => {
      const site = (ctx.env.JIRA_SITE ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
      if (!site || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site)) return [];
      return [{ pattern: /\b[A-Z][A-Z0-9_]{1,9}-\d{1,6}\b/g, href: (m) => `https://${site}/browse/${m}` }];
    },
    bino: () =>
      kept?.ok ? kept.issues.map((i) => `${i.key} [${i.status}]: ${i.summary}`).join("\n") : "",
  };
}

export const jiraPack: Pack = createJiraPack();
export const jiraCrate = jiraPack;
