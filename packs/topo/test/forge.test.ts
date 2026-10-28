/**
 * Topo off the forge (dovre-packs#68 step 1): each followed repo's peak.yaml read through
 * `ctx.forge()`, merged with the checkouts (a checkout's own file wins), its coverage findings, and
 * /topo hosted, where there are no checkouts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopoPack, ForgeCatalog, TopoCatalog, TopoScanner } from "../index.ts";
import { forgeUrls } from "../forge.ts";
import { topoPage } from "../view.ts";
import type { Coverage, TopoEntry } from "../index.ts";
import type { PackForge } from "dovre/packs/types.ts";
import { HOSTILE as H, assertInert, packApp, testContext } from "dovre/packs/testing.ts";

/** A forge whose repos have these files (`owner/name` → path → text). */
function fakeForge(files: Record<string, Record<string, string>>, o: { id?: string; fail?: string[]; calls?: string[] } = {}): PackForge {
  return {
    id: o.id ?? "github",
    name: "GitHub",
    host: "github.com",
    login: "me",
    owners: "acme",
    repos: async () => Object.keys(files),
    file: async (repo, path) => {
      o.calls?.push(`${repo}:${path}`);
      if (o.fail?.includes(repo)) throw new Error("GitHub 502");
      return files[repo]?.[path];
    },
  };
}

function codeDir(files: Record<string, Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "dovre-topo-forge-"));
  for (const [name, fs] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".git"), { recursive: true });
    for (const [f, text] of Object.entries(fs)) writeFileSync(join(dir, name, f), text);
  }
  return dir;
}

test("ForgeCatalog: peak.yaml, else peak.yml; files with problems, warnings, none, and repos it couldn't read", async () => {
  const calls: string[] = [];
  const f = fakeForge(
    {
      "acme/quill": { "peak.yaml": "name: Quill\ntier: active\ndocs:\n  plan: docs/PLAN.md\n" },
      "acme/harbor": { "peak.yml": "name: Harbor\ntier: active\nshiny: yes\n" },
      "acme/broken": { "peak.yaml": "tier: active\n" },
      "acme/plain": {},
      "acme/flaky": { "peak.yaml": "name: Flaky\n" },
    },
    { fail: ["acme/flaky"], calls },
  );
  const fc = new ForgeCatalog({ forge: () => f });
  assert.equal(fc.can(), true);
  const r = (await fc.load())!;
  assert.deepEqual(r.entries.map((e) => [e.full, e.peak.name, e.file]).sort(), [["acme/harbor", "Harbor", "peak.yml"], ["acme/quill", "Quill", "peak.yaml"]]);
  const quill = r.entries.find((e) => e.repo === "quill")!;
  assert.deepEqual([quill.web, quill.blob, quill.dir], ["https://github.com/acme/quill", "https://github.com/acme/quill/blob/HEAD/", undefined]);
  assert.match(r.entries.find((e) => e.repo === "harbor")!.warnings!.join(" "), /Unknown key "shiny"/);
  assert.deepEqual(r.problems.map((p) => [p.full, p.problems.length > 0]), [["acme/broken", true]]);
  assert.deepEqual(r.bare.map((b) => b.full), ["acme/plain"]);
  assert.deepEqual(r.failed, ["acme/flaky"], "a read that failed isn't a repo without a file");
  assert.ok(!calls.includes("acme/quill:peak.yml"), "peak.yml is only asked for when there's no peak.yaml");

  calls.length = 0;
  assert.equal(await fc.load(), r, "kept inside its TTL");
  assert.equal(calls.length, 0);
  assert.notEqual(await fc.load(true), r, "a forced load reads again");
});

test("ForgeCatalog: one load at a time; a failed repo list keeps the last read and says why; no file reads, no catalog", async () => {
  let n = 0;
  let fail = false;
  const f: PackForge = { ...fakeForge({ "acme/quill": { "peak.yaml": "name: Quill\ntier: active\n" } }), repos: async () => (n++, fail ? Promise.reject(new Error("401 Bad credentials")) : ["acme/quill"]) };
  const fc = new ForgeCatalog({ forge: () => f });
  const [a, b] = await Promise.all([fc.load(), fc.load()]);
  assert.equal(a, b);
  assert.equal(n, 1);
  fail = true;
  const r = (await fc.load(true))!;
  assert.match(r.error!, /Couldn't list the repos on GitHub: 401 Bad credentials/);
  assert.deepEqual(r.entries.map((e) => e.repo), ["quill"], "what it knew stays");

  const none = new ForgeCatalog({ forge: () => ({ ...f, file: undefined }) });
  assert.equal(none.can(), false);
  assert.equal(await none.load(), undefined);
  assert.equal(await new ForgeCatalog({ forge: () => undefined }).load(), undefined, "before the first gather");
});

test("forgeUrls: GitHub and GitLab file pages; an api. host is the site's", () => {
  assert.equal(forgeUrls({ id: "github", host: "api.github.com" }, "a/b").blob, "https://github.com/a/b/blob/HEAD/");
  assert.equal(forgeUrls({ id: "gitlab", host: "gitlab.com" }, "a/b").blob, "https://gitlab.com/a/b/-/blob/HEAD/");
});

test("TopoCatalog: a checkout's file wins; the forge fills in the rest; coverage lists problems, warnings, then repos without a file", async () => {
  const dir = codeDir({
    quill: { "peak.yaml": "name: Quill (local)\ntier: active\n" },
    harbor: {},
    scratch: {},
  });
  const forge = new ForgeCatalog({
    forge: () =>
      fakeForge({
        "acme/quill": { "peak.yaml": "name: Quill (pushed)\ntier: active\n" },
        "acme/harbor": { "peak.yaml": "name: Harbor\ntier: active\nshiny: yes\n" },
        "acme/far": { "peak.yaml": "name: Far\ntier: maintained\n" },
        "acme/broken": { "peak.yaml": "name: [x\n" },
        "acme/plain": {},
        "acme/scratch": {},
      }),
  });
  await forge.load();
  const cat = new TopoCatalog({ scanner: new TopoScanner(dir), forge, checkouts: () => ["harbor", "quill", "scratch"] });

  const byRepo = Object.fromEntries(cat.list().map((e) => [e.repo, e]));
  assert.deepEqual(Object.keys(byRepo).sort(), ["far", "harbor", "quill"]);
  assert.equal(byRepo.quill!.peak.name, "Quill (local)", "the checkout's file wins");
  assert.equal(byRepo.quill!.full, "acme/quill", "and it knows its forge name");
  assert.equal(byRepo.harbor!.peak.name, "Harbor", "a checkout without a file: the forge's");
  assert.equal(byRepo.harbor!.dir, join(dir, "harbor"), "pointed at the checkout, so /code and agents work");
  assert.equal(byRepo.far!.dir, undefined, "not checked out");
  assert.equal(byRepo.far!.web, "https://github.com/acme/far");

  assert.equal(cat.get("acme/far")?.name, "Far");
  assert.equal(cat.get("ACME/Quill")?.name, "Quill (local)");
  assert.equal(cat.get("other/quill")?.name, "Quill (local)", "a name alone still finds it");
  assert.equal(cat.get("plain"), undefined);

  assert.deepEqual(
    cat.coverage().map((f) => [f.kind, f.repo]),
    [
      ["problems", "broken"],
      ["warnings", "harbor"],
      ["uncataloged", "plain"],
      ["uncataloged", "scratch"],
    ],
  );
  const scratch = cat.coverage().find((f) => f.repo === "scratch")!;
  assert.deepEqual([scratch.dir, scratch.full], [join(dir, "scratch"), "acme/scratch"], "one finding for a repo that's both");
});

test("/topo hosted: the forge's files, linked on the forge; coverage; agents start on the Mac; a hostile file stays inert", async () => {
  const pack = createTopoPack();
  const { get } = packApp([pack], {
    hosted: true,
    forge: {
      id: "github",
      name: "GitHub",
      can: [],
      host: "github.com",
      repos: async () => ["ACME/quill", "ACME/plain", "ACME/evil"],
      file: async (repo, path) =>
        (({
          "ACME/quill:peak.yaml": "name: Quill\ntier: active\ndocs:\n  plan: docs/PLAN.md\nshiny: 1\n",
          "ACME/evil:peak.yaml": `name: ${JSON.stringify(H)}\ndescription: ${JSON.stringify(H)}\ntier: ${JSON.stringify(H)}\ndocs:\n  ${JSON.stringify(H)}: ${JSON.stringify(`${H}.md`)}\n${JSON.stringify(H)}: 1\n`,
        }) as Record<string, string>)[`${repo}:${path}`],
    },
  });
  const res = await get("/topo?at=acme/quill");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Quill/);
  assert.match(text, /href="https:\/\/github\.com\/ACME\/quill\/blob\/HEAD\/docs\/PLAN\.md"/, "docs open on the forge");
  assert.match(text, /href="https:\/\/github\.com\/ACME\/quill"[^>]*>Repo ↗/);
  assert.doesNotMatch(text, /href="\/code\//, "there's no code viewer hosted");
  assert.match(text, /topo-sev warn">warnings<\/span>/);
  assert.match(text, /Unknown key &quot;shiny&quot;/);
  assert.match(text, /href="\/topo\?at=acme%2Fplain"/, "a repo without a file is off the map");
  assert.match(text, /ACME\/plain/);
  assertInert("/topo hosted", text);
  for (const at of ["acme/evil", "acme/plain"]) assertInert(`/topo hosted at ${at}`, await (await get(`/topo?at=${encodeURIComponent(at)}`)).text());

  const facts = pack.slots!(testContext({ hosted: true }))["pr.facts"]!({ repo: "ACME/quill", number: 1, branch: "x", title: "x", url: "https://github.com/ACME/quill/pull/1" });
  assert.match(String(facts.map(([, v]) => v).join("")), /blob\/HEAD\/docs\/PLAN\.md/, "a PR's docs link to the forge too");
});

test("topoPage: agents start where there's a checkout, or hosted (on the Mac); not locally for a repo only on the forge", () => {
  const far: TopoEntry = { repo: "far", full: "acme/far", ...forgeUrls({ id: "github", host: "github.com" }, "acme/far"), file: "peak.yaml", peak: { version: 1, name: "Far", tier: "active", components: [{ name: "web", owns: ["web"] }], docs: {}, uses: [], environments: {} } };
  const plain: Coverage = { repo: "plain", full: "acme/plain", web: "https://github.com/acme/plain", kind: "uncataloged", lines: [] };
  const local = String(topoPage({ entries: [far], coverage: [plain] })) + String(topoPage({ entries: [far], coverage: [plain], at: "acme/plain" }));
  assert.doesNotMatch(local, /\/agents\/new\?repo=(far|plain)/);
  assert.match(local, /href="https:\/\/github\.com\/acme\/plain"[^>]*>Repo ↗/);
  const hosted = String(topoPage({ entries: [far], coverage: [plain], hosted: true }));
  assert.match(hosted, /href="\/agents\/new\?repo=far"/);
  assert.match(hosted, /Focus agent/);
  assert.match(String(topoPage({ entries: [far], coverage: [plain], hosted: true, at: "acme/plain" })), /href="\/agents\/new\?repo=plain&amp;prompt=Write/);
});

test("topoPage: says when there's nothing to read, and what the forge couldn't read", () => {
  assert.match(String(topoPage({ entries: [], reads: { checkouts: false, forge: false } })), /Nothing to read/);
  const out = String(topoPage({ entries: [], reads: { checkouts: false, forge: true }, unread: { error: "Couldn't list the repos on GitHub: 401", failed: ["acme/a", "acme/b"] } }));
  assert.doesNotMatch(out, /Nothing to read/);
  assert.match(out, /Couldn(&#39;|')t list the repos on GitHub: 401\. What(&#39;|')s shown is from the last read that worked\./);
  assert.match(out, /Couldn(&#39;|')t read 2 repos this time: acme\/a, acme\/b\./);
});
