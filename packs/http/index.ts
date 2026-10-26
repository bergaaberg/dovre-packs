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
 *    replacing a request in a file is a two-click Confirm. Both re-check the file first.
 */
import { html } from "hono/html";
import type { Context } from "hono";
import { logAction } from "dovre/actions/deploys.ts";
import type { AppEnv } from "dovre/env.ts";
import { type Pack, type PackContext, PACK_API } from "dovre/packs/types.ts";
import { strictOrigin } from "dovre/strict.ts";
import { codeDirOf, listFiles, listRepos, readFile, repoEnvs, repoRoot, writeFile } from "./files.ts";
import { blankReq, CREDENTIAL_HEADERS, envNames, fromCurl, masker, parseEnvs, parseHttp, parseSecrets, placeholdSecrets, prepare, type Req, reqOfForm, secretIn, serializeReq, toCurl, varsOf, withReq } from "./model.ts";
import { createHistory, failure, type History, type Sent, sendOnce } from "./send.ts";
import { confirmSavePage, fileOk, homeHref, type HomeOpts, homePage, noWhere, sentHref, sentPage, type Where } from "./view.ts";

export type CreateHttpPackOpts = { fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number };

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

function whereOf(f: Record<string, unknown>): Where {
  return { env: str(f.env, 64), repo: str(f.repo, 100), file: str(f.file, 85).trim(), opened: str(f.opened, 85), n: /^\d{1,4}$/.test(str(f.n)) ? str(f.n) : "", hash: /^[0-9a-f]{1,64}$/.test(str(f.hash)) ? str(f.hash) : "" };
}

export function createHttpPack(opts: CreateHttpPackOpts = {}): Pack & { history(): History } {
  const history = createHistory();
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
  function start(ctx: PackContext, r: Req, w: Where, p: Extract<ReturnType<typeof prepare>, { ok: true }>): Sent {
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
    };
    history.add(s);
    const u = new URL(p.url);
    const target = mask(`${p.method} ${u.origin}${u.pathname}`).slice(0, 300);
    void sendOnce(p, { fetchFn: opts.fetchFn ?? fetch, mask, now, timeoutMs: opts.timeoutMs })
      .then(
        async (resp) => {
          s.resp = resp;
          s.state = "done";
          await logAction(ctx.db, { kind: "http.send", target, detail: `${resp.status} · ${resp.ms} ms`, ok: true });
        },
        async (e) => {
          s.state = "failed";
          s.error = failure(e, mask);
          await logAction(ctx.db, { kind: "http.send", target, ok: false, error: s.error });
        },
      )
      .catch((e) => ctx.log(`http: couldn't log a send: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
      .finally(() => ctx.publish(["http", `http-sent:${id}`]));
    return s;
  }

  return {
    history: () => history,
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
        { key: "HTTP_ENVS", label: "Environments", help: 'Your own environments, as JSON: {"local": {"baseUrl": "http://localhost:3000"}}. Public values only; a repo adds its own in .http/http-client.env.json.' },
      ],
    },

    available: (ctx) => !ctx.hosted,

    nav: () => [{ href: "/http", title: "HTTP", icon: "arrow", group: "Code" }],

    pages: () => [{ title: "HTTP client", href: "/http", icon: "↗", about: "Send HTTP requests, saved as .http files", also: ["http", "rest", "api", "curl", "postman", "request"] }],

    about: (_ctx, path) => (path.startsWith("/http") ? "The HTTP client (requests and responses aren't shared)." : undefined),

    slots: () => ({
      "actions.what": ({ kind }) => (kind === "http.send" ? "Sent an HTTP request" : kind === "http.save" ? "Saved an HTTP request to a repo" : undefined),
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
        const s = start(ctx, r, w, p);
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
          body: sentPage({ sent: s, view: c.req.query("view") === "raw" ? "raw" : "pretty", req: s.req, where: w, envs: varsFor(ctx, w).envs, repos: listRepos(codeDir), secrets: secretsOf(ctx), history: history.list() }),
        });
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
