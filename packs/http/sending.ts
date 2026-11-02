/**
 * HTTP client (`http`): what every view sends through. The variables for a request (repo and
 * instance environments, the file's own), the editor's `{{name.response…}}` from history, where a
 * request would go (worked out without sending), and `start`: one send in the background, in
 * history, logged as `http.send` (method, host and path, the status; never the query, headers or
 * body), the page told over the hub when the answer is here.
 */
import type { Context } from "hono";
import { logAction } from "dovre/actions/deploys.ts";
import type { AppEnv } from "dovre/env.ts";
import type { PackContext } from "dovre/packs/types.ts";
import type { Child, Tone } from "dovre/ui/kit.ts";
import type { Refs } from "./chain.ts";
import { readFile, repoEnvs, rootOf } from "./files.ts";
import { CREDENTIAL_HEADERS, envNames, masker, parseEnvs, parseHttp, parseSecrets, placeholdSecrets, prepare, type Req, varsOf } from "./model.ts";
import { failure, type History, type Sent, sendOnce } from "./send.ts";
import { fileOk, type Where } from "./view.ts";

export type Prepared = Extract<ReturnType<typeof prepare>, { ok: true }>;

export const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/** A posted form's Where: what it was opened from and where it saves. */
export function whereOf(f: Record<string, unknown>): Where {
  return { env: str(f.env, 64), repo: str(f.repo, 100), file: str(f.file, 85).trim(), opened: str(f.opened, 85), n: /^\d{1,4}$/.test(str(f.n)) ? str(f.n) : "", hash: /^[0-9a-f]{1,64}$/.test(str(f.hash)) ? str(f.hash) : "" };
}

export function createSending(o: { history: History; now: () => number; fetchFn?: typeof fetch; timeoutMs?: number }) {
  const { history, now } = o;

  const secretsOf = (ctx: PackContext) => parseSecrets(ctx.env.HTTP_SECRETS, ctx.env);

  /** The variables for a request: the repo's and this instance's environments, then the file's own. */
  function varsFor(ctx: PackContext, w: Where): { vars: Record<string, string>; envs: string[] } {
    const mine = parseEnvs(ctx.env.HTTP_ENVS);
    const root = w.repo ? rootOf(ctx, w.repo) : null;
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

  /** Responses for `{{name.response…}}` in the editor: the newest send of that name, from the same file if there's one. */
  function sentRefs(w: Where): Refs {
    return (name) => {
      const done = history.list().filter((s) => s.req.name === name && s.state === "done" && s.resp);
      return (done.find((s) => s.from.repo === w.repo && s.from.file === w.opened) ?? done[0])?.resp;
    };
  }

  const prep = (ctx: PackContext, r: Req, w: Where, refs?: Refs) => prepare(r, varsFor(ctx, w).vars, secretsOf(ctx), now(), refs);

  /** Where it would go, worked out without sending: the URL masked, or why it won't go. */
  function targetOf(ctx: PackContext, r: Req, w: Where, refs: Refs = sentRefs(w)): { ok: boolean; text: string } | undefined {
    if (!r.url) return undefined;
    const p = prep(ctx, r, w, refs);
    // A value that comes back during a run is shown as written, not URL-encoded.
    return p.ok ? { ok: true, text: masker(secretsOf(ctx))(p.url).replace(/%7B%7B(.*?)%7D%7D/gi, "{{$1}}") } : { ok: false, text: p.error };
  }

  /** Sends in the background; the page it redirects to fills in when the answer is here. */
  function start(ctx: PackContext, r: Req, w: Where, p: Prepared, by?: "agent"): { s: Sent; settled: Promise<void> } {
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
    const settled = sendOnce(p, { fetchFn: o.fetchFn ?? fetch, mask, now, timeoutMs: o.timeoutMs })
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

  return { history, now, secretsOf, varsFor, sentRefs, targetOf, prepare: prep, start };
}

export type Sending = ReturnType<typeof createSending>;

/** What a page drawn for a request that came back can say or hold. */
export type DrawExtra = { flash?: { tone: Tone; text: Child }; curl?: string; spec?: string; curlOut?: string; blanks?: Map<string, string>; ep?: string };
/** A page for a request that came back (refused, imported, opened): the Quick view, or the import page for pasted text. */
export type Draw = (ctx: PackContext, c: Context<AppEnv>, r: Req, w: Where, extra?: DrawExtra, status?: number) => Promise<Response>;
