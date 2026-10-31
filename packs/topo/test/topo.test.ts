/**
 * The topo pack (PLAN D18, WP-G6, WP-H9b): peak.yaml scanning (range.yaml, the old name, is ignored), its page, and what
 * it puts in core pages through slots (PR cards, New work, /agents/new) and Bino's lines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopoPack, TopoScanner, type TopoEntry } from "../index.ts";
import { topoPage, foldNames, binoLines, draftPrompt, fixPrompt } from "../view.ts";
import { prBody, prCard, type PrSlots } from "dovre/pages/inline.ts";
import { entryPage, type Ctx } from "dovre/pages/work.ts";
import { contextOf } from "dovre/packs/core/assistant/bino/context.ts";
import type { Slots } from "dovre/packs/types.ts";
import type { Pr } from "dovre/sources/ghe.ts";
import { HOSTILE as H, assertInert, packApp, testContext } from "dovre/packs/testing.ts";

/** A code folder with these peak.yaml files (folder → text). */
function codeDir(manifests: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dovre-topo-"));
  for (const [name, yaml] of Object.entries(manifests)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "peak.yaml"), yaml);
  }
  return dir;
}

const QUILL = `name: Quill
description: Newsletter platform for writers
url: https://quill.example
tier: active
docs:
  plan: docs/PLAN.md
  arch: ARCHITECTURE.md
components:
  - name: web
    owns: [apps/web]
  - name: db
    owns: [packages/db]
    rules: .claude/rules/db.md
`;

/** The pack's slots, as core's fill would call them. */
const slotsOf = (dir: string): Slots => createTopoPack().slots!(testContext({ codeDir: dir }));
const prSlots = (sl: Slots): PrSlots => ({ lead: (p) => [sl["pr.lead"]!(p)], facts: (p) => sl["pr.facts"]!(p) });

function fakePr(repo: string, number = 101): Pr {
  return {
    repo,
    number,
    title: "Add Toolkit support",
    branch: "feat/toolkit",
    headSha: "abcdef123456",
    author: "andreasberg",
    url: `https://github.com/${repo}/pull/${number}`,
    draft: false,
    openThreads: 0,
    checks: "SUCCESS",
    review: "APPROVED",
    updatedAt: "2026-10-23T20:00:00Z",
    additions: 120,
    deletions: 15,
    files: [
      { path: "src/topo/range.ts", additions: 100, deletions: 10 },
      { path: "README.md", additions: 20, deletions: 5 },
    ],
    reviews: [{ state: "APPROVED", login: "reviewer" }],
    requested: [],
    labels: ["enhancement"],
    runs: [{ name: "build", state: "ok", url: "https://ci.example.com/build" }],
    body: "Implements range.yaml support.",
  };
}

test("TopoScanner: peak.yaml is read and range.yaml (the old name) is not; broken files are listed with every problem", () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-topo-peak-"));
  try {
    for (const [repo, file, text] of [
      ["both", "peak.yaml", "name: New\n"],
      ["both", "range.yaml", "name: Old\n"],
      ["old", "range.yaml", "name: Old\ntier: maintained\n"],
      ["broken", "peak.yaml", "tier: active\nurl: nope\n"],
      ["notyaml", "peak.yaml", "name: [x\n"],
    ] as const) {
      mkdirSync(join(dir, repo), { recursive: true });
      writeFileSync(join(dir, repo, file), text);
    }
    const scanner = new TopoScanner(dir);
    assert.deepEqual(scanner.list().map((e) => [e.repo, e.peak.name, e.file]), [["both", "New", "peak.yaml"]]);
    assert.equal(scanner.get("old"), undefined, "range.yaml is no longer read (#138)");
    const problems = scanner.problems();
    assert.deepEqual(problems.map((p) => [p.repo, p.file]), [["broken", "peak.yaml"], ["notyaml", "peak.yaml"]]);
    assert.equal(problems[0]!.problems.length, 2, "every problem, not just the first");
    assert.match(problems[1]!.problems[0]!, /Not valid YAML/);
    assert.equal(scanner.get("broken"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TopoScanner: scans directory and resolves checkouts with peak.yaml / peak.yml", () => {
  const testDir = join(tmpdir(), `dovre-topo-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  try {
    // Repo 1: Quill (has peak.yaml)
    const quillDir = join(testDir, "quill");
    mkdirSync(quillDir, { recursive: true });
    writeFileSync(
      join(quillDir, "peak.yaml"),
      `name: Quill
description: Newsletter platform
tier: active
docs:
  plan: docs/PLAN.md
health:
  workers: [quill-web]
`,
    );

    // Repo 2: Harbor (has peak.yml)
    const harborDir = join(testDir, "harbor");
    mkdirSync(harborDir, { recursive: true });
    writeFileSync(
      join(harborDir, "peak.yml"),
      `name: Harbor
tier: active
url: https://creaharbor.com
docs:
  plan: docs/PLAN.md
`,
    );

    // Repo 3: plain repo (no peak.yaml)
    const plainDir = join(testDir, "plain-repo");
    mkdirSync(plainDir, { recursive: true });

    const scanner = new TopoScanner(testDir);
    assert.deepEqual(scanner.list().map((e) => e.repo).sort(), ["harbor", "quill"]);

    const quill = scanner.get("bergaaberg/quill");
    assert.ok(quill);
    assert.equal(quill.name, "Quill");
    assert.equal(quill.tier, "active");

    const list = scanner.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].repo, "harbor"); // sorted by name
    assert.equal(list[1].repo, "quill");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("TopoScanner: a folder with capitals keeps its name in links; lookups ignore case", () => {
  const testDir = join(tmpdir(), `dovre-topo-case-${Date.now()}`);
  mkdirSync(join(testDir, "Arena"), { recursive: true });
  try {
    writeFileSync(join(testDir, "Arena", "peak.yaml"), "name: Arena\ntier: active\n");
    const scanner = new TopoScanner(testDir);
    const [entry] = scanner.list();
    assert.equal(entry!.repo, "Arena", "/code/Arena and /agents/new need the folder's own name");
    assert.equal(entry!.dir, join(testDir, "Arena"));
    assert.equal(scanner.get("bergaaberg/arena")?.name, "Arena");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("TopoScanner: an empty folder is cached too — no rescan inside the TTL, a reread after it", () => {
  const testDir = join(tmpdir(), `dovre-topo-ttl-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  try {
    let clock = 1_000_000;
    const scanner = new TopoScanner(testDir, { ttlMs: 30_000, now: () => clock });
    // A folder with no manifests: the (empty) scan is still cached — this used to rescan on
    // every call, synchronously, because the TTL only applied to a non-empty cache.
    assert.equal(scanner.list().length, 0);
    mkdirSync(join(testDir, "late"), { recursive: true });
    writeFileSync(join(testDir, "late", "peak.yaml"), "name: Late\ntier: active\n");
    assert.equal(scanner.list().length, 0, "inside the TTL the empty result stands");
    clock += 30_001;
    assert.equal(scanner.list().length, 1, "after the TTL the folder is read again");
    assert.equal(scanner.get("late")?.name, "Late");
    rmSync(join(testDir, "late"), { recursive: true, force: true });
    clock += 30_001;
    assert.equal(scanner.list().length, 0, "a manifest gone is gone after the TTL");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("PR slots: a cataloged repo's PR shows its tier, site and docs; others show nothing", () => {
  const sl = slotsOf(codeDir({ quill: QUILL }));
  const summary = () => undefined;
  const card = String(prCard(fakePr("bergaaberg/quill", 42), { org: "bergaaberg", summary, slots: prSlots(sl) }));
  assert.match(card, /tier: active/);
  assert.match(card, /Quill/);
  assert.match(card, /docs%2FPLAN\.md/);
  assert.match(card, /ARCHITECTURE\.md/);
  const body = String(prBody(fakePr("bergaaberg/quill", 42), { summary, slots: prSlots(sl) }));
  assert.match(body, /Topo/);
  const other = String(prBody(fakePr("bergaaberg/plain", 7), { summary, slots: prSlots(sl) }));
  assert.doesNotMatch(other, /Topo/);
});

test("work.new slot: New work lists the cataloged projects", () => {
  const sl = slotsOf(codeDir({ quill: QUILL, harbor: "name: Harbor\ndescription: Laid-back Roman city builder\ntier: active\ndocs:\n  design: docs/DESIGN.md\n" }));
  const ctx: Ctx = { sortingRepos: [], formRepos: [], frame: { operator: "andreasberg", nav: [] }, org: "bergaaberg", ghe: "github.com", extra: [sl["work.new"]!({})] };
  const out = String(entryPage(ctx));
  assert.match(out, /Projects/);
  assert.match(out, /Quill/);
  assert.match(out, /Harbor/);
  assert.match(out, /Start agent/);
  const empty = String(slotsOf(codeDir({}))["work.new"]!({}));
  assert.equal(empty, "");
});

test("agents.new slot: a checkout's components set the prompt", () => {
  const sl = slotsOf(codeDir({ quill: QUILL }));
  // What the slot puts under "Runs in" on /agents/new (the agents pack draws the page around it).
  const out = String(sl["agents.new"]!({ repo: "quill" }));
  assert.match(out, /Component/);
  assert.match(out, />web<\/a>/);
  assert.match(out, />db<\/a>/);
  assert.match(out, /Focus%20on%20component%20%22web%22/);
  assert.match(out, /\.claude%2Frules%2Fdb\.md/);
});

test("topoPage: a place per repo on the map, the picked one's card (components, docs, focus links), what's off the map", () => {
  const entries: TopoEntry[] = [
    {
      repo: "quill",
      dir: "/x/quill",
      file: "peak.yaml",
      peak: {
        version: 1,
        name: "Quill",
        description: "Newsletter platform for writers",
        url: "https://quill.example",
        tier: "active",
        components: [
          { name: "web", owns: ["apps/web/src"] },
          { name: "db", owns: ["packages/db/src"], rules: ".claude/rules/db.md" },
        ],
        docs: { plan: "docs/PLAN.md", rules: "CLAUDE.md" },
        health: { workers: ["quill-web"] },
        uses: [],
        environments: {},
      },
    },
    { repo: "harbor", dir: "/x/harbor", file: "peak.yaml", peak: { version: 1, name: "Harbor", description: "Laid-back Roman city builder", tier: "utility", components: [], docs: { design: "docs/DESIGN.md" }, uses: [], environments: {} } },
  ];
  const plain = { repo: "plain-repo", dir: "/x/plain-repo", kind: "uncataloged" as const, lines: [] };
  const out = String(topoPage({ entries, coverage: [plain] }));
  assert.match(out, /<svg class="topo-svg"/);
  assert.match(out, /<a class="topo-place on" href="\/topo\?at=quill"/, "the first place is picked");
  assert.match(out, /<a class="topo-place" href="\/topo\?at=harbor"/);
  assert.match(out, /<a class="topo-chip" href="\/topo\?at=plain-repo"/, "a repo without a file is off the map");
  for (const re of [/Quill/, /quill\.example/, /Focus%20on%20component/, /\.claude\/rules\/db\.md/, /docs%2FPLAN\.md/, /no peak\.yaml/, /OFF THE MAP/, /2 cataloged repos · 1 to look at/]) assert.match(out, re);
  assert.doesNotMatch(out, /Laid-back/, "only the picked place has a card");
  assert.doesNotMatch(out, /range\.yaml/);

  const harbor = String(topoPage({ entries, coverage: [plain], at: "HARBOR" }));
  assert.match(harbor, /Laid-back Roman city builder/);
  assert.match(harbor, /docs%2FDESIGN\.md/);
  assert.match(harbor, /<tr class="on"><th scope="row"><a href="\/topo\?at=harbor">harbor/, "the list marks it too");

  // #140: a repo without a file offers an agent session that drafts its peak.yaml.
  assert.match(String(topoPage({ entries, coverage: [plain], at: "plain-repo" })), /href="\/agents\/new\?repo=plain-repo&(amp;)?prompt=Write%20a%20peak\.yaml[^"]*peak%20check[^"]*"[^>]*>Write peak\.yaml<\/a>/);

  const broken = String(topoPage({ entries, coverage: [{ repo: "bad", dir: "/x/bad", kind: "problems", file: "peak.yaml", lines: ["name is required.", "url must be an http(s) URL."] }], at: "bad" }));
  assert.match(broken, /unreadable/);
  assert.match(broken, /name is required\. url must be an http\(s\) URL\./);
  assert.match(broken, /href="\/code\/bad\?path=peak\.yaml"/);
  assert.match(broken, /href="\/agents\/new\?repo=bad&(amp;)?prompt=peak\.yaml%20in%20this%20repo%20has%20problems/);

  const hostile = { entries: [{ ...entries[1]!, repo: H }], coverage: [{ repo: H, dir: "/x", kind: "problems" as const, file: "peak.yaml", lines: [H] }, { repo: H, full: `o/${H}`, web: `https://github.com/o/${H}`, blob: `https://github.com/o/${H}/blob/HEAD/`, kind: "warnings" as const, file: "peak.yaml", lines: [H] }, { repo: H, kind: "uncataloged" as const, lines: [] }] };
  for (const at of [undefined, H, H.toLowerCase()]) for (const style of ["lanes", "rings", "off"] as const) assertInert(`topo ${style} at ${at}`, String(topoPage({ ...hostile, at, map: { style } })));

  const list = String(topoPage({ entries, map: { style: "off" } }));
  assert.doesNotMatch(list, /topo-svg/, "off: no map");
  assert.match(list, /<table class="topo-table">[\s\S]*quill[\s\S]*harbor/);
  assert.match(String(topoPage({ entries, map: { style: "lanes", unknown: "<b>" } })), /<code>TOPO_MAP<\/code> is <code>&lt;b&gt;<\/code>, which isn(&#39;|')t a style/);
});

test("the topo pack: in the menu's Code group and in search; /topo served, /atlas redirects; off without a code folder", async () => {
  const pack = createTopoPack();
  const nav = pack.nav!(testContext());
  assert.deepEqual(nav.map((n) => [n.href, n.title, n.icon, n.group]), [["/topo", "Topo", "contours", "Code"]]);
  assert.ok(pack.pages!(testContext()).some((p) => p.href === "/topo"));
  assert.equal(pack.manifest.execution, "any", "hosted it reads the forge");

  const { get } = packApp([pack], { codeDir: codeDir({ quill: QUILL }) });
  const res = await get("/topo");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Topo/);
  assert.match(text, /Rescan/);
  assert.match(text, /Quill/);
  assert.match(text, /href="\/topo"/, "the menu links it");
  assert.equal((await get("/topo?refresh=1")).status, 200);
  const old = await get("/atlas?tier=active");
  assert.deepEqual([old.status, old.headers.get("location")], [301, "/topo?tier=active"], "Atlas's old links still land");

  const off = packApp([createTopoPack()], { codeDir: codeDir({ quill: QUILL }), env: { PACK_TOPO: "off" } });
  assert.equal((await off.get("/topo")).status, 404);
  assert.equal((await off.get("/atlas")).status, 404);
  await createTopoPack().init!(testContext({ hosted: true }));
});

test("a hostile manifest stays inert on /topo and in every slot", async () => {
  // Markup in every text field (the parser rejects non-http urls, so the url stays valid).
  const dir = codeDir({
    "shop-api": `name: ${JSON.stringify(H)}
description: ${JSON.stringify(H)}
url: https://example.com/app
tier: ${JSON.stringify(H)}
docs:
  ${JSON.stringify(H)}: README.md
components:
  - name: ${JSON.stringify(H)}
    owns: [${JSON.stringify(`src/${H}`)}]
    rules: ${JSON.stringify(H)}
`,
  });
  const scanner = new TopoScanner(dir);
  assert.equal(scanner.list().length, 1, "the hostile manifest parses");
  const { get } = packApp([createTopoPack({ scanner })], { codeDir: dir });
  const res = await get("/topo");
  assert.equal(res.status, 200);
  assertInert("/topo", await res.text());
  const sl = slotsOf(dir);
  assertInert("agents.new", String(sl["agents.new"]!({ repo: "shop-api" })));
  assertInert("pr.lead", String(sl["pr.lead"]!({ repo: "shop-api", number: 7, branch: "feat/x", title: "x", url: "https://ghe/shop-api/pull/7" })));
  assertInert("pr.facts", sl["pr.facts"]!({ repo: "shop-api", number: 7, branch: "feat/x", title: "x", url: "https://ghe/shop-api/pull/7" }).map(([k, v]) => `${k}${v}`).join(""));
  assertInert("work.new", String(sl["work.new"]!({})));
});

test("Bino: a line per cataloged repo with its components and docs, capped", () => {
  const dir = codeDir({ quill: QUILL });
  const text = createTopoPack().bino!(testContext({ codeDir: dir }));
  assert.match(text, /quill \[active\]: Newsletter platform for writers/);
  assert.match(text, /web \(apps\/web\)/);
  assert.match(text, /plan: docs\/PLAN\.md/);

  const many: TopoEntry[] = Array.from({ length: 40 }, (_, i) => ({ repo: `r${i}`, dir: "", file: "peak.yaml", peak: { version: 1, name: `R${i}`, tier: "active", description: "x".repeat(90), components: [], docs: {}, uses: [], environments: {} } }));
  const capped = binoLines(many);
  assert.ok(capped.length <= 1500, `capped at what a pack may say (${capped.length})`);
  assert.match(capped, /and \d+ more cataloged repositories/);

  assert.match(contextOf({ todos: [], apps: [{ name: "Topo", text }] }), /## Topo/);
});

test("the peak.yaml prompts: draft one from the repo, fix one with every problem and the check", () => {
  assert.match(draftPrompt(), /README.*AGENTS\.md \/ CLAUDE\.md.*`npx github:bergaaberg\/peak check`/s);
  const fix = fixPrompt({ file: "peak.yaml", problems: ["name is required.", "tier must be a word."] });
  assert.match(fix, /^peak\.yaml in this repo has problems .*name is required\. tier must be a word\. Fix them, then run `npx github:bergaaberg\/peak check`/);
  assert.doesNotMatch(fix, /rename/);
  assert.match(fixPrompt({ file: "peak.yml", problems: ['Unknown key "x" (ignored).'], warnings: true }), /^peak\.yml in this repo has warnings .* until it passes with no warnings\.$/);
});

test("topo: All repos folds unclaimed and off-the-map rows by kind and name prefix", () => {
  const orphan = (kind: "workers" | "databases" | "queues", name: string) => ({ kind, name });
  const orphans = [
    ...["a", "b", "c"].map((n) => orphan("databases", `skribb-cms-${n}`)),
    orphan("databases", "two-a"), orphan("databases", "two-b"), orphan("databases", "plain"),
    orphan("workers", "api-one"), orphan("workers", "api-two"),
    orphan("queues", "jobs"),
  ];
  const out = String(topoPage({ entries: [], coverage: [{ repo: "plain-repo", dir: "/x/plain-repo", kind: "uncataloged" as const, lines: [] }], drift: { configured: true, declares: true, drift: { missing: [], orphans } } }));
  assert.equal(out.match(/no file claims it/g)?.length, 6, "a row each for the 6 unfolded names, none for the 3 folded");
  assert.match(out, /<details class="topo-quiet"><summary>D1 databases: 6 unclaimed<\/summary>/, "closed group with a count");
  assert.match(out, /<summary>Workers: 2 unclaimed<\/summary>/);
  assert.match(out, /<summary>Queues: 1 unclaimed<\/summary>/);
  assert.match(out, /<summary><code>skribb-cms-\*<\/code> · 3 D1 databases<\/summary>/, "3 share a prefix: one row");
  assert.doesNotMatch(out, /two-\*|api-\*/, "2 sharing a prefix stay separate");
  for (const n of ["two-a", "two-b", "api-one", "api-two", "plain", "jobs"]) assert.match(out, new RegExp(`>${n}</a>`));
  assert.match(out, /<summary>Off the map: 1 off the map<\/summary>/, "off-the-map rows are their own group");
});

test("foldNames: a prefix folds only the names that land on it; stragglers stay single", () => {
  const shape = (names: string[]) => foldNames(names, (n) => n).map((r) => (r.prefix ? `${r.prefix}*${r.items.length}` : r.items[0]));
  const cms = Array.from({ length: 34 }, (_, i) => `skribb-cms-${i}`);
  assert.deepEqual(shape([...cms, "skribb-web", "skribb-api"]), ["skribb-cms-*34", "skribb-web", "skribb-api"]);
  assert.deepEqual(shape(["a-b-1", "a-b-2", "a-b-3", "a-c"]), ["a-b-*3", "a-c"]);
  assert.deepEqual(shape(["x-1", "x-2"]), ["x-1", "x-2"]);
  assert.deepEqual(shape(["x-1", "x-2", "x-3", "solo"]), ["x-*3", "solo"]);
});

test("topo: a folded row opens when the picked name is inside it", () => {
  const orphans = [...["a", "b", "c"].map((n) => ({ kind: "databases" as const, name: `cms-${n}` })), { kind: "workers" as const, name: "solo" }];
  const page = (at?: string) => String(topoPage({ entries: [], coverage: [], drift: { configured: true, declares: true, drift: { missing: [], orphans } }, at }));
  assert.match(page("cf:databases:cms-b"), /<details class="topo-quiet" open><summary><code>cms-\*<\/code>/);
  assert.match(page("cf:workers:solo"), /<details class="topo-quiet"><summary><code>cms-\*<\/code>/);
});

test("topo: folded and unfolded rows keep hostile names inert", () => {
  const names = ["<script>alert(1)</script>", "javascript:alert(1)"];
  const orphans = [
    ...names.flatMap((n) => [1, 2, 3].map((i) => ({ kind: "databases" as const, name: `${n}-${i}` }))),
    ...names.map((n) => ({ kind: "workers" as const, name: n })),
  ];
  const out = String(topoPage({ entries: [], coverage: [], drift: { configured: true, declares: true, drift: { missing: [], orphans } }, at: names[0] }));
  assert.match(out, /<code>[^<]*-\*<\/code> · 3 D1 databases/);
  assertInert("topo folded", out);
  assert.doesNotMatch(out, /<script>alert/, "the raw tag never lands");
  assert.doesNotMatch(out, /href="javascript:/, "no name becomes a link target");
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/a>/, "the unfolded worker row shows the name as text");
});
