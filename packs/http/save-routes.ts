/**
 * HTTP client (`http`): POST /http/save writes a request (a case) to `.http/<file>` in a checkout
 * directly under CODE_DIR, logged as `http.save`. A new file or a request added to the end is one
 * click (nothing that was there changes); replacing a request is a Confirm (`http.replace`), and
 * both re-check the file first: one that changed since it was opened isn't written.
 */
import type { Hono } from "hono";
import { logAction } from "dovre/actions/deploys.ts";
import type { AppEnv } from "dovre/env.ts";
import type { PackContext } from "dovre/packs/types.ts";
import { codeDirOf, readFile, repoRoot, writeFile } from "./files.ts";
import { parseHttp, reqOfForm, secretIn, serializeReq, withReq } from "./model.ts";
import { blanksOfForm, fillBlanks } from "./quick.ts";
import { type Draw, type Sending, str, whereOf } from "./sending.ts";
import { confirmSavePage, fileOk, homeHref } from "./view.ts";

export function mountSave(app: Hono<AppEnv>, ctx: PackContext, d: { sending: Sending; draw: Draw }) {
  const { sending, draw } = d;

  app.post("/http/save", async (c) => {
    const f = await c.req.parseBody();
    const typed = reqOfForm(f);
    const w = whereOf(f);
    // The Quick view's blanks are saved as typed: a case is the request with its values in.
    const blanks = blanksOfForm(f);
    const filled = fillBlanks(typed, blanks);
    const r = filled.ok ? filled.req : typed;
    const refuse = (text: string) => draw(ctx, c, r, w, { flash: { tone: "warn", text }, ep: str(f.ep, 600) }, 400);
    if (!filled.ok) return refuse(filled.error.replace("nothing was sent", "nothing was saved"));
    const root = repoRoot(codeDirOf(ctx.env), w.repo);
    if (!root) return refuse("Pick a repo (a checkout directly in your code folder) to save in.");
    if (!fileOk(w.file)) return refuse("The file is a plain name ending in .http (api.http).");
    if (!r.url) return refuse("A request needs a URL to be saved.");
    const leak = secretIn(serializeReq(r), sending.secretsOf(ctx));
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
}
