/** Jira Pack (`jira`) tests. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { createJiraPack } from "../index.ts";
import { jiraPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;

test("jira: reads issues, links ticket keys, and escapes hostile summaries", async () => {
  const pack = createJiraPack({
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          issues: [
            { key: "PLAT-42", fields: { summary: "Add D1 migration check", status: { name: "In Progress" }, priority: { name: "High" } } },
            { key: "PLAT-43", fields: { summary: H, status: { name: H } } },
          ],
        }),
        { status: 200 },
      ),
  });
  const ctx = testContext({ env: { JIRA_SITE: "acme.atlassian.net", JIRA_TOKEN: "tok" } });
  await pack.refresh!(ctx);
  assert.equal(pack.kept()!.issues.length, 2);
  assert.equal(pack.refs!(ctx)[0]!.href("PLAT-42"), "https://acme.atlassian.net/browse/PLAT-42");
  const out = String(await jiraPage(pack.kept()));
  assert.ok(!out.includes("<script>") && !out.includes("<img"));
});
