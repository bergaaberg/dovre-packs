/**
 * HTTP client (`http`): the Quick view's routes (dovre-packs#65 H-02, H-03). All of /http is behind
 * strictOrigin (index.ts). Nothing is sent on a GET. A send, a resend, a case run and Run all are one
 * click each (sending is the point), each request logged as `http.send` as any send is; Run all also
 * logs `http.run`. Running re-checks each file against the hash it was shown with. Keep as case adds
 * a request to a file's end (`http.save`, one click: nothing there changes); changing a saved case
 * goes through /http/save and its Confirm (`http.replace`).
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { AppEnv, PackContext, Tone } from "dovre/pack.ts";
import { agentHref } from "./agent.ts";
import { type Case, type CaseResult, caseKey, MAX_RUN_ALL, type Results } from "./cases.ts";
import { buildCatalog, type Endpoint, endpointFor, endpointKey } from "./catalog.ts";
import type { Refs } from "./chain.ts";
import { runChecks } from "./checks.ts";
import { previous } from "./compare.ts";
import { FILE_RE, findSpec, listFiles, readFile, reposOf, rootOf, writeFile } from "./files.ts";
import { blankReq, MAX_NAME, masker, parseHttp, placeholdSecrets, type prepare, type Req, type Secret, secretIn, serializeReq, withReq } from "./model.ts";
import { specDoc } from "./openapi.ts";
import { askPrompt, blanksOf, fillBlanks, parseLine } from "./quick.ts";
import { type QuickOpts, quickHref, quickPage } from "./quick-view.ts";
import type { History, Sent } from "./send.ts";
import { fillValues } from "./story.ts";
import { noWhere, statusTone, type Where } from "./view.ts";

type Prepared = Extract<ReturnType<typeof prepare>, { ok: true }>;

export type QuickDeps = {
  history: History;
  results: Results;
  now: () => number;
  secretsOf(ctx: PackContext): Secret[];
  varsFor(ctx: PackContext, w: Where): { vars: Record<string, string>; envs: string[] };
  sentRefs(w: Where): Refs;
  targetOf(ctx: PackContext, r: Req, w: Where, refs?: Refs): { ok: boolean; text: string } | undefined;
  prepare(ctx: PackContext, r: Req, w: Where, refs?: Refs): ReturnType<typeof prepare>;
  start(ctx: PackContext, r: Req, w: Where, p: Prepared, by?: "agent"): { s: Sent; settled: Promise<void> };
};

/** What a Quick view shows: where it is, and what to show in the form or say on top. */
export type RenderOpts = {
  where: Where;
  ep?: string;
  q?: string;
  /** A request to show instead of the endpoint's (one that came back refused, or from the command line). */
  req?: Req;
  blanks?: Map<string, string>;
  /** A saved case to open: its file and index. */
  open?: { file: string; n: number };
  flash?: QuickOpts["flash"];
  line?: string;
  curlOut?: string;
  status?: number;
};

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const strip = <T extends Req>({ span: _span, ...r }: T & { span?: unknown }): Req => r;
/** A file name for an endpoint's cases: its group's. */
const groupFile = (group: string) => `${group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "api"}.http`;
const fileOk = (f: string) => FILE_RE.test(f) && !f.includes("..");
const MAX_LAST = 200;

export function createQuick(d: QuickDeps) {
  /** The blanks' values typed last, per repo and name: the form starts from them. In memory only. */
  const last = new Map<string, string>();
  const remember = (repo: string, values: Map<string, string>) => {
    for (const [k, v] of values) {
      if (!v) continue;
      last.delete(`${repo}\0${k}`);
      last.set(`${repo}\0${k}`, v);
    }
    while (last.size > MAX_LAST) last.delete(last.keys().next().value!);
  };

  /** A repo's catalog, its files and spec, and an endpoint's cases (each with its file's hash). */
  function load(ctx: PackContext, repo: string) {
    const root = repo ? rootOf(ctx, repo) : null;
    if (!root) return undefined;
    const files = listFiles(root);
    const spec = findSpec(root);
    const catalog = buildCatalog(spec?.text, files.filter((f) => !f.error));
    const casesOf = (ep: Endpoint): (Case & { hash: string })[] =>
      files.flatMap((f) => (f.error ? [] : f.reqs.flatMap((r, n) => (endpointFor(catalog.endpoints, r.method, r.url) === ep ? [{ file: f.name, n, req: strip(r), hash: f.hash ?? "" }] : []))));
    return { root, files, spec, catalog, casesOf };
  }

  async function render(ctx: PackContext, c: Context<AppEnv>, o: RenderOpts) {
    const w: Where = { ...o.where };
    const repos = reposOf(ctx);
    const got = load(ctx, w.repo);
    let flash = o.flash;
    if (w.repo && !got) flash ??= { tone: "warn", text: "That repo isn't a checkout in your code folder." };
    let ep = got?.catalog.endpoints.find((e) => endpointKey(e) === o.ep);
    let req = o.req;
    if (o.open && got) {
      try {
        const f = readFile(got.root, o.open.file);
        const found = parseHttp(f.text).reqs[o.open.n];
        if (!found) throw new Error(`${f.name} has no request #${o.open.n + 1}.`);
        req ??= strip(found);
        Object.assign(w, { file: f.name, opened: f.name, n: String(o.open.n), hash: f.hash });
        ep ??= endpointFor(got.catalog.endpoints, found.method, found.url);
      } catch (e) {
        flash = { tone: "warn", text: (e as Error).message };
      }
    }
    const doc = ep?.fromSpec && got?.spec ? specDoc(got.spec.text, ep.method, ep.path) : undefined;
    const cases = ep && got ? got.casesOf(ep) : [];
    req ??= doc?.req ?? cases[0]?.req ?? (ep ? { ...blankReq(), method: ep.method, url: `{{baseUrl}}${ep.path.replace(/\{([^{}]*)\}/g, "{{$1}}")}` } : blankReq());

    const secrets = d.secretsOf(ctx);
    const { vars, envs } = d.varsFor(ctx, w);
    const blanks = blanksOf(req, (n) => Object.hasOwn(vars, n) || secrets.some((s) => s.name === n)).map((b) => ({ ...b, value: o.blanks?.get(b.name) ?? last.get(`${w.repo}\0${b.name}`) ?? "" }));
    const filled = fillBlanks(req, new Map(blanks.map((b) => [b.name, b.value])));
    const target = filled.ok ? d.targetOf(ctx, filled.req, w) : { ok: false, text: filled.error };

    const list = d.history.list();
    const cards = list.filter((s) => (ep ? s.from.repo === w.repo && endpointFor([ep], s.req.method, s.req.url) : true)).slice(0, 10);
    // Each endpoint's newest outcome: a send's status, or a case's checks.
    const newest = new Map<string, { at: number; tone: Tone }>();
    const note = (e: Endpoint | undefined, at: number, tone: Tone) => {
      if (!e) return;
      const k = endpointKey(e);
      if ((newest.get(k)?.at ?? -1) < at) newest.set(k, { at, tone });
    };
    if (got) {
      for (const s of list) if (s.from.repo === w.repo && s.state !== "sending") note(endpointFor(got.catalog.endpoints, s.req.method, s.req.url), s.at, s.state === "failed" || !s.resp ? "bad" : statusTone(s.resp.status));
      for (const f of got.files)
        for (const [n, r] of f.reqs.entries()) {
          const res = d.results.get(caseKey(w.repo, { file: f.name, n, req: r }));
          if (res && res.state !== "running") note(endpointFor(got.catalog.endpoints, r.method, r.url), res.at + 1, res.state === "passed" ? "ok" : "bad");
        }
    }
    const opened = w.opened && w.n !== "" ? { file: w.opened, n: Number(w.n) } : undefined;
    const body = quickPage({
      repos,
      where: w,
      envs,
      q: o.q ?? "",
      catalog: got?.catalog,
      specName: got?.spec?.name,
      files: got?.files,
      dots: new Map([...newest].map(([k, v]) => [k, v.tone])),
      ep,
      doc,
      cases: cases.map((x) => {
        const result = d.results.get(caseKey(w.repo, x));
        return { c: x, hash: x.hash, result, open: !!opened && opened.file === x.file && opened.n === x.n, sent: result?.sentId ? d.history.get(result.sentId) : undefined };
      }),
      req: placeholdSecrets(req, secrets),
      blanks,
      target,
      secrets,
      cards,
      prevOf: (s) => previous(list, s),
      keepFile: cases[0]?.file ?? (ep ? groupFile(ep.group) : "api.http"),
      flash,
      line: o.line,
      curlOut: o.curlOut,
    });
    c.header("Cache-Control", "no-store");
    const res = await ctx.page(c, { title: "HTTP client", body, current: "/http", head: html`<meta name="u-topics" content="http">` });
    return o.status && o.status !== 200 ? new Response(res.body, { status: o.status, headers: res.headers }) : res;
  }

  /** Runs one case as it's saved: sent (one click, logged as any send), its answer held to its checks. */
  async function runCase(ctx: PackContext, repo: string, env: string, x: Case & { hash: string }): Promise<boolean> {
    const res: CaseResult = { at: d.now(), env, state: "running", checks: [] };
    d.results.set(caseKey(repo, x), res);
    const w: Where = { ...noWhere(), env, repo, file: x.file, opened: x.file, n: String(x.n), hash: x.hash };
    const fail = (error: string) => {
      Object.assign(res, { state: "failed", error });
      ctx.publish(["http"]);
      return false;
    };
    // A `${value}` comes from a story's earlier step: on its own, a case has none.
    const filled = fillValues(x.req, new Map());
    if (!filled.ok) return fail(`Not sent: ${filled.error}`);
    const p = d.prepare(ctx, filled.req, w);
    if (!p.ok) return fail(`Not sent: ${p.error}`);
    const { s, settled } = d.start(ctx, filled.req, w, p);
    res.sentId = s.id;
    await settled;
    if (s.state !== "done" || !s.resp) return fail(`Nothing came back: ${s.error ?? "it failed"}.`);
    res.status = s.resp.status;
    res.ms = s.resp.ms;
    res.checks = runChecks(x.req.expect, s.resp);
    res.state = res.checks.every((k) => k.ok) ? "passed" : "failed";
    ctx.publish(["http"]);
    return res.state === "passed";
  }

  /** The fields a Quick view form posts back: repo, env, endpoint. */
  const backOf = (f: Record<string, unknown>) => ({ repo: str(f.repo, 100), env: str(f.env, 64), ep: str(f.ep, 600) });
  const whereOfBack = (b: ReturnType<typeof backOf>): Where => ({ ...noWhere(), repo: b.repo, env: b.env });

  function mount(app: Hono<AppEnv>, ctx: PackContext) {
    app.get("/http", async (c) => {
      const q = c.req.query();
      const w: Where = { ...noWhere(), env: str(q.env, 64), repo: str(q.repo, 100) };
      const file = str(q.file, 85);
      const open = w.repo && file ? { file, n: /^\d{1,4}$/.test(q.n ?? "") ? Number(q.n) : 0 } : undefined;
      const flash = q.saved === "1" && open ? { tone: "ok" as const, text: html`Saved in <code>${w.repo}/.http/${file}</code>.` } : undefined;
      return render(ctx, c, { where: w, ep: str(q.ep, 600), q: str(q.q, 100), open, flash });
    });

    // The command line: shorthand or curl fills the form (or sends, with go=1); a sentence goes to an agent.
    app.post("/http/line", async (c) => {
      const f = await c.req.parseBody();
      const b = backOf(f);
      const w = whereOfBack(b);
      const secrets = d.secretsOf(ctx);
      const text = str(f.line, 256_000);
      const line = masker(secrets)(text);
      const got = parseLine(text);
      if (got.t === "error") return render(ctx, c, { where: w, ep: b.ep, line, flash: { tone: "warn", text: got.error }, status: 400 });
      if (got.t === "ask") return c.redirect(agentHref(w.repo, askPrompt(masker(secrets)(got.text), { repo: w.repo, env: w.env, endpoint: b.ep || undefined })), 303);
      const req = placeholdSecrets(got.req, secrets);
      const notes = got.notes.length ? ` ${got.notes.join(" ")}` : "";
      if (f.go !== "1") return render(ctx, c, { where: w, req, line, flash: { tone: "neutral", text: `Filled in from the line: nothing was sent.${notes}` } });
      const p = d.prepare(ctx, req, w, d.sentRefs(w));
      if (!p.ok) return render(ctx, c, { where: w, req, line, flash: { tone: "warn", text: p.error }, status: 400 });
      d.start(ctx, req, w, p);
      return c.redirect(quickHref({ repo: w.repo, env: w.env }), 303);
    });

    app.post("/http/resend", async (c) => {
      const f = await c.req.parseBody();
      const b = backOf(f);
      const s = d.history.get(str(f.id, 64));
      if (!s) return render(ctx, c, { where: whereOfBack(b), ep: b.ep, flash: { tone: "warn", text: "That send isn't in this session's history any more: nothing was sent." }, status: 400 });
      const w: Where = { ...noWhere(), env: s.from.env, repo: s.from.repo, file: s.from.file, opened: s.from.file, n: s.from.n, hash: s.from.hash };
      const p = d.prepare(ctx, s.req, w, d.sentRefs(w));
      if (!p.ok) return render(ctx, c, { where: whereOfBack(b), ep: b.ep, flash: { tone: "warn", text: p.error }, status: 400 });
      d.start(ctx, s.req, w, p);
      return c.redirect(quickHref(b), 303);
    });

    // A send as a case: added to the end of a file (one click: nothing there changes), with a check on the status it got.
    app.post("/http/keep", async (c) => {
      const f = await c.req.parseBody();
      const b = backOf(f);
      const w = whereOfBack(b);
      const refuse = (text: string) => render(ctx, c, { where: w, ep: b.ep, flash: { tone: "warn", text }, status: 400 });
      const s = d.history.get(str(f.id, 64));
      if (!s) return refuse("That send isn't in this session's history any more: nothing was saved.");
      const root = rootOf(ctx, w.repo);
      if (!root) return refuse("Pick a repo (a checkout directly in your code folder) to keep it in.");
      const file = str(f.file, 85).trim();
      if (!fileOk(file)) return refuse("The file is a plain name ending in .http (orders.http).");
      const name = str(f.name, MAX_NAME).replace(/[\r\n]+/g, " ").trim();
      const req: Req = { ...s.req, name, ...(!s.req.expect?.length && s.resp ? { expect: [`status ${s.resp.status}`] } : {}) };
      const leak = secretIn(serializeReq(req), d.secretsOf(ctx));
      if (leak) return refuse(`That request has ${leak.name}'s value in it: nothing was saved.`);
      let current: { text: string; hash: string } | undefined;
      try {
        current = readFile(root, file);
      } catch (e) {
        const m = (e as Error).message;
        if (!m.endsWith("isn't there.")) return refuse(m);
      }
      const text = current ? withReq(current.text, req) : serializeReq(req);
      if (text === null) return refuse("That file can't take it: nothing was saved.");
      const done = writeFile(root, file, text, current ? current.hash : "");
      await ctx.logged({ kind: "save", target: `${w.repo}/.http/${file}`, detail: `kept as a case · ${req.method} ${name || "(unnamed)"}`.slice(0, 200), ok: done.ok, error: done.ok ? undefined : done.error });
      if (!done.ok) return refuse(`${done.error} Nothing was saved.`);
      const n = parseHttp(text).reqs.length - 1;
      return c.redirect(quickHref({ ...b, file, n: String(Math.max(0, n)), saved: "1" }), 303);
    });

    app.post("/http/case/run", async (c) => {
      const f = await c.req.parseBody();
      const b = backOf(f);
      const w = whereOfBack(b);
      const refuse = (text: string, status = 400) => render(ctx, c, { where: w, ep: b.ep, flash: { tone: "warn", text }, status });
      const got = load(ctx, w.repo);
      if (!got) return refuse("That repo isn't a checkout in your code folder.");
      const file = str(f.file, 85);
      const n = /^\d{1,4}$/.test(str(f.n)) ? Number(f.n) : -1;
      const fi = got.files.find((x) => x.name === file && !x.error);
      const found = fi?.reqs[n];
      if (!fi || !found) return refuse(`${file || "That file"} has no such case: nothing was sent.`);
      if (fi.hash !== str(f.hash, 64)) return refuse(`${file} changed since it was shown: nothing was sent. This is what's in it now.`, 409);
      void runCase(ctx, w.repo, w.env, { file, n, req: strip(found), hash: fi.hash }).catch((e) => ctx.log(`http: a case run stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
      return c.redirect(quickHref({ ...b, ep: b.ep || endpointKey(endpointFor(got.catalog.endpoints, found.method, found.url) ?? { method: found.method, path: "" }) }), 303);
    });

    // Every case of an endpoint, one after the other, each file as it was shown.
    app.post("/http/cases/run", async (c) => {
      const f = await c.req.parseBody();
      const b = backOf(f);
      const w = whereOfBack(b);
      const refuse = (text: string, status = 400) => render(ctx, c, { where: w, ep: b.ep, flash: { tone: "warn", text }, status });
      const got = load(ctx, w.repo);
      if (!got) return refuse("That repo isn't a checkout in your code folder.");
      const ep = got.catalog.endpoints.find((e) => endpointKey(e) === b.ep);
      if (!ep) return refuse("That endpoint isn't in the repo's catalog: nothing was sent.");
      const shown = new Map(
        str(f.hashes, 20_000)
          .split("\n")
          .map((l) => l.trim().split(/:(?=[0-9a-f]+$)/) as [string, string]),
      );
      const cases = got.casesOf(ep);
      if (!cases.length) return refuse("It has no cases to run.");
      const changed = [...new Set(cases.filter((x) => shown.get(x.file) !== x.hash).map((x) => x.file))];
      if (changed.length) return refuse(`${changed.join(", ")} changed since ${changed.length === 1 ? "it was" : "they were"} shown: nothing was sent. This is what's there now.`, 409);
      const todo = cases.slice(0, MAX_RUN_ALL);
      for (const x of todo) d.results.set(caseKey(w.repo, x), { at: d.now(), env: w.env, state: "running", checks: [] });
      void (async () => {
        let ok = 0;
        for (const x of todo) if (await runCase(ctx, w.repo, w.env, x)) ok++;
        await ctx.logged({ kind: "run", target: `${w.repo} ${endpointKey(ep)}`.slice(0, 300), detail: `${ok} of ${todo.length} cases passed${w.env ? ` · ${w.env}` : ""}`, ok: ok === todo.length, error: ok === todo.length ? undefined : `${todo.length - ok} failed` });
      })()
        .catch((e) => ctx.log(`http: a case run stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
        .finally(() => ctx.publish(["http"]));
      return c.redirect(quickHref(b), 303);
    });
  }

  return { render, mount, remember, load };
}
