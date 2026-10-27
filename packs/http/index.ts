/**
 * HTTP client Pack (`http`): a request editor inside Dovre, so there's no switching to Postman.
 *
 * Local only: requests go out from this machine (localhost and VPN-only services included). That
 * makes every route here something another site must never drive, so all of /http sits behind
 * core's strictOrigin (exact Origin on every POST, a 404 for anything another site started), and:
 *  - Nothing is sent on a GET or in the background: a send is one click on POST /http/send. It's
 *    declared one click on purpose (sending is the point), and logged to the actions table
 *    (`http.send`: method, host and path, the status; never the query, headers or body).
 *  - Secrets come from this instance's settings (HTTP_SECRETS names them, each bound to the hosts
 *    it may go to); they're never written to a repo file, a log or a page (masked as ••••).
 *  - Responses stay in memory (MAX_HISTORY sends, MAX_RESPONSE bytes each), never stored.
 *  - Saving writes `.http/<name>.http` in a checkout directly under CODE_DIR (`http.save`, logged):
 *    a new file or a request added to the end is one click (nothing that was there changes);
 *    replacing a request in a file is a two-click Confirm (`http.replace`, one click if I set it so on
 *    Settings → Writes). Both re-check the file first.
 *  - Agents (agent.ts): drafted prompts on core's /agents/new, and the `send` tool on Dovre's MCP
 *    server (Pack.tools): a running agent turn's GET or HEAD, only to this machine or HTTP_AGENT_HOSTS,
 *    secrets bound as for any send, the answer masked and cut short, in history, logged.
 *  - Running a file as a smoke test (run.ts, checks.ts): GET /http/run shows what it will send and
 *    each request's `# @expect` checks, sending nothing; one click on POST /http/run sends them one
 *    after the other (each an ordinary send, re-checked against the file as it was shown), and the
 *    results fill in over the hub. Logged as `http.run` (the file, how many passed).
 *  - Importing curl, an OpenAPI spec (openapi.ts) or a Postman / Bruno collection (collections.ts)
 *    only reads the text: nothing is fetched or sent. Saving the requests adds them to a new file or the end of one (`http.save`, one click).
 */
import { html } from "hono/html";
import type { Context } from "hono";
import { logAction } from "dovre/actions/deploys.ts";
import type { AppEnv } from "dovre/env.ts";
import { type Pack, type PackContext, PACK_API, type ToolCall, type ToolResult } from "dovre/packs/types.ts";
import { AGENT_BODY, AGENT_METHODS, agentHosts, agentMayReach, forAgent } from "./agent.ts";
import { strictOrigin } from "dovre/strict.ts";
import { codeDirOf, listFiles, listRepos, readFile, repoEnvs, repoRoot, writeFile } from "./files.ts";
import { blankReq, CREDENTIAL_HEADERS, headerLines, MAX_URL, envNames, fromCurl, masker, parseEnvs, parseHttp, parseSecrets, placeholdSecrets, prepare, type Req, reqOfForm, secretIn, serializeReq, toCurl, varsOf, withReq } from "./model.ts";
import { createHistory, failure, type History, type Sent, sendOnce } from "./send.ts";
import { previous } from "./compare.ts";
import { styles as jsonStyles } from "../json/view.ts";
import { confirmSavePage, fileOk, homeHref, type HomeOpts, homePage, noWhere, openapiPage, runPage, runPageHref, runPlanPage, sentHref, sentPage, type Where } from "./view.ts";
import { fileNameOf, fromOpenApi, MAX_SPEC } from "./openapi.ts";
import { fromCollection, varLines } from "./collections.ts";

/** Pasted text as requests: a Postman or Bruno collection, else an OpenAPI spec. */
const importText = (text: string) => fromCollection(text) ?? fromOpenApi(text);
import { parseCheck, runChecks } from "./checks.ts";
import { createRuns, failedSteps, MAX_RUN, passed, type Run } from "./run.ts";

/** How a response's body is shown, or `diff` against the send before it. */
const VIEWS = ["pretty", "tree", "raw", "diff"] as const;

export type CreateHttpPackOpts = { fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number };

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

function whereOf(f: Record<string, unknown>): Where {
  return { env: str(f.env, 64), repo: str(f.repo, 100), file: str(f.file, 85).trim(), opened: str(f.opened, 85), n: /^\d{1,4}$/.test(str(f.n)) ? str(f.n) : "", hash: /^[0-9a-f]{1,64}$/.test(str(f.hash)) ? str(f.hash) : "" };
}

export function createHttpPack(opts: CreateHttpPackOpts = {}): Pack & { history(): History } {
  const history = createHistory();
  const runs = createRuns();
  const now = opts.now ?? Date.now;

  const secretsOf = (ctx: PackContext) => parseSecrets(ctx.env.HTTP_SECRETS, ctx.env);

  /** The variables for a request: the repo's and this instance's environments, then the file's own. */
  function varsFor(ctx: PackContext, w: Where): { vars: Record<string, string>; envs: string[] } {
    const mine = parseEnvs(ctx.env.HTTP_ENVS);
    const root = w.repo ? repoRoot(codeDirOf(ctx.env), w.repo) : null;
    const theirs = repoEnvs(root);
    let fileVars: Record<string, string> = {};
    if (root && w.opened && fileOk(w.opened)) {
      try {
        fileVars = parseHttp(readFile(root, w.opened).text).vars;
      } catch {
        // A file that's gone has no variables.
      }
    }
    return { vars: { ...varsOf(w.env, theirs, mine), ...fileVars }, envs: envNames(theirs, mine) };
  }

  /** Where it would go, worked out without sending: the URL masked, or why it won't go. */
  function targetOf(ctx: PackContext, r: Req, w: Where): HomeOpts["target"] {
    if (!r.url) return undefined;
    const secrets = secretsOf(ctx);
    const p = prepare(r, varsFor(ctx, w).vars, secrets, now());
    return p.ok ? { ok: true, text: masker(secrets)(p.url) } : { ok: false, text: p.error };
  }

  function draw(ctx: PackContext, c: Context<AppEnv>, r: Req, w: Where, extra: Partial<HomeOpts> = {}, status = 200) {
    const codeDir = codeDirOf(ctx.env);
    const root = w.repo ? repoRoot(codeDir, w.repo) : null;
    const body = homePage({
      // A secret's value typed in shows as its {{NAME}}: it's never drawn back.
      req: placeholdSecrets(r, secretsOf(ctx)),
      where: w,
      envs: varsFor(ctx, w).envs,
      repos: listRepos(codeDir),
      secrets: secretsOf(ctx),
      target: targetOf(ctx, r, w),
      files: root ? listFiles(root) : undefined,
      history: history.list(),
      ...extra,
    });
    return ctx.page(c, { title: "HTTP client", body, current: "/http" }).then((res) => (status === 200 ? res : new Response(res.body, { status, headers: res.headers })));
  }

  /** Sends in the background; the page it redirects to fills in when the answer is here. */
  function start(ctx: PackContext, r: Req, w: Where, p: Extract<ReturnType<typeof prepare>, { ok: true }>, by?: "agent"): { s: Sent; settled: Promise<void> } {
    const secrets = secretsOf(ctx);
    const mask = masker(secrets);
    const id = crypto.randomUUID();
    const s: Sent = {
      id,
      at: now(),
      req: placeholdSecrets(r, secrets),
      from: { env: w.env, repo: w.repo, file: w.opened, n: w.n, hash: w.hash },
      out: { method: p.method, url: mask(p.url), headers: p.headers.map(([k, v]) => [k, CREDENTIAL_HEADERS.has(k.toLowerCase()) ? "••••" : mask(v)]) },
      state: "sending",
      ...(by ? { by } : {}),
    };
    history.add(s);
    const u = new URL(p.url);
    const target = mask(`${p.method} ${u.origin}${u.pathname}`).slice(0, 300);
    const settled = sendOnce(p, { fetchFn: opts.fetchFn ?? fetch, mask, now, timeoutMs: opts.timeoutMs })
      .then(
        async (resp) => {
          s.resp = resp;
          s.state = "done";
          await logAction(ctx.db, { kind: "http.send", target, detail: `${resp.status} · ${resp.ms} ms${by ? " · by an agent" : ""}`, ok: true });
        },
        async (e) => {
          s.state = "failed";
          s.error = failure(e, mask);
          await logAction(ctx.db, { kind: "http.send", target, detail: by ? "by an agent" : undefined, ok: false, error: s.error });
        },
      )
      .catch((e) => ctx.log(`http: couldn't log a send: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
      .finally(() => ctx.publish(["http", `http-sent:${id}`]));
    return { s, settled };
  }

  /** A repo's .http file and its requests, for a run. */
  function loadRun(ctx: PackContext, repo: string, file: string) {
    const root = repoRoot(codeDirOf(ctx.env), repo);
    if (!root) return { ok: false as const, error: "That repo isn't a checkout in your code folder." };
    if (!fileOk(file)) return { ok: false as const, error: "A request file is a plain name ending in .http." };
    try {
      const f = readFile(root, file);
      const reqs = parseHttp(f.text).reqs;
      if (!reqs.length) return { ok: false as const, error: `${f.name} has no requests to run.` };
      return { ok: true as const, f, reqs };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  function planPage(ctx: PackContext, c: Context<AppEnv>, repo: string, env: string, got: Extract<ReturnType<typeof loadRun>, { ok: true }>, problem?: string) {
    const w: Where = { ...noWhere(), env, repo, opened: got.f.name };
    const items = got.reqs.slice(0, MAX_RUN).map((r) => ({
      method: r.method,
      name: r.name,
      target: targetOf(ctx, r, w) ?? { ok: false, text: "No URL." },
      checks: (r.expect ?? []).map((t) => {
        const p = parseCheck(t);
        return { text: t, ...("error" in p ? { error: p.error } : {}) };
      }),
    }));
    c.header("Cache-Control", "no-store");
    return ctx
      .page(c, { title: `Run ${got.f.name}`, current: "/http", body: runPlanPage({ repo, file: got.f.name, env, envs: varsFor(ctx, w).envs, hash: got.f.hash, items, more: Math.max(0, got.reqs.length - MAX_RUN), problem }) })
      .then((res) => (problem ? new Response(res.body, { status: 409, headers: res.headers }) : res));
  }

  /** Sends a run's requests one after the other, holding each response to its checks. */
  async function execute(ctx: PackContext, run: Run, reqs: Extract<ReturnType<typeof loadRun>, { ok: true }>["reqs"], hash: string) {
    const w: Where = { ...noWhere(), env: run.env, repo: run.repo, file: run.file, opened: run.file, hash };
    const secrets = secretsOf(ctx);
    const mask = masker(secrets);
    const vars = varsFor(ctx, w).vars;
    const publish = () => ctx.publish(["http", `http-run:${run.id}`]);
    for (const step of run.steps) {
      const { span: _span, ...r } = reqs[step.n]!;
      const p = prepare(r, vars, secrets, now());
      if (!p.ok) {
        Object.assign(step, { state: "failed", error: `Not sent: ${p.error}` });
        publish();
        continue;
      }
      Object.assign(step, { state: "sending", url: mask(p.url) });
      publish();
      const { s, settled } = start(ctx, r, { ...w, n: String(step.n) }, p);
      step.sentId = s.id;
      await settled;
      if (s.state !== "done" || !s.resp) {
        Object.assign(step, { state: "failed", error: `Nothing came back: ${s.error ?? "it failed"}.` });
      } else {
        step.status = s.resp.status;
        step.ms = s.resp.ms;
        step.checks = runChecks(r.expect, s.resp);
        step.state = step.checks.every((x) => x.ok) ? "passed" : "failed";
      }
      publish();
    }
    run.state = "done";
    const bad = failedSteps(run);
    await logAction(ctx.db, { kind: "http.run", target: `${run.repo}/.http/${run.file}`, detail: `${passed(run)} of ${run.steps.length} passed${run.env ? ` · ${run.env}` : ""}`.slice(0, 200), ok: bad === 0, error: bad ? `${bad} failed` : undefined });
  }

  /** The `send` tool: an agent's GET or HEAD, to this machine or a host I listed; what came back, masked. */
  async function agentSend(ctx: PackContext, a: Record<string, unknown>, call: ToolCall, listed: string[]): Promise<ToolResult> {
    const method = typeof a.method === "string" ? a.method.toUpperCase() : "GET";
    if (!(AGENT_METHODS as readonly string[]).includes(method)) return { text: `Only ${AGENT_METHODS.join(" and ")} requests: an agent can read, not change things. Nothing was sent.`, error: true };
    const url = str(a.url, MAX_URL).replace(/[\r\n]/g, "").trim();
    if (!url) return { text: "A url is needed.", error: true };
    const headers: [string, string][] = a.headers && typeof a.headers === "object" && !Array.isArray(a.headers) ? Object.entries(a.headers as Record<string, unknown>).slice(0, 50).flatMap(([k, v]) => (typeof v === "string" ? headerLines(`${k}: ${v.slice(0, 4000)}`) : [])) : [];
    const r: Req = { ...blankReq(), method: method as Req["method"], url, headers };
    const w: Where = { ...noWhere(), env: str(a.env, 64), repo: call.repo };
    const secrets = secretsOf(ctx);
    const p = prepare(r, varsFor(ctx, w).vars, secrets, now());
    if (!p.ok) return { text: p.error, error: true };
    if (!agentMayReach(p.url, listed)) {
      const host = masker(secrets)(new URL(p.url).host);
      return { text: `An agent may only send to this machine (localhost) or the hosts in HTTP_AGENT_HOSTS; ${host} isn't one. Nothing was sent.`, error: true };
    }
    const { s, settled } = start(ctx, r, w, p, "agent");
    await settled;
    return { text: forAgent(s), error: s.state !== "done" };
  }

  return {
    history: () => history,
    // The JSON tools' tree and diff classes, for a response body shown as a tree or compared.
    styles: jsonStyles,
    manifest: {
      api: PACK_API,
      id: "http",
      name: "HTTP client",
      description: "Send HTTP requests from this machine; saved per repo as .http files, with environments and secrets bound to hosts.",
      domain: "general",
      execution: "local-only",
      private: true,
      settings: [
        { key: "HTTP_SECRETS", label: "Secrets and their hosts", help: "NAME@host entries, comma separated (API_TOKEN@api.example.com, LOCAL_KEY@localhost:3000). {{NAME}} is filled from this machine's setting NAME, and only in a request to one of its hosts." },
        { key: "HTTP_AGENT_HOSTS", label: "Hosts an agent may send to", help: "Agents Dovre starts can send GET and HEAD requests through this client (its send tool), to this machine (localhost) and the hosts listed here (api.staging.example.com, host:port), comma separated. off: agents can't send." },
        { key: "HTTP_ENVS", label: "Environments", help: 'Your own environments, as JSON: {"local": {"baseUrl": "http://localhost:3000"}}. Public values only; a repo adds its own in .http/http-client.env.json.' },
      ],
    },

    writes: [{ kind: "replace", label: "Replace a saved request in a .http file" }],

    available: (ctx) => !ctx.hosted,

    tools: (ctx) => {
      const listed = agentHosts(ctx.env.HTTP_AGENT_HOSTS);
      if (!listed) return [];
      const where = ["this machine (localhost)", ...listed].join(", ");
      return [
        {
          name: "send",
          description: `Send a GET or HEAD request through Dovre's HTTP client and get the response back (status, a few headers, the body cut at ${AGENT_BODY} characters). Only to ${where}; anything else is refused. {{name}} fills in from the environment (env) and the repo's .http/http-client.env.json; a secret {{NAME}} fills in only for the hosts it's bound to, and its value never comes back (shown as ••••). No redirects are followed; 30 s at most. Each send shows in the HTTP client's history.`,
          input: {
            type: "object",
            properties: {
              method: { type: "string", enum: [...AGENT_METHODS], description: "GET (default) or HEAD." },
              url: { type: "string", description: "http:// or https:// URL; may use {{baseUrl}} and other variables." },
              headers: { type: "object", additionalProperties: { type: "string" }, description: "Request headers, e.g. {\"Accept\": \"application/json\", \"Authorization\": \"Bearer {{API_TOKEN}}\"}." },
              env: { type: "string", description: "An environment's name, for its variables." },
            },
            required: ["url"],
            additionalProperties: false,
          },
          run: (a, c, call) => agentSend(c, a, call, listed),
        },
      ];
    },

    nav: () => [{ href: "/http", title: "HTTP", icon: "arrow", group: "Code" }],

    pages: () => [{ title: "HTTP client", href: "/http", icon: "↗", about: "Send HTTP requests, saved as .http files", also: ["http", "rest", "api", "curl", "postman", "request"] }],

    about: (_ctx, path) => (path.startsWith("/http") ? "The HTTP client (requests and responses aren't shared)." : undefined),

    slots: () => ({
      "actions.what": ({ kind }) => (kind === "http.send" ? "Sent an HTTP request" : kind === "http.run" ? "Ran a .http file as a smoke test" : kind === "http.save" ? "Saved an HTTP request to a repo" : undefined),
    }),

    settings: (ctx) => {
      const s = secretsOf(ctx);
      return s.length
        ? html`<p class="notes">Secrets: ${s.map((x, i) => html`${i ? ", " : ""}<code>${x.name}</code> to ${x.hosts.join(", ")}${x.value ? "" : " (not set on this machine)"}`)}.</p>`
        : html`<p class="notes">No secrets yet: name them in HTTP_SECRETS, each with the hosts it may go to.</p>`;
    },

    routes(app, ctx) {
      app.use("/http", strictOrigin);
      app.use("/http/*", strictOrigin);

      app.get("/http", async (c) => {
        const q = c.req.query();
        const w: Where = { ...noWhere(), env: str(q.env, 64), repo: str(q.repo, 100) };
        let r = blankReq();
        let flash: HomeOpts["flash"];
        const file = str(q.file, 85);
        if (w.repo && file) {
          const root = repoRoot(codeDirOf(ctx.env), w.repo);
          try {
            if (!root) throw new Error("That repo isn't a checkout in your code folder.");
            const f = readFile(root, file);
            const n = /^\d{1,4}$/.test(q.n ?? "") ? Number(q.n) : 0;
            const found = parseHttp(f.text).reqs[n];
            if (!found) throw new Error(`${file} has no request #${n + 1}.`);
            const { span: _span, ...req } = found;
            r = req;
            Object.assign(w, { file: f.name, opened: f.name, n: String(n), hash: f.hash });
          } catch (e) {
            flash = { tone: "warn", text: (e as Error).message };
          }
        }
        if (q.saved === "1" && !flash) flash = { tone: "ok", text: html`Saved in <code>${w.repo}/.http/${w.file}</code>.` };
        return draw(ctx, c, r, w, { flash });
      });

      app.post("/http/send", async (c) => {
        const f = await c.req.parseBody();
        const r = reqOfForm(f);
        const w = whereOf(f);
        const p = prepare(r, varsFor(ctx, w).vars, secretsOf(ctx), now());
        if (!p.ok) return draw(ctx, c, r, w, { flash: { tone: "warn", text: p.error } }, 400);
        const { s } = start(ctx, r, w, p);
        return c.redirect(sentHref(s.id), 303);
      });

      app.get("/http/r/:id", async (c) => {
        const s = history.get(c.req.param("id"));
        if (!s) return c.redirect("/http", 303);
        const w: Where = { ...noWhere(), env: s.from.env, repo: s.from.repo, opened: s.from.file, file: s.from.file, n: s.from.n, hash: s.from.hash };
        const codeDir = codeDirOf(ctx.env);
        c.header("Cache-Control", "no-store");
        return ctx.page(c, {
          title: s.req.name || "HTTP response",
          current: "/http",
          head: html`<meta name="u-topics" content="http http-sent:${s.id}">`,
          body: sentPage({ sent: s, view: VIEWS.find((v) => v === c.req.query("view")) ?? "pretty", prev: previous(history.list(), s), req: s.req, where: w, envs: varsFor(ctx, w).envs, repos: listRepos(codeDir), secrets: secretsOf(ctx), history: history.list() }),
        });
      });

      // What a run of the file would send, and its checks: nothing is sent here.
      app.get("/http/run", async (c) => {
        const q = c.req.query();
        const repo = str(q.repo, 100);
        const env = str(q.env, 64);
        const got = loadRun(ctx, repo, str(q.file, 85));
        if (!got.ok) return draw(ctx, c, blankReq(), { ...noWhere(), repo, env }, { flash: { tone: "warn", text: got.error } }, 400);
        return planPage(ctx, c, repo, env, got);
      });

      app.post("/http/run", async (c) => {
        const f = await c.req.parseBody();
        const repo = str(f.repo, 100);
        const env = str(f.env, 64);
        const got = loadRun(ctx, repo, str(f.file, 85));
        if (!got.ok) return draw(ctx, c, blankReq(), { ...noWhere(), repo, env }, { flash: { tone: "warn", text: got.error } }, 400);
        // Only what was shown runs: a file that changed since is shown again.
        if (got.f.hash !== str(f.hash, 64)) return planPage(ctx, c, repo, env, got, `${got.f.name} changed since it was shown: nothing was sent. This is what's in it now.`);
        const mask = masker(secretsOf(ctx));
        const run: Run = {
          id: crypto.randomUUID(),
          at: now(),
          repo,
          file: got.f.name,
          env,
          state: "running",
          steps: got.reqs.slice(0, MAX_RUN).map((r, n) => ({ n, name: r.name, method: r.method, url: mask(r.url), state: "waiting", checks: [] })),
        };
        runs.add(run);
        void execute(ctx, run, got.reqs, got.f.hash)
          .catch((e) => {
            run.state = "done";
            ctx.log(`http: a run stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          })
          .finally(() => ctx.publish(["http", `http-run:${run.id}`]));
        return c.redirect(runPageHref(run.id), 303);
      });

      app.get("/http/run/:id", async (c) => {
        const run = runs.get(c.req.param("id"));
        if (!run) return c.redirect("/http", 303);
        c.header("Cache-Control", "no-store");
        return ctx.page(c, { title: `Run ${run.file}`, current: "/http", head: html`<meta name="u-topics" content="http http-run:${run.id}">`, body: runPage(run, (id) => !!history.get(id)) });
      });

      app.post("/http/curl", async (c) => {
        const f = await c.req.parseBody();
        const r = reqOfForm(f);
        const w = whereOf(f);
        return draw(ctx, c, r, w, { curlOut: r.url ? toCurl(r, varsFor(ctx, w).vars, secretsOf(ctx), now()) : "" });
      });

      app.post("/http/import", async (c) => {
        const f = await c.req.parseBody();
        const text = str(f.curl, 256_000);
        const got = fromCurl(text);
        if (!got.ok) return draw(ctx, c, blankReq(), noWhere(), { flash: { tone: "warn", text: got.error }, curl: masker(secretsOf(ctx))(text) }, 400);
        const r = placeholdSecrets(got.req, secretsOf(ctx));
        return draw(ctx, c, r, noWhere(), { flash: { tone: "neutral", text: got.notes.length ? `Imported. ${got.notes.join(" ")}` : "Imported: nothing was sent." } });
      });

      // A request from an imported spec, into the editor: nothing is sent.
      app.post("/http/open", async (c) => {
        const r = placeholdSecrets(reqOfForm(await c.req.parseBody()), secretsOf(ctx));
        return draw(ctx, c, r, noWhere(), { flash: { tone: "neutral", text: "Opened: nothing was sent." } });
      });

      app.post("/http/openapi", async (c) => {
        const f = await c.req.parseBody();
        const spec = str(f.spec, MAX_SPEC);
        const got = importText(spec);
        if (!got.ok) return draw(ctx, c, blankReq(), noWhere(), { flash: { tone: "warn", text: got.error }, spec }, 400);
        return ctx.page(c, { title: got.title, current: "/http", body: openapiPage({ got, spec, repos: listRepos(codeDirOf(ctx.env)), repo: str(f.repo, 100), file: fileNameOf(got.title) }) });
      });

      // Every operation added to a repo's .http file: a new file, or at the end of one (nothing there changes).
      app.post("/http/openapi/save", async (c) => {
        const f = await c.req.parseBody();
        const spec = str(f.spec, MAX_SPEC);
        const repo = str(f.repo, 100);
        const file = str(f.file, 85).trim();
        const got = importText(spec);
        if (!got.ok) return draw(ctx, c, blankReq(), noWhere(), { flash: { tone: "warn", text: got.error }, spec }, 400);
        const fail = async (problem: string) => {
          const res = await ctx.page(c, { title: got.title, current: "/http", body: openapiPage({ got, spec, repos: listRepos(codeDirOf(ctx.env)), repo, file, problem }) });
          return new Response(res.body, { status: 400, headers: res.headers });
        };
        const root = repoRoot(codeDirOf(ctx.env), repo);
        if (!root) return fail("Pick a repo (a checkout directly in your code folder) to save in.");
        if (!fileOk(file)) return fail("The file is a plain name ending in .http (api.http).");
        let current: { text: string; hash: string } | undefined;
        try {
          current = readFile(root, file);
        } catch (e) {
          const m = (e as Error).message;
          if (!m.endsWith("isn't there.")) return fail(m);
        }
        const blocks = got.reqs.map(serializeReq).join("\n");
        const head =
          got.from === "an OpenAPI spec"
            ? `# ${got.title}: imported from an OpenAPI spec.${got.server ? ` Its server: ${got.server}` : ""}\n# Set {{baseUrl}} in an environment.\n\n`
            : `# ${got.title}: imported from ${got.from}.\n${got.vars?.length ? `${varLines(got.vars)}\n` : ""}\n`;
        const text = current ? `${current.text.replace(/\s+$/, "")}\n\n${blocks}` : head + blocks;
        const leak = secretIn(text, secretsOf(ctx));
        if (leak) return fail(`That has ${leak.name}'s value in it: nothing was saved.`);
        const target = `${repo}/.http/${file}`;
        const done = writeFile(root, file, text, current ? current.hash : "");
        await logAction(ctx.db, { kind: "http.save", target, detail: `${current ? "added" : "created"} · ${got.reqs.length} from ${got.from.replace(/^an? /, "")} (${got.title})`.slice(0, 200), ok: done.ok, error: done.ok ? undefined : done.error });
        if (!done.ok) return fail(`${done.error} Nothing was saved.`);
        const n = current ? parseHttp(current.text).reqs.length : 0;
        return c.redirect(homeHref({ repo, file, n: String(n), saved: "1" }), 303);
      });

      app.post("/http/save", async (c) => {
        const f = await c.req.parseBody();
        const r = reqOfForm(f);
        const w = whereOf(f);
        const refuse = (text: string) => draw(ctx, c, r, w, { flash: { tone: "warn", text } }, 400);
        const root = repoRoot(codeDirOf(ctx.env), w.repo);
        if (!root) return refuse("Pick a repo (a checkout directly in your code folder) to save in.");
        if (!fileOk(w.file)) return refuse("The file is a plain name ending in .http (api.http).");
        if (!r.url) return refuse("A request needs a URL to be saved.");
        const leak = secretIn(serializeReq(r), secretsOf(ctx));
        if (leak) return refuse(`That request has ${leak.name}'s value in it: write {{${leak.name}}} instead. Nothing was saved.`);
        const target = `${w.repo}/.http/${w.file}`;
        const detail = `${r.method} ${r.name || "(unnamed)"}`.slice(0, 200);
        const log = (ok: boolean, what: string, error?: string) => logAction(ctx.db, { kind: "http.save", target, detail: `${what} · ${detail}`, ok, error });

        // Re-check what's there now.
        let current: { text: string; hash: string } | undefined;
        try {
          current = readFile(root, w.file);
        } catch (e) {
          const m = (e as Error).message;
          if (!m.endsWith("isn't there.")) return refuse(m);
        }
        const replacing = current && w.opened === w.file && w.n !== "" && w.hash;
        if (replacing && current!.hash !== w.hash) {
          await log(false, "replace", "changed since it was opened");
          return refuse(`${w.file} changed since it was opened: nothing was saved. Open it again to edit what's there now.`);
        }
        if (replacing && f.confirm !== "1") {
          const was = parseHttp(current!.text).reqs[Number(w.n)];
          if (!was) return refuse(`${w.file} has no request #${Number(w.n) + 1} any more: nothing was saved.`);
          return ctx.page(c, { title: "Save the request", current: "/http", body: confirmSavePage({ req: r, where: w, replacing: `${was.method} ${was.name || was.url}` }) });
        }
        const text = current ? withReq(current.text, r, replacing ? Number(w.n) : undefined) : serializeReq(r);
        if (text === null) return refuse(`${w.file} has no request #${Number(w.n) + 1} any more: nothing was saved.`);
        const what = !current ? "created" : replacing ? `replaced #${Number(w.n) + 1}` : "added";
        const done = writeFile(root, w.file, text, current ? current.hash : "");
        await log(done.ok, what, done.ok ? undefined : done.error);
        if (!done.ok) return refuse(`${done.error} Nothing was saved.`);
        const n = replacing ? Number(w.n) : parseHttp(text).reqs.length - 1;
        return c.redirect(homeHref({ repo: w.repo, file: w.file, n: String(Math.max(0, n)), env: w.env, saved: "1" }), 303);
      });
    },
  };
}

export const httpPack: Pack = createHttpPack();
export const httpCrate = httpPack;
