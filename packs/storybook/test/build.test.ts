/** Storybooks built here (#166): the build steps in order, one build per commit, the newest kept, and the server that serves them apart from Dovre. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBuilds, installer, KEEP, type Run, slugOf, tailOf } from "../build.ts";
import { buildHandler, buildOrigins, fileFor, frameFrom } from "../serve.ts";

const A = "a".repeat(40), B = "b".repeat(40);
const tool = (name: string) => ({ bin: name, pre: [], path: name });
const tools = { git: tool("git"), pnpm: tool("pnpm"), npm: tool("npm") };
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok(), "timed out");
};

/** A fake machine: git makes the worktree (with a pnpm lockfile), storybook build writes iframe.html; `fail` names a step that fails. */
function fakeRun(fail?: string) {
  const seen: string[] = [];
  const run: Run = async (t, all, cwd) => {
    // git always runs with long paths on (Windows); the rest is the command.
    if (t.bin === "git") assert.deepEqual(all.slice(0, 2), ["-c", "core.longpaths=true"]);
    const args = t.bin === "git" ? all.slice(2) : all;
    seen.push(`${t.bin} ${args.join(" ")}`);
    if (fail && args.includes(fail)) return { code: 1, out: `step 1\n\x1b[31mERR\x1b[0m <script>x</script>\n` };
    if (args[0] === "worktree" && args[1] === "add") {
      mkdirSync(join(args[4]!, ".git"), { recursive: true });
      writeFileSync(join(args[4]!, "pnpm-lock.yaml"), "");
    }
    if (args.includes("storybook")) {
      const out = args[args.indexOf("--output-dir") + 1]!;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "iframe.html"), "<p>story</p>");
    }
    void cwd;
    return { code: 0, out: "" };
  };
  return { run, seen };
}

test("a build: fetch, a worktree of its own, install from the lockfile, storybook build; once per commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  const { run, seen } = fakeRun();
  let changes = 0;
  const b = createBuilds({ dir, tools, checkout: () => "C:\\Code\\web", run, onChange: () => changes++ });
  assert.equal(b.state("ACME/web", A).status, "none");
  assert.equal(b.start("ACME/web", [A, "not-a-sha"]), true);
  assert.equal(b.start("ACME/web", [A]), false, "already queued");
  await until(() => b.state("ACME/web", A).status === "ready");
  assert.deepEqual(seen.map((s) => s.split(" ").slice(0, 2).join(" ")), ["git fetch", "git worktree", "git worktree", "pnpm install", "pnpm exec"]);
  assert.ok(seen.includes(`git fetch --no-tags --quiet origin ${A}`));
  assert.ok(seen.some((s) => s.startsWith("pnpm install --frozen-lockfile")));
  assert.ok(existsSync(join(b.outDir, "acme__web", A, "iframe.html")));
  assert.ok(changes >= 4, "the page hears each step");
  assert.equal(b.start("ACME/web", [A]), false, "built already");
  // The next commit reuses the worktree.
  seen.length = 0;
  b.start("ACME/web", [B]);
  await until(() => b.state("ACME/web", B).status === "ready");
  assert.ok(seen.some((s) => s.startsWith(`git checkout --detach --force --quiet ${B}`)));
  assert.equal(b.url("http://127.0.0.1:4849", "ACME/web", B), `http://127.0.0.1:4849/acme__web/${B}/`);
});

test("a failed build says which step, with the output's last lines (no colour codes); nothing half-built is served", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  const b = createBuilds({ dir, tools, checkout: () => "C:\\Code\\web", run: fakeRun("storybook").run, onChange: () => {} });
  b.start("ACME/web", [A]);
  await until(() => b.state("ACME/web", A).status === "failed");
  const s = b.state("ACME/web", A);
  assert.ok(s.status === "failed" && /storybook build failed/.test(s.why) && s.tail.includes("ERR <script>") && !s.tail.includes("\x1b"));
  assert.ok(!existsSync(join(b.outDir, "acme__web", A)) && !existsSync(join(b.outDir, "acme__web", `${A}.tmp`)));
  const none = createBuilds({ dir, tools, checkout: () => undefined, run: fakeRun().run, onChange: () => {} });
  none.start("ACME/api", [A]);
  await until(() => none.state("ACME/api", A).status === "failed");
  assert.match((none.state("ACME/api", A) as { why: string }).why, /no checkout/);
});

test("the newest builds are kept, older ones go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  const b = createBuilds({ dir, tools, checkout: () => "C:\\Code\\web", run: fakeRun().run, onChange: () => {} });
  const out = join(b.outDir, "acme__web");
  mkdirSync(out, { recursive: true });
  for (let i = 0; i < KEEP + 2; i++) {
    const sha = String(i).repeat(40);
    mkdirSync(join(out, sha));
    utimesSync(join(out, sha), new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
  }
  b.start("ACME/web", [A]);
  await until(() => b.state("ACME/web", A).status === "ready");
  const left = readdirSync(out);
  assert.equal(left.length, KEEP);
  assert.ok(left.includes(A) && !left.includes("0".repeat(40)));
});

test("install from the lockfile there is; none, or its tool missing, says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  assert.match((installer(dir, tools) as { why: string }).why, /No pnpm-lock/);
  writeFileSync(join(dir, "package-lock.json"), "");
  assert.deepEqual((installer(dir, tools) as { install: string[] }).install, ["ci"]);
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  assert.match((installer(dir, { npm: tools.npm }) as { why: string }).why, /pnpm isn't/);
  assert.equal(slugOf("ACME/Web.ui"), "acme__web.ui");
  assert.equal(tailOf("a\nb\nc", 2), "b\nc");
});

test("frames come from the other of localhost and 127.0.0.1 than Dovre's page", () => {
  assert.equal(frameFrom("127.0.0.1:4848", 4849), "http://localhost:4849");
  assert.equal(frameFrom("localhost:4848", 4849), "http://127.0.0.1:4849");
  assert.equal(frameFrom(undefined, 4849), "http://127.0.0.1:4849");
  assert.deepEqual(buildOrigins(4849), ["http://localhost:4849", "http://127.0.0.1:4849"]);
});

test("the build server: a finished build's files only, read only, on its own hosts", async () => {
  const root = mkdtempSync(join(tmpdir(), "sbo-"));
  mkdirSync(join(root, "acme__web", A, "sb-manager"), { recursive: true });
  writeFileSync(join(root, "acme__web", A, "index.html"), "<p>sb</p>");
  writeFileSync(join(root, "acme__web", A, "sb-manager", "x.js"), "1");
  mkdirSync(join(root, "acme__web", `${A}.tmp`));
  writeFileSync(join(root, "acme__web", `${A}.tmp`, "index.html"), "half");
  writeFileSync(join(root, "secret.txt"), "no");
  assert.ok(fileFor(root, `/acme__web/${A}/`)?.endsWith("index.html"));
  for (const bad of [`/acme__web/${A}/../../secret.txt`, `/acme__web/${A}/%2e%2e/%2e%2e/secret.txt`, `/acme__web/${A}.tmp/index.html`, "/secret.txt", `/acme__web/${A}/..%5c..%5csecret.txt`, "/%E0%A4%A"]) assert.equal(fileFor(root, bad), undefined, bad);

  let handler: ReturnType<typeof buildHandler> = () => {};
  const server = createServer((q, r) => handler(q, r));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  handler = buildHandler(root, port);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/acme__web/${A}/sb-manager/x.js`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /javascript/);
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(`http://127.0.0.1:${port}/acme__web/${A}/`, { method: "POST" })).status, 405);
    const rebound = await new Promise<number>((res, rej) => request({ host: "127.0.0.1", port, path: `/acme__web/${A}/`, headers: { host: `evil.example:${port}` } }, (r) => (r.resume(), res(r.statusCode ?? 0))).on("error", rej).end());
    assert.equal(rebound, 404, "DNS rebinding: another host name is refused");
    assert.equal((await fetch(`http://127.0.0.1:${port}/secret.txt`)).status, 404);
  } finally {
    server.close();
  }
});
