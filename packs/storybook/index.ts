/**
 * Storybook Pack (`storybook`, dovre#160, #166; out of core with pack API 1.21): a PR's stories before and after, side by side. Local
 * only, and off unless STORYBOOK names a repo; then only on that repo's PRs: a "Stories" fact on the
 * PR, and its page at /storybook/<owner>/<repo>/<n>.
 *
 * Each side is either a Storybook CI publishes (a URL template in STORYBOOK) or one built here
 * (build.ts) when CI publishes none: "Build here" on the page builds the PR's commit (and the base's,
 * when the base isn't published either) in the repo's checkout, and serve.ts serves it apart from
 * Dovre.
 *
 * A published Storybook may sit behind a sign-in, so the server never fetches it: the stories come
 * from the PR's files (model.ts), and my browser draws them in frames with its own session. Its
 * frames are allowed on its own pages only (`frames`), for the origins STORYBOOK names and the build
 * server's.
 */
import { dirname, join, resolve } from "node:path";
import { html } from "hono/html";
import { logAction } from "dovre/actions/deploys.ts";
import { owns } from "dovre/owners.ts";
import { Empty, type Html, Notice, type Pack, type PackContext, type PackForge, PageHeader, Panel, safeUrl } from "dovre/pack.ts";
import { strictOrigin } from "dovre/strict.ts";
import { findTool } from "dovre/tools.ts";
import { later, Reading } from "dovre/pages/later.ts";
import { type Builds, type BuildState, createBuilds } from "./build.ts";
import { type Book, bookOf, booksOf, frameUrl, openUrl, originOf, parseStories, STORIES, storyId, touched, urlOf, type Changed } from "./model.ts";
import { buildOrigins, buildServer, frameFrom } from "./serve.ts";

/** Building here (build.ts) and serving the builds on `port` (serve.ts); without it, only published Storybooks. */
export type BuildHere = { builds: Builds; port: number; ensure(): void };

export type StorybookDeps = {
  /** How it builds here, from its context; default: in Dovre's data folder, served on STORYBOOK_PORT (Dovre's port + 1). */
  build?: (ctx: PackContext) => BuildHere | undefined;
};

const STYLES = `.sb-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; }
.sb-pair h3 { margin: 0 0 6px; font-size: var(--fs-s); }
.sb-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.sb-side { margin: 0; min-width: 0; }
.sb-side figcaption { display: flex; gap: 8px; align-items: baseline; font-size: var(--fs-s); color: var(--ink-2); margin-bottom: 4px; }
.sb-frame { display: block; width: 100%; height: 360px; border: 1px solid var(--line); border-radius: var(--r); background: #fff; }
.sb-gone { display: grid; place-items: center; height: 120px; border: 1px dashed var(--line); border-radius: var(--r); }
@media (max-width: 720px) { .sb-sides { grid-template-columns: 1fr; } }`;

/** The port the builds are served on: STORYBOOK_PORT, else the one after Dovre's. */
export const portOf = (env: Record<string, string | undefined>) => Number(env.STORYBOOK_PORT) || (Number(env.PORT) || 4848) + 1;

/** Builds here: in Dovre's data folder, in the repo's checkout under CODE_DIR (the one named like the repo). */
export function buildHere(ctx: PackContext): BuildHere | undefined {
  if (ctx.hosted || !ctx.checkouts || !ctx.checkout) return undefined;
  const port = portOf(ctx.env);
  const builds = createBuilds({
    dir: join(dirname(resolve(ctx.env.U_DB || "data/dovre.sqlite")), "storybook"),
    tools: { git: findTool("git"), pnpm: findTool("pnpm"), npm: findTool("npm") },
    checkout: (repo) => {
      const name = repo.split("/")[1]!.toLowerCase();
      const found = ctx.checkouts!().find((c) => c.toLowerCase() === name);
      return found ? (ctx.checkout!(found) ?? undefined) : undefined;
    },
    onChange: () => ctx.publish(["storybook"]),
    log: (l) => ctx.log(l),
  });
  const server = buildServer(builds.outDir, port, (l) => ctx.log(l));
  return { builds, port, ensure: () => server.ensure() };
}

/** At most this many stories files are read, folders listed, and stories drawn in frames (the rest are links). */
export const MAX_FILES = 20;
export const MAX_DIRS = 15;
export const MAX_FRAMES = 24;

type Story = { id: string; name: string };
type StoryFile = { path: string; title: string; status: "added" | "removed" | "changed" | "nearby"; stories: Story[] };
export type Found = { ok: true; head: string; base: string; files: StoryFile[]; more: number } | { ok: false; why: string };
type FoundAt = Found & { sha?: string; baseSha?: string; branch?: string };

/** One side's Storybook: where it's served, or how its build here is going. */
export type Root = string | { build: BuildState };

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Text of a file at a ref, or undefined (missing, too big, not a file). */
async function textAt(forge: PackForge, repo: string, path: string, sha: string): Promise<string | undefined> {
  const got = await forge.file!(repo, path, sha).catch(() => undefined);
  return got !== undefined && got.length <= 300_000 ? got : undefined;
}

/** The stories files in a folder at a ref. */
async function storiesIn(forge: PackForge, repo: string, dir: string, sha: string): Promise<string[]> {
  const got = await forge.dir!(repo, dir, sha).catch(() => []);
  return got.filter((p) => STORIES.test(p));
}

/** Which stories a PR touches, read from its files at its head (a removed file: at its base). */
export async function findStories(forge: PackForge, repo: string, n: number): Promise<FoundAt> {
  if (!forge.pr || !forge.dir || !forge.file) return { ok: false, why: `${forge.name} doesn't give packs a PR's files.` };
  const pr = await forge.pr(repo, n);
  if (!pr) return { ok: false, why: `${repo}#${n} isn't a pull request (or isn't visible).` };
  const head = pr.head.ref, sha = pr.head.sha, base = pr.base.ref, baseSha = pr.base.sha;
  const files: Changed[] = pr.files;
  const { stories, dirs } = touched(files);
  const seen = new Set(stories.map((s) => s.path));
  const nearby: Changed[] = [];
  // Folders are listed at once; their stories keep the folders' order.
  const listed = await Promise.all(dirs.slice(0, MAX_DIRS).map((dir) => storiesIn(forge, repo, dir, sha)));
  for (const paths of listed)
    for (const path of paths)
      if (!seen.has(path)) {
        seen.add(path);
        nearby.push({ path, status: "nearby" });
      }
  const all = [...stories, ...nearby];
  const read = await Promise.all(
    all.slice(0, MAX_FILES).map(async (f): Promise<StoryFile | undefined> => {
      const removed = f.status === "removed";
      const src = await textAt(forge, repo, f.path, removed ? baseSha : sha);
      if (src === undefined) return undefined;
      const { title, exports } = parseStories(f.path, src);
      const status = removed ? "removed" : f.status === "added" ? "added" : f.status === "nearby" ? "nearby" : "changed";
      return { path: f.path, title, status, stories: exports.map((e) => ({ id: storyId(title, e), name: e })) };
    }),
  );
  return { ok: true, head, base, sha, baseSha, branch: head, files: read.filter((x): x is StoryFile => !!x && x.stories.length > 0), more: Math.max(0, all.length - MAX_FILES) };
}

const STATUS: Record<StoryFile["status"], string> = { added: "new in this PR", removed: "removed in this PR", changed: "changed", nearby: "beside a changed file" };

/** A side built here that isn't ready yet: what to say in its frame's place. */
const notYet = (r: Root): string | false => (typeof r === "string" || r.build.status === "ready" ? false : r.build.status === "building" || r.build.status === "queued" ? "Building here…" : r.build.status === "failed" ? "The build here failed" : "Not built yet");

/** The build panel: what's being built here, and Build here when something isn't. */
function buildPanel(o: { action: string; roots: { head: Root; base: Root }; canBuild: boolean }): Html | "" {
  const sides = (["head", "base"] as const).flatMap((k) => (typeof o.roots[k] === "string" ? [] : [{ k, label: k === "head" ? "This PR" : "The base branch", s: (o.roots[k] as { build: BuildState }).build }]));
  if (!sides.length || sides.every((x) => x.s.status === "ready")) return "";
  const busy = sides.some((x) => x.s.status === "building" || x.s.status === "queued");
  const line = (x: (typeof sides)[number]) =>
    html`<li><strong>${x.label}</strong>: ${
      x.s.status === "building" ? html`${x.s.step}…` : x.s.status === "queued" ? "waiting for the build before it" : x.s.status === "ready" ? "built" : x.s.status === "failed" ? html`failed: ${x.s.why}${x.s.tail ? html`<pre class="output">${x.s.tail}</pre>` : ""}` : "not built yet"
    }</li>`;
  return Panel({
    title: "Built here",
    meta: "CI publishes no Storybook for this side, so Dovre builds it in your checkout",
    children: html`<div data-live id="storybook-build"${busy ? html` data-pending aria-busy="true"` : ""}><ul class="sb-list">${sides.map(line)}</ul>${
      busy
        ? html`<p class="t2"><span class="spinner" aria-hidden="true"></span> Installing and building takes a few minutes; this page fills itself in.</p>`
        : o.canBuild
          ? html`<form method="post" action="${o.action}"><button type="submit" class="primary" data-busy="Starting">${sides.some((x) => x.s.status === "failed") ? "Build again" : "Build here"}</button> <span class="t3">Installs the PR's packages and runs its build on this machine, as checking it out would.</span></form>`
          : html`<p class="t2">Dovre can't build here.</p>`
    }</div>`,
  });
}

/** The page's body: each stories file, each story before (base) and after (the PR) in frames. */
export function storiesBody(o: { repo: string; n: number; prUrl: string; found: Found | "reading"; roots?: { head: Root; base: Root }; buildAction?: string; /** The PR list answers here (the prs pack is on; default yes). */ prs?: boolean }): Html {
  const header = PageHeader({
    title: html`Stories in ${o.repo}#${o.n}`,
    sub: "Before (the base branch's Storybook) and after (this PR's), side by side",
    crumbs: [...(o.prs === false ? [] : [{ href: "/prs", label: "PRs" }]), { href: safeUrl(o.prUrl), label: `${o.repo}#${o.n}` }],
  });
  if (o.found === "reading") return html`${header}${Reading({ text: "Reading the PR's stories…" })}`;
  if (!o.found.ok) return html`${header}${Notice({ tone: "bad", children: o.found.why })}`;
  const { files, more } = o.found;
  const roots = o.roots!;
  if (!files.length) return html`${header}${Empty({ title: "No stories here", children: html`<p>This PR changes no stories file, and none sits beside the files it changes.</p>` })}`;
  const href = (r: Root, f: (root: string) => string) => (typeof r === "string" ? safeUrl(f(r)) : "");
  let left = MAX_FRAMES;
  const side = (label: string, root: Root, story: Story, gone: string | false) => {
    const why = gone || notYet(root);
    return html`<figure class="sb-side"><figcaption><span>${label}</span>${why || typeof root !== "string" ? "" : html` <a href="${href(root, (r) => openUrl(r, story.id))}" target="_blank" rel="noopener noreferrer">open</a>`}</figcaption>${
      why || typeof root !== "string" ? html`<div class="sb-gone t2">${why}</div>` : html`<iframe class="sb-frame" src="${href(root, (r) => frameUrl(r, story.id))}" title="${label}: ${story.name}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>`
    }</figure>`;
  };
  const link = (r: Root, s: Story, text: string) => (typeof r === "string" ? html`<a href="${href(r, (x) => openUrl(x, s.id))}" target="_blank" rel="noopener noreferrer">${text}</a>` : text);
  const pair = (f: StoryFile, s: Story) => {
    if (left <= 0) return html`<li>${link(roots.base, s, s.name)} before · ${link(roots.head, s, "after")}</li>`;
    left--;
    return html`<li class="sb-pair"><h3>${s.name}</h3><div class="sb-sides">${side("Before", roots.base, s, f.status === "added" && "Not in the base branch")}${side("After", roots.head, s, f.status === "removed" && "Removed in this PR")}</div></li>`;
  };
  const published = [roots.head, roots.base].find((r): r is string => typeof r === "string" && r.startsWith("https://"));
  return html`${header}
    ${buildPanel({ action: o.buildAction ?? "", roots, canBuild: !!o.buildAction })}
    ${published ? html`<p class="t2">A published Storybook is drawn by this browser with its sign-in: if a frame asks to sign in or stays blank, <a href="${safeUrl(published)}" target="_blank" rel="noopener noreferrer">open the Storybook</a> once, then come back.</p>` : ""}
    ${files.map((f) =>
      Panel({ title: f.title, meta: html`<code>${f.path}</code> · ${STATUS[f.status]}`, children: html`<ul class="sb-list">${f.stories.map((s) => pair(f, s))}</ul>` }),
    )}
    ${more ? html`<p class="t2">${more} more stories ${more === 1 ? "file" : "files"} not read.</p>` : ""}`;
}

export function createStorybookPack(d: StorybookDeps = {}): Pack {
  const loads = later({ max: 50 });
  let build: BuildHere | undefined;
  let built = false;
  /** Building here, made once from the first context that asks. */
  const buildOf = (ctx: PackContext) => {
    if (!built) {
      built = true;
      build = (d.build ?? buildHere)(ctx);
    }
    return build;
  };
  const books = (env: Record<string, string | undefined>) => booksOf(env.STORYBOOK);
  /** A repo this Dovre shows stories for: STORYBOOK names it and it's the owners'. */
  const bookFor = (ctx: PackContext, repo: string): Book | undefined => {
    const book = bookOf(books(ctx.env), repo);
    const forge = ctx.forge();
    return book && forge && owns(forge.owners, repo.split("/")[0]!) ? book : undefined;
  };
  /** The PR's stories, within the page's budget ("reading" past it); `wait`: the whole read. */
  const found = async (forge: PackForge, book: Book, n: number, o: { wait?: boolean } = {}): Promise<FoundAt | "reading"> => {
    const r = await loads(`${book.repo}#${n}`, () => findStories(forge, book.repo, n), { budgetMs: o.wait ? Infinity : undefined });
    if (!r) return "reading";
    return r.ok ? r.value : { ok: false, why: `The PR's files didn't load: ${r.error}` };
  };
  /** The commits to build here for a PR: the sides STORYBOOK doesn't publish. */
  const toBuild = (book: Book, f: FoundAt) => [!book.head ? f.sha : undefined, !book.base ? f.baseSha : undefined].filter((s): s is string => !!s);
  return {
    manifest: {
      api: "1.24",
      version: "1.0.2",
      id: "storybook",
      name: "Storybook",
      description: "A PR's stories before and after, published by CI or built here",
      domain: "general",
      markers: [".storybook/"],
      execution: "local-only",
      settings: [
        {
          key: "STORYBOOK",
          label: "Storybooks",
          required: true,
          help: "owner/repo, then the PR's Storybook URL and the base branch's, split by ; — e.g. acme/web https://acme.github.io/web/pr-{pr}/ https://acme.github.io/web/{base}/ ({pr}, {branch}, {base}, {sha}). Leave out the PR's URL (acme/web https://acme.github.io/web/) or both (acme/web) and Dovre builds those sides here.",
        },
        { key: "STORYBOOK_PORT", label: "Port for Storybooks built here", help: "Served apart from Dovre, on this machine only. Default: the one after Dovre's." },
      ],
    },
    styles: STYLES,
    frames: (ctx) => [...books(ctx.env).flatMap((b) => [b.head && originOf(b.head), b.base && originOf(b.base)].filter((o): o is string => !!o)), ...(buildOf(ctx) ? buildOrigins(buildOf(ctx)!.port) : [])],
    slots: (ctx) => ({
      "pr.facts": ({ repo, number }) => (bookOf(books(ctx.env), repo) ? [["Stories", html`<a href="/storybook/${enc(repo)}/${number}">before and after</a>`]] : []),
    }),
    routes: (app, ctx) => {
      app.get("/storybook/:owner/:repo/:n{[0-9]+}", async (c) => {
        const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
        const n = Number(c.req.param("n"));
        const book = bookFor(ctx, repo);
        const forge = ctx.forge();
        if (!book || !forge) return c.notFound();
        const b = buildOf(ctx);
        const got = await found(forge, book, n);
        let roots: { head: Root; base: Root } | undefined;
        if (got !== "reading" && got.ok) {
          const vars = { pr: n, branch: got.branch!, base: got.base, sha: got.sha! };
          const local = (sha: string | undefined): Root => {
            if (!b || !sha) return { build: { status: "failed", why: "Dovre can't build here.", tail: "", at: 0 } };
            const s = b.builds.state(book.repo, sha);
            if (s.status !== "ready") return { build: s };
            b.ensure();
            return b.builds.url(frameFrom(c.req.header("host"), b.port), book.repo, sha);
          };
          roots = { head: book.head ? urlOf(book.head, vars) : local(got.sha), base: book.base ? urlOf(book.base, vars) : local(got.baseSha) };
        }
        const prUrl = `https://${forge.host}/${book.repo}/pull/${n}`;
        const buildAction = b ? `/storybook/${enc(book.repo)}/${n}/build` : undefined;
        return ctx.page(c, { title: `Stories · ${book.repo}#${n}`, current: "/prs", body: storiesBody({ repo: book.repo, n, prUrl, found: got, roots, buildAction, prs: ctx.pageOn("/prs") }) });
      });
      // Runs the PR's own install and build on this machine: from Dovre's own pages only, and logged.
      app.post("/storybook/:owner/:repo/:n{[0-9]+}/build", strictOrigin, async (c) => {
        const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
        const n = Number(c.req.param("n"));
        const book = bookFor(ctx, repo);
        const forge = ctx.forge();
        const b = buildOf(ctx);
        if (!book || !b || !forge) return c.notFound();
        const page = `/storybook/${enc(book.repo)}/${n}`;
        const f = await found(forge, book, n, { wait: true });
        if (f === "reading" || !f.ok) return c.redirect(page, 303);
        const shas = toBuild(book, f);
        if (b.builds.start(book.repo, shas)) await logAction(ctx.db, { kind: "storybook.build", target: `${book.repo}#${n}`, detail: shas.map((s) => s.slice(0, 7)).join(" "), ok: true });
        return c.redirect(page, 303);
      });
    },
  };
}

export const storybookPack: Pack = createStorybookPack();
