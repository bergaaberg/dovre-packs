/**
 * HTTP client (`http`): importing. Pasted curl, an OpenAPI spec (openapi.ts) or a Postman / Bruno
 * collection (collections.ts) is only read: nothing is fetched or sent. A request opens in the Quick
 * view (POST /http/open, also from otel-sink's trace page); saving a spec's requests adds them to a
 * new file or the end of one (`http.save`, one click: nothing that was there changes).
 */
import type { Hono } from "hono";
import type { AppEnv, PackContext } from "dovre/pack.ts";
import { fromCollection, varLines } from "./collections.ts";
import { readFile, reposOf, rootOf, writeFile } from "./files.ts";
import { blankReq, fromCurl, masker, parseHttp, placeholdSecrets, reqOfForm, secretIn, serializeReq } from "./model.ts";
import { fileNameOf, fromOpenApi, MAX_SPEC } from "./openapi.ts";
import { type Draw, type Sending, str } from "./sending.ts";
import { fileOk, homeHref, noWhere, openapiPage } from "./view.ts";

/** Pasted text as requests: a Postman or Bruno collection, else an OpenAPI spec. */
const importText = (text: string) => fromCollection(text) ?? fromOpenApi(text);

export function mountImport(app: Hono<AppEnv>, ctx: PackContext, d: { sending: Sending; draw: Draw }) {
  const { sending, draw } = d;

  app.get("/http/import", (c) => draw(ctx, c, blankReq(), noWhere(), { curl: "", spec: "" }));

  app.post("/http/import", async (c) => {
    const f = await c.req.parseBody();
    const text = str(f.curl, 256_000);
    const got = fromCurl(text);
    if (!got.ok) return draw(ctx, c, blankReq(), noWhere(), { flash: { tone: "warn", text: got.error }, curl: masker(sending.secretsOf(ctx))(text) }, 400);
    const r = placeholdSecrets(got.req, sending.secretsOf(ctx));
    return draw(ctx, c, r, noWhere(), { flash: { tone: "neutral", text: got.notes.length ? `Imported. ${got.notes.join(" ")}` : "Imported: nothing was sent." } });
  });

  // A request from an imported spec, a trace or the response page, into the Quick view: nothing is sent.
  app.post("/http/open", async (c) => {
    const f = await c.req.parseBody();
    const r = placeholdSecrets(reqOfForm(f), sending.secretsOf(ctx));
    const text = f.from === "trace" ? `Opened from a trace: nothing was sent. A trace keeps no headers or body${r.url.includes("{{") ? ", and the {{…}} parts need values (an environment's baseUrl, the path's ids)" : ""}.` : "Opened: nothing was sent.";
    return draw(ctx, c, r, noWhere(), { flash: { tone: "neutral", text } });
  });

  app.post("/http/openapi", async (c) => {
    const f = await c.req.parseBody();
    const spec = str(f.spec, MAX_SPEC);
    const got = importText(spec);
    if (!got.ok) return draw(ctx, c, blankReq(), noWhere(), { flash: { tone: "warn", text: got.error }, spec }, 400);
    return ctx.page(c, { title: got.title, current: "/http", body: openapiPage({ got, spec, repos: reposOf(ctx), repo: str(f.repo, 100), file: fileNameOf(got.title) }) });
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
      const res = await ctx.page(c, { title: got.title, current: "/http", body: openapiPage({ got, spec, repos: reposOf(ctx), repo, file, problem }) });
      return new Response(res.body, { status: 400, headers: res.headers });
    };
    const root = rootOf(ctx, repo);
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
    const leak = secretIn(text, sending.secretsOf(ctx));
    if (leak) return fail(`That has ${leak.name}'s value in it: nothing was saved.`);
    const target = `${repo}/.http/${file}`;
    const done = writeFile(root, file, text, current ? current.hash : "");
    await ctx.logged({ kind: "save", target, detail: `${current ? "added" : "created"} · ${got.reqs.length} from ${got.from.replace(/^an? /, "")} (${got.title})`.slice(0, 200), ok: done.ok, error: done.ok ? undefined : done.error });
    if (!done.ok) return fail(`${done.error} Nothing was saved.`);
    const n = current ? parseHttp(current.text).reqs.length : 0;
    return c.redirect(homeHref({ repo, file, n: String(n), saved: "1" }), 303);
  });
}
