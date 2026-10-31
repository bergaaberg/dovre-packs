/**
 * Jira Pack (`jira`): what's assigned to me and not done, what moved lately in the projects I
 * follow, a Today card, Jira in search, ticket keys (`PROJ-123`) as links, and filing tickets in
 * TICKET_PROJECTS (filing.ts): from New work, search ("New ticket in …") and Bino's card.
 *
 * Two ways to Jira (JIRA_VIA): `rest` with an API token, or `mcp` through Claude Code's Atlassian
 * MCP where tokens are locked down (mcp.ts; local only). A job through the MCP takes ~15 s and a
 * little money, so it runs every JIRA_EVERY_MIN (10) or on "Read now", never per page; a job that
 * fails keeps the last good answer, which is also kept on disk so a restart has something to draw.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { keptFile, type Kept } from "dovre/issues/templates.ts";
import type { Context } from "hono";
import { html } from "hono/html";
import type { AppEnv } from "dovre/env.ts";
import type { ActKind, FindItem, Pack, PackContext } from "dovre/packs/types.ts";
import { PACK_API } from "dovre/packs/types.ts";
import { type Html, Notice } from "dovre/ui/kit.ts";
import { type JiraKept, projectsOf, readJira, siteOf, siteOk, viaOf } from "./data.ts";
import { type Agent, JiraSetupError, loadViaMcp } from "./mcp.ts";
import { createFiling, type Filed, SCREEN_MS } from "./filing.ts";
import { draftPrompt, emptyTicket, first, MAX_SUMMARY, nameOf, ticketFields, ticketProjectsOf, ticketValid, validateTicket } from "./tickets.ts";
import { doneBody, failedBody, formBody, loadingBody, NEW, newHref, noProjectsBody, pickProjectBody, previewBody, problemBody, projectsPanel, workingBody } from "./tickets.view.ts";
import { jiraCard, jiraPage, prFacts, prLead } from "./view.ts";

const everyMsOf = (env: Record<string, string | undefined>) => {
  const min = Number(env.JIRA_EVERY_MIN);
  return (Number.isFinite(min) && min >= 2 ? Math.min(min, 240) : 10) * 60_000;
};

/** The agent as a server runs it: off the main thread, in an empty folder of its own (no CLAUDE.md or project settings to pick up). */
async function serverAgent(): Promise<Agent> {
  const [{ runOff }, { mkdirSync }] = await Promise.all([import("dovre/spawn.ts"), import("node:fs")]);
  const cwd = join(tmpdir(), "dovre-jira");
  mkdirSync(cwd, { recursive: true });
  return { run: runOff, cwd };
}

export function createJiraPack(
  opts: {
    fetchFn?: typeof fetch;
    /** For tests: the MCP agent (default: claude on the PATH, off the main thread). */
    agent?: Agent;
    /** For tests: where the last answer is kept (default: data/jira-kept.json beside Dovre's database). */
    kept?: Kept;
    now?: () => number;
  } = {},
): Pack & { kept(): JiraKept | undefined } {
  const now = opts.now ?? Date.now;
  let kept: JiraKept | undefined;
  let agent: Agent | undefined;
  let store: Kept | undefined;
  /** When the last MCP job started: the cadence counts from attempts, so a signed-out MCP isn't asked every round. */
  let triedAt = Number.NEGATIVE_INFINITY;
  let force = false;
  const theAgent = async () => (agent ??= opts.agent ?? (await serverAgent()));
  const filing = createFiling({ agent: theAgent, fetchFn: opts.fetchFn, now });
  /** Creates started from a preview, by its one-time value: pressing Create twice shows the same one. */
  type Job = { state: "working"; project: string; summary: string } | { state: "done"; key: string; warning?: string } | { state: "failed"; problem: string; again: Parameters<typeof previewBody>[0] };
  const jobs = new Map<string, Job>();
  const isNonce = (s: string) => /^[0-9a-f-]{36}$/.test(s);
  /** The kept ticket a PR's branch or title names (any case), if the pack keeps it; nothing is fetched. */
  const ticketOf = ({ branch, title }: { branch: string; title: string }) => {
    if (!kept?.ok) return undefined;
    const have = new Map<string, JiraKept["mine"][number]>();
    for (const i of [...kept.mine, ...kept.moving]) if (!have.has(i.key.toUpperCase())) have.set(i.key.toUpperCase(), i);
    for (const text of [branch, title])
      for (const m of text.matchAll(/(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]{1,9}-\d{1,9}(?![A-Za-z0-9])/g)) {
        const i = have.get(m[0].toUpperCase());
        if (i) return i;
      }
    return undefined;
  };
  const pending = html`<meta name="u-topics" content="jira">`;

  async function readMcp(ctx: PackContext): Promise<void> {
    const site = siteOf(ctx.env);
    if (!force && now() - triedAt < everyMsOf(ctx.env)) return;
    force = false;
    triedAt = now();
    agent ??= opts.agent ?? (await serverAgent());
    try {
      const r = await loadViaMcp(agent, site, projectsOf(ctx.env), ctx.env.JIRA_JQL?.trim() || undefined);
      ctx.log(`via mcp: ${r.mine.length} mine, ${r.moving.length} moving, $${r.cost.toFixed(4)}`);
      kept = { at: now(), ok: true, site, via: "mcp", mine: r.mine, moving: r.moving };
      store?.set("jira", { at: kept.at, value: kept });
    } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 200);
      ctx.log(`via mcp: ${error}`);
      // The last good answer stays; with none, the failure is what there is.
      if (!kept?.ok) kept = { at: now(), ok: false, site, via: "mcp", error, mine: [], moving: [], ...(e instanceof JiraSetupError ? { setup: e.setup } : {}) };
    }
  }

  async function refresh(ctx: PackContext): Promise<void> {
    if (viaOf(ctx.env) === "mcp") await readMcp(ctx);
    else kept = await readJira(ctx, opts.fetchFn, now());
    ctx.publish(["jira", "snapshot"]);
    // The ticket forms' create screens, read once in the background so the first form doesn't wait.
    for (const p of ticketProjectsOf(ctx.env)) if (!filing.kept(p) && !filing.reading(p)) filing.kick(ctx, p);
  }

  /** Bino's ticket: a card with the project, type, summary and description; Create asks again, then files it as the form does. */
  const ticketAct = (ctx: PackContext): ActKind => {
    const projects = ticketProjectsOf(ctx.env);
    return {
      kind: "ticket",
      title: "A ticket in Jira",
      when: `When the user asks you to file, create or write a Jira ticket (a story, a bug, an improvement). \`project\` is one of ${projects.join(", ")}; \`type\` is the work type by name (Story, Bug, Task, or another the project has); \`summary\` one line; \`description\` plain text, in the user's language. Anything else the project asks for takes Jira's default; the user changes it on Jira's form if it matters.`,
      fields: [
        { name: "project", about: `one of ${projects.join(", ")}`, required: true, max: 20 },
        { name: "type", about: "the work type, by name", max: 60 },
        { name: "summary", about: "one line", required: true, max: MAX_SUMMARY },
        { name: "description", about: "plain text", max: 4000, text: true },
      ],
      button: "Create ticket",
      question: "Create this ticket in Jira?",
      hint: "Other fields take Jira's defaults. For more, open the form.",
      inputs(act, k) {
        const v = (name: string) => k?.[name] ?? act[name] ?? "";
        const project = projects.includes(v("project").toUpperCase()) ? v("project").toUpperCase() : (projects[0] ?? "");
        if (!projects.length) return Notice({ tone: "warn", children: html`No project to file in: set <code>TICKET_PROJECTS</code> on the Packs page.` });
        const desc = v("description");
        return html`<label class="field"><span class="label">Project</span><select name="project" required>${projects.map((p) => html`<option value="${p}"${p === project ? html` selected` : ""}>${p}</option>`)}</select></label>
<label class="field"><span class="label">Work type</span><input type="text" name="type" value="${v("type")}" maxlength="60"><span class="hint">By name; empty or unknown: the project's first. <a href="${newHref(project)}">Open the form</a></span></label>
<label class="field"><span class="label">Summary</span><input type="text" name="summary" value="${v("summary")}" maxlength="${MAX_SUMMARY}" required></label>
<label class="field"><span class="label">Description</span><textarea name="description" rows="${Math.min(12, Math.max(4, desc.split("\n").length + 1))}" maxlength="4000">\n${desc}</textarea></label>`;
      },
      async run(form) {
        const got = await filing.fromForm(ctx, { project: form.project ?? "", type_name: form.type ?? "" });
        if ("problem" in got) return { ok: false, error: got.problem };
        const line = got.fields.find((f) => f.kind === "line");
        const para = got.fields.find((f) => f.kind === "paragraph");
        const values: Record<string, string> = { [line ? nameOf(line) : "j_summary"]: form.summary ?? "", ...(para ? { [nameOf(para)]: form.description ?? "" } : {}) };
        const filled = await filing.fromForm(ctx, { project: got.project, type: got.type.id, ...values });
        if ("problem" in filled) return { ok: false, error: filled.problem };
        const r: Filed = await filing.file(ctx, filled);
        return r.ok ? { ok: true, done: `Created ${r.key}${r.warning ? ` (${r.warning})` : ""}`, href: r.url } : { ok: false, error: r.problem };
      },
    };
  };

  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "jira",
      name: "Jira",
      description: "Jira issues assigned to me, what moved in my projects, ticket keys as links, and filing tickets.",
      domain: "work",
      execution: "any",
      everyMs: 5 * 60_000,
      settings: [
        { key: "JIRA_SITE", label: "Jira hostname", required: true, help: "e.g. your-org.atlassian.net" },
        { key: "JIRA_VIA", label: "How to reach Jira", help: "rest (an API token), mcp (Claude Code's Atlassian MCP, where tokens are locked down; local only) or off. Unset: rest with a token, else off." },
        { key: "JIRA_EMAIL", label: "Jira account email", help: "For Atlassian Cloud Basic auth (rest)" },
        { key: "JIRA_TOKEN", label: "Jira API token", secret: true, help: "For rest" },
        { key: "JIRA_PROJECTS", label: "Projects to watch", help: "Jira keys, comma-separated: what moved in them in 3 days, and which keys become links" },
        { key: "JIRA_JQL", label: "Mine (JQL)", help: "Default: assigned to me and not done" },
        { key: "JIRA_EVERY_MIN", label: "Read every (minutes, mcp)", help: "Each read through the MCP is an agent job (default 10)" },
        { key: "TICKET_PROJECTS", label: "File tickets in", help: "Jira keys, comma-separated: where New work, search and Bino can create a ticket. Empty: none." },
      ],
    },
    available: (ctx) => {
      const via = viaOf(ctx.env);
      if (via === "off" || !siteOk(siteOf(ctx.env))) return false;
      return via === "rest" ? !!ctx.env.JIRA_TOKEN?.trim() : !ctx.hosted;
    },
    init(ctx) {
      if (viaOf(ctx.env) !== "mcp") return;
      store = opts.kept ?? keptFile(join(dirname(resolve(ctx.env.U_DB || "data/dovre.sqlite")), "jira-kept.json"));
      const last = store.get("jira")?.value as JiraKept | undefined;
      kept = last?.ok && last.site === siteOf(ctx.env) ? last : { at: now(), ok: false, site: siteOf(ctx.env), via: "mcp", setup: "waiting", error: "", mine: [], moving: [] };
    },
    refresh,
    nav: () => [{ href: "/jira", title: "Jira", icon: "ticket", group: "Plan" }],
    pages: () => [{ title: "Jira", href: "/jira", icon: "🎫", about: "Jira issues: mine, and what moved in my projects", also: ["tickets", "sprint", "saker"] }],
    routes(app, ctx) {
      app.get("/jira", (c) => ctx.page(c, { title: "Jira", body: jiraPage(kept, { refresh: true }) }));
      /** Read Jira now, past the cadence; the page fills in when it lands. */
      app.post("/jira/refresh", (c) => {
        force = true;
        triedAt = Number.NEGATIVE_INFINITY;
        void refresh(ctx);
        return c.redirect("/jira", 303);
      });

      // ── Filing a ticket: the project's create screen, a preview, then Create (the second click) ──
      const site = () => siteOf(ctx.env);
      const draw = async (c: Context<AppEnv>, body: Html, o: { status?: number; live?: boolean; title?: string } = {}) => {
        const res = await ctx.page(c, { title: o.title ?? "New ticket", current: "/jira", body, ...(o.live ? { head: pending } : {}) });
        return o.status && o.status !== 200 ? new Response(res.body, { status: o.status, headers: res.headers }) : res;
      };

      app.get(NEW, async (c) => {
        const projects = ticketProjectsOf(ctx.env);
        if (!projects.length) return draw(c, noProjectsBody());
        const asked = (c.req.query("project") ?? "").trim().toUpperCase();
        if (!asked && projects.length > 1) return draw(c, pickProjectBody(projects));
        const project = asked || projects[0]!;
        if (!projects.includes(project)) return draw(c, problemBody(`Tickets go to ${projects.join(", ")}.`), { status: 400 });
        if (c.req.query("again")) filing.retry(project);
        const k = filing.kept(project);
        // Something to draw: draw it, and read it again in the background when it's old.
        if (k?.screen) {
          if (now() - k.at >= SCREEN_MS) filing.kick(ctx, project);
          const s = k.screen;
          if (!s.types.length) return draw(c, failedBody(site(), project, undefined));
          const typeId = c.req.query("type");
          const type = (typeId && s.types.find((t) => t.id === typeId)) || s.types[0]!;
          const raw = s.fields[type.id];
          const f = raw ? ticketFields(raw) : { fields: [], blocked: [] };
          return draw(c, formBody({ project, types: s.types, ticket: emptyTicket(project, type, f.fields), fields: f.fields, blocked: f.blocked, fieldsFailed: raw ? undefined : "They didn't come back from Jira. Try again in a moment." }), { title: `Ticket in ${project}` });
        }
        if (k?.error && !filing.reading(project)) return draw(c, failedBody(site(), project, k.error), { status: 502 });
        filing.kick(ctx, project);
        return draw(c, loadingBody(project), { live: true, title: `Ticket in ${project}` });
      });

      app.post(`${NEW}/preview`, async (c) => {
        const form = await c.req.parseBody({ all: true });
        const got = await filing.fromForm(ctx, form);
        if ("problem" in got) return draw(c, problemBody(got.problem), { status: got.status });
        const errors = validateTicket(got.ticket, got.fields);
        const again = { project: got.project, types: got.types, ticket: got.ticket, fields: got.fields, blocked: [] };
        if (first(form.edit) === "1") return draw(c, formBody(again));
        if (!ticketValid(errors)) return draw(c, formBody({ ...again, errors }), { status: 422 });
        return draw(c, previewBody({ ticket: got.ticket, fields: got.fields, nonce: randomUUID() }), { title: "Preview" });
      });

      /** Create: checked here, then filed in the background; the job's page fills itself in when it lands. */
      app.post(`${NEW}/create`, async (c) => {
        const form = await c.req.parseBody({ all: true });
        const nonce = first(form.nonce);
        // Pressed twice: the same job. One that failed may be tried again from the same preview.
        if (isNonce(nonce) && jobs.has(nonce) && jobs.get(nonce)!.state !== "failed") return c.redirect(`${NEW}/job/${nonce}`, 303);
        const got = await filing.fromForm(ctx, form);
        if ("problem" in got) return draw(c, problemBody(got.problem), { status: got.status });
        if (!isNonce(nonce)) return draw(c, previewBody({ ticket: got.ticket, fields: got.fields, nonce: randomUUID(), problem: "Create from the preview: nothing was created." }), { status: 400, title: "Preview" });
        const errors = validateTicket(got.ticket, got.fields);
        if (!ticketValid(errors)) return draw(c, formBody({ project: got.project, types: got.types, ticket: got.ticket, fields: got.fields, blocked: [], errors }), { status: 422 });
        jobs.set(nonce, { state: "working", project: got.project, summary: (got.ticket.values[got.fields.find((f) => f.kind === "line")?.id ?? "summary"] ?? "").trim() });
        while (jobs.size > 50) jobs.delete(jobs.keys().next().value!);
        void filing
          .file(ctx, got, { myList: first(form.mylist) === "1" })
          .then((r) => jobs.set(nonce, r.ok ? { state: "done", key: r.key, warning: r.warning } : { state: "failed", problem: r.problem, again: { ticket: got.ticket, fields: got.fields, nonce: randomUUID(), problem: r.problem } }))
          .finally(() => ctx.publish(["jira"]));
        return c.redirect(`${NEW}/job/${nonce}`, 303);
      });

      app.get(`${NEW}/job/:nonce`, async (c) => {
        const job = jobs.get(c.req.param("nonce"));
        if (!job) return draw(c, problemBody("That ticket isn't one this Dovre is creating (it may have restarted): check Jira before trying again."), { status: 404 });
        if (job.state === "working") return draw(c, workingBody(job), { live: true, title: "Creating the ticket" });
        if (job.state === "done") return draw(c, doneBody({ site: site(), key: job.key, warning: job.warning }), { title: "Ticket created" });
        return draw(c, previewBody(job.again), { status: 502, title: "Preview" });
      });

      /** "Or let an agent file it": the note becomes the prompt, shown on /agents/new before anything starts. */
      app.post(`${NEW}/draft`, async (c) => {
        const form = await c.req.parseBody();
        const project = first(form.project).trim().toUpperCase();
        const note = first(form.note).trim();
        const projects = ticketProjectsOf(ctx.env);
        if (!projects.includes(project)) return draw(c, problemBody(`Tickets go to ${projects.join(", ") || "no project"}.`), { status: 400 });
        if (!note || note.length > 4000) return draw(c, problemBody("Describe it first, in under 4000 characters: the agent starts from your note.", newHref(project)), { status: 400 });
        return c.redirect(`/agents/new?prompt=${encodeURIComponent(draftPrompt(site(), project, note))}`, 303);
      });
    },
    today: () => (kept ? [{ id: "now", render: jiraCard(kept) }] : []),
    finds: (ctx) => {
      const out: FindItem[] = ticketProjectsOf(ctx.env).map((p) => ({ title: `New ticket in ${p}`, sub: "Jira", href: newHref(p), kind: "actions", also: ["ticket", "new ticket", "jira", "sak"], icon: "🎫" }));
      if (!kept?.ok) return out;
      const seen = new Set<string>();
      for (const i of [...kept.mine, ...kept.moving]) {
        if (seen.has(i.key)) continue;
        seen.add(i.key);
        out.push({ title: `${i.key} ${i.summary}`, sub: [i.status, i.assignee].filter(Boolean).join(" · "), href: i.url, also: [i.key, i.project], icon: "🎫" });
      }
      return out;
    },
    /** Ticket keys as links: only in the projects I watch or have issues in, once any are known; until then any key-shaped text. */
    refs: (ctx) => {
      const site = siteOf(ctx.env);
      if (!siteOk(site)) return [];
      const projects = new Set([...projectsOf(ctx.env), ...ticketProjectsOf(ctx.env), ...(kept?.mine ?? []).map((i) => i.project)]);
      const pattern = projects.size ? new RegExp(`\\b(?:${[...projects].join("|")})-\\d{1,9}\\b`, "g") : /\b[A-Z][A-Z0-9_]{1,9}-\d{1,6}\b/g;
      return [{ pattern, href: (m) => `https://${site}/browse/${encodeURIComponent(m)}` }];
    },
    bino: (ctx) => {
      const filed = ticketProjectsOf(ctx.env);
      const where = filed.length ? `Jira tickets can be filed in ${filed.join(", ")}.` : "";
      if (!kept?.ok) return where;
      const mine = kept.mine.map((i) => `${i.key} [${i.status}]: ${i.summary}`);
      const moved = new Map<string, number>();
      for (const i of kept.moving) moved.set(i.project, (moved.get(i.project) ?? 0) + 1);
      return [mine.length ? `Mine in Jira:\n${mine.join("\n")}` : "Nothing in Jira assigned to me.", ...[...moved].map(([p, n]) => `${n} moved in ${p} in 3 days.`), where].filter(Boolean).join("\n");
    },
    acts: (ctx) => (ticketProjectsOf(ctx.env).length && !ctx.hosted ? [ticketAct(ctx)] : []),
    slots: (ctx) => ({
      "work.new": () => projectsPanel(ticketProjectsOf(ctx.env)),
      "pr.lead": (pr) => prLead(ticketOf(pr)),
      "pr.facts": (pr) => {
        const i = ticketOf(pr);
        return i ? prFacts(i, `https://${siteOf(ctx.env)}/browse/${encodeURIComponent(i.key)}`) : [];
      },
      "actions.what": ({ kind }) => (kind === "ticket.create" ? "Created a Jira ticket" : undefined),
    }),
  };
}

export const jiraPack: Pack = createJiraPack();
export const jiraCrate = jiraPack;
