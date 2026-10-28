/** Fix PRs (dovre-packs#68 step 5): the peak.yaml edits, the checks before a PR, and the page's Confirms. */
import test from "node:test";
import assert from "node:assert/strict";
import yaml from "yaml";
import { parsePeak } from "@bergaaberg/peak";
import type { PackProposal, Proposal } from "dovre/actions/propose.ts";
import type { PackForge } from "dovre/packs/types.ts";
import { HOSTILE as H, assertInert, packApp } from "dovre/packs/testing.ts";
import { createTopoPack, type TopoEntry } from "../index.ts";
import type { CloudInventory, CloudRead } from "../cloud.ts";
import { claimText, dropText, readmeLine, runFix, startText, wranglerRuns } from "../fix.ts";

const SKRIBB = `# What runs
name: Skribb
runs:
  workers: [skribb-web, skribb-cms-*] # tenants after
  databases:
    - skribb-db
environments:
  staging:
    runs:
      workers: [skribb-web-staging]
health:
  workers: [skribb-old]
`;

test("claimText: the name goes under runs in production, comments and layout kept", () => {
  assert.equal(claimText(SKRIBB, { kind: "workers", name: "skribb-api" }), SKRIBB.replace("skribb-cms-*]", "skribb-cms-*, skribb-api]"));
  assert.equal(claimText("name: X\n", { kind: "buckets", name: "x-files" }), "name: X\nruns:\n  buckets: [x-files]\n");
  assert.match(claimText(SKRIBB, { kind: "databases", name: "skribb-logs" }), /- skribb-db\n {4}- skribb-logs\n/);
  assert.throws(() => claimText(SKRIBB, { kind: "workers", name: "skribb-web" }), /lists skribb-web already/);
  assert.throws(() => claimText(SKRIBB, { kind: "workers", name: "x*" }), /Not a name/);
  assert.throws(() => claimText("name: X\nruns: 3\n", { kind: "workers", name: "x" }), /runs isn't a mapping/);
});

test("claimText: a Durable Object class goes on the entry naming its worker, not on a pattern", () => {
  assert.match(claimText(SKRIBB, { kind: "objects", name: "Room", worker: "skribb-web" }), /workers: \[\{name: skribb-web, objects: \[Room\]\}, skribb-cms-\*\]/);
  const mapped = "name: X\nruns:\n  workers:\n    - name: x-web\n      objects: [A]\n";
  assert.equal(claimText(mapped, { kind: "objects", name: "B", worker: "x-web" }), mapped.replace("[A]", "[A, B]"));
  assert.throws(() => claimText(SKRIBB, { kind: "objects", name: "Room", worker: "skribb-cms-acme" }), /doesn't name skribb-cms-acme itself/);
});

test("dropText: out of every list that declares it; lists and maps left empty go", () => {
  assert.equal(dropText(SKRIBB, { kind: "workers", name: "skribb-web-staging" }), SKRIBB.replace("environments:\n  staging:\n    runs:\n      workers: [skribb-web-staging]\n", ""));
  assert.equal(dropText(SKRIBB, { kind: "databases", name: "skribb-db" }), SKRIBB.replace("  databases:\n    - skribb-db\n", ""));
  assert.equal(dropText(SKRIBB, { kind: "workers", name: "skribb-old" }), SKRIBB.replace("health:\n  workers: [skribb-old]\n", ""));
  const mapped = "name: X\nruns:\n  workers:\n    - name: x-web\n      objects: [A, B]\n";
  assert.equal(dropText(mapped, { kind: "objects", name: "A", worker: "x-web" }), mapped.replace("[A, B]", "[B]"));
  assert.equal(dropText(mapped.replace("[A, B]", "[A]"), { kind: "objects", name: "A", worker: "x-web" }), "name: X\nruns:\n  workers:\n    - name: x-web\n");
  assert.throws(() => dropText(SKRIBB, { kind: "queues", name: "nope" }), /doesn't declare nope/);
  assert.throws(() => dropText("name: [", { kind: "queues", name: "nope" }), /doesn't parse/);
});

test("startText: a file the parser takes, the worker and its classes from wrangler config", () => {
  const toml = wranglerRuns("wrangler.toml", 'name = "memlet"\nmain = "src/index.ts"\n\n[[durable_objects.bindings]]\nname = "ROOM"\nclass_name = "Room"\n\n[[durable_objects.bindings]]\nname = "OTHER"\nclass_name = "Elsewhere"\nscript_name = "other"\n\n[env.staging]\nname = "memlet-staging"\n');
  assert.deepEqual(toml, { worker: "memlet", objects: ["Room"] });
  assert.deepEqual(wranglerRuns("wrangler.jsonc", '{\n  // the worker\n  "name": "y-web", /* x */ "url": "https://a//b",\n  "durable_objects": { "bindings": [{ "class_name": "A" }] },\n}'), { worker: "y-web", objects: ["A"] });
  assert.deepEqual(wranglerRuns("wrangler.json", "{ nope"), { objects: [] });
  const text = startText({ name: "Memlet", description: "Notes\nthat stick.", tier: "maintained", owner: "bergaaberg", wrangler: toml });
  assert.match(text, /^# yaml-language-server: \$schema=https:\/\//);
  const r = parsePeak(yaml.parse(text));
  assert.ok("peak" in r, JSON.stringify(r));
  assert.deepEqual([r.peak.name, r.peak.description, r.peak.tier, r.peak.owner, r.peak.runs?.workers], ["Memlet", "Notes that stick.", "maintained", "@bergaaberg", [{ name: "memlet", objects: ["Room"] }]]);
  assert.match(startText({ name: "Y", description: "", tier: "odd", owner: "", wrangler: { worker: "y", objects: [] } }), /tier: active\nruns:\n  workers: \[y\]\n$/);
  assert.throws(() => startText({ name: " ", description: "", tier: "", owner: "" }), /needs a name/);
  assert.throws(() => startText({ name: "Y", description: "", tier: "", owner: "a b" }), /handle/);
});

test("readmeLine: the first plain paragraph", () => {
  assert.equal(readmeLine("# Memlet\n\n[![ci](x)](y)\n\n<p>hi</p>\n\nNotes that **stick**, with [links](https://x).\nSecond line.\n\nMore."), "Notes that stick, with links. Second line.");
  assert.equal(readmeLine(undefined), "");
});

const entry = (repo: string, text: string): TopoEntry => {
  const r = parsePeak(yaml.parse(text));
  if (!("peak" in r)) throw new Error(r.problems.join(" "));
  return { repo, full: `ACME/${repo}`, file: "peak.yaml", peak: r.peak };
};

/** A forge with these files on the default branch; what it's asked to propose is recorded. */
function forgeOf(files: Record<string, string>, asked: PackProposal[] = [], o: { propose?: boolean } = {}): PackForge {
  return {
    id: "github",
    name: "GitHub",
    host: "github.com",
    login: "me",
    owners: "ACME",
    repos: async () => [...new Set(Object.keys(files).map((k) => k.split(":")[0]!))],
    file: async (repo, path) => files[`${repo}:${path}`],
    ...(o.propose === false ? {} : { propose: async (p: PackProposal) => (asked.push(p), { ok: true as const, number: 7, url: `https://github.com/${p.repo}/pull/7` }) }),
  };
}

test("runFix: checks the form against what Topo knows now, then proposes the edit of the default branch's file", async () => {
  const asked: PackProposal[] = [];
  const forge = forgeOf({ "ACME/skribb:peak.yaml": SKRIBB, "ACME/memlet:wrangler.toml": 'name = "memlet"\n', "ACME/memlet:README.md": "# M\n\nNotes that stick.\n" }, asked);
  const state = {
    entries: [entry("skribb", SKRIBB)],
    drift: { orphans: [{ kind: "workers" as const, name: "skribb-api" }], missing: [{ repo: "skribb", full: "ACME/skribb", file: "peak.yaml", kind: "databases" as const, name: "skribb-db", envs: ["production"] }] },
    bare: [{ repo: "memlet", full: "ACME/memlet" }],
  };
  assert.deepEqual(await runFix({ what: "claim", repo: "ACME/skribb", kind: "workers", name: "skribb-api" }, state, forge), { ok: true, text: "Opened #7.", url: "https://github.com/ACME/skribb/pull/7", key: "acme/skribb" });
  assert.deepEqual([asked[0]!.kind, asked[0]!.path, asked[0]!.expect, asked[0]!.title], ["peak-pr", "peak.yaml", SKRIBB, "peak.yaml: claim the worker skribb-api"]);
  assert.match(asked[0]!.text, /skribb-cms-\*, skribb-api\]/);

  await runFix({ what: "drop", repo: "ACME/skribb", kind: "databases", name: "skribb-db" }, state, forge);
  assert.doesNotMatch(asked[1]!.text, /skribb-db/);

  await runFix({ what: "start", repo: "ACME/memlet", name: "Memlet", description: "", tier: "scratch", owner: "@me" }, state, forge);
  assert.deepEqual([asked[2]!.path, asked[2]!.expect], ["peak.yaml", null]);
  assert.match(asked[2]!.text, /name: Memlet\ndescription: Notes that stick\.\ntier: scratch\nowner: "@me"\nruns:\n  workers: \[memlet\]/);

  // Not so now: nothing is proposed.
  for (const [form, why] of [
    [{ what: "claim", repo: "ACME/skribb", kind: "workers", name: "skribb-gone" }, /isn't unclaimed now/],
    [{ what: "drop", repo: "ACME/skribb", kind: "databases", name: "skribb-web" }, /isn't missing now/],
    [{ what: "start", repo: "ACME/skribb", name: "S" }, /isn't a followed repo without a peak\.yaml now/],
    [{ what: "claim", repo: "ACME/other", kind: "workers", name: "skribb-api" }, /has no peak\.yaml Topo can read/],
    [{ what: "claim", repo: "ACME/skribb", kind: "nonsense", name: "x" }, /Not a kind/],
    [{ what: "rm -rf", repo: "ACME/skribb", kind: "workers", name: "x" }, /Not a fix/],
  ] as const) {
    const r = await runFix(form, state, forge);
    assert.equal(r.ok, false);
    assert.match(r.text, why);
  }
  assert.equal(asked.length, 3);
  assert.match((await runFix({ what: "claim", repo: "ACME/skribb", kind: "workers", name: "skribb-api" }, state, forgeOf({}, [], { propose: false }))).text, /can't open PRs/);
  assert.match((await runFix({ what: "claim", repo: "ACME/skribb", kind: "workers", name: "skribb-api" }, state, forgeOf({}))).text, /no peak\.yaml on its default branch/);
});

/** The same files as core's forge for packApp: core checks the pack's proposals (kinds, owners) before this is asked. */
function appForge(files: Record<string, string>, asked: Proposal[] = [], o: { propose?: boolean } = {}) {
  return {
    id: "github",
    name: "GitHub",
    can: [] as const,
    host: "github.com",
    repos: async () => [...new Set(Object.keys(files).map((k) => k.split(":")[0]!))],
    file: async (repo: string, path: string) => files[`${repo}:${path}`],
    ...(o.propose === false ? {} : { propose: async (p: Proposal) => (asked.push(p), { number: 7, url: `https://github.com/${p.repo}/pull/7` }) }),
  };
}

const cloudOf = (have: CloudRead["have"]): CloudInventory => {
  const read: CloudRead = { at: 1, account: "acc", have, failed: [] };
  return { configured: () => true, peek: () => read, load: async () => read } as unknown as CloudInventory;
};

test("/topo: a Confirm of kind topo.peak-pr on the cards, a POST opens the PR, and the card says how it went", async () => {
  const asked: Proposal[] = [];
  const text = "name: Quill\nruns:\n  workers: [quill-web, quill-api]\n";
  const pack = createTopoPack({ cloud: cloudOf({ workers: ["quill-web", "quill-cron"] }) });
  assert.deepEqual(pack.writes, [{ kind: "peak-pr", label: "Open a PR fixing a repo's peak.yaml" }]);
  const { get, post, db } = packApp([pack], { hosted: true, forge: appForge({ "ACME/quill:peak.yaml": text, "ACME/bare:README.md": "x" }, asked) });
  const missing = await (await get("/topo?at=acme%2Fquill")).text();
  assert.match(missing, /<summary>PR: take it out…<\/summary>/);
  assert.match(missing, /name="what" value="drop">.*name="name" value="quill-api"/s);
  const orphan = await (await get("/topo?at=cf%3Aworkers%3Aquill-cron")).text();
  assert.match(orphan, /<summary>PR: claim it in quill…<\/summary>/);
  const bare = await (await get("/topo?at=acme%2Fbare")).text();
  assert.match(bare, /Or open a PR with a first one/);
  assert.match(bare, /name="owner" value="@[\w-]+"/);

  const r = await post("/topo/pr", { what: "claim", repo: "ACME/quill", kind: "workers", name: "quill-cron" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/topo?at=acme%2Fquill");
  assert.match(asked[0]!.text, /\[quill-web, quill-api, quill-cron\]/);
  const after = await (await get("/topo?at=acme%2Fquill")).text();
  assert.match(after, /Opened #7\. <a [^>]*href="https:\/\/github\.com\/ACME\/quill\/pull\/7"/);
  assert.doesNotMatch(await (await get("/topo?at=acme%2Fquill")).text(), /Opened #7/, "said once");
  assert.deepEqual(db.raw.prepare("SELECT kind, target, ok, detail FROM actions").all().map((l) => ({ ...l })), [{ kind: "topo.peak-pr", target: "ACME/quill:peak.yaml", ok: 1, detail: "#7" }]);

  assert.equal((await post("/topo/pr", { what: "claim" }, { origin: "https://evil.example" })).status, 403, "another site can't post it");
  assert.equal(asked.length, 1);
});

test("/topo: no PR buttons where the forge can't open them; hostile names stay inert", async () => {
  const plain = packApp([createTopoPack({ cloud: cloudOf({ workers: ["quill-web"] }) })], { hosted: true, forge: appForge({ "ACME/quill:peak.yaml": "name: Quill\nruns:\n  workers: [quill-web, quill-api]\n" }, [], { propose: false }) });
  assert.doesNotMatch(await (await plain.get("/topo?at=acme%2Fquill")).text(), /PR: take it out/);

  const hostile = `name: Quill\nruns:\n  workers: ['quill-${H.replace(/'/g, "''")}']\n`;
  const { get, post } = packApp([createTopoPack({ cloud: cloudOf({ workers: [`quill-${H}x`] }) })], { hosted: true, forge: appForge({ "ACME/quill:peak.yaml": hostile }) });
  const page = await (await get("/topo?at=acme%2Fquill")).text();
  assertInert("topo card", page);
  assert.match(page, /&lt;script&gt;x/, "the name is on the page, escaped");
  const r = await post("/topo/pr", { what: "drop", repo: "ACME/quill", kind: "workers", name: `quill-${H}` });
  assert.equal(r.status, 303);
  assertInert("topo card after a PR", await (await get("/topo?at=acme%2Fquill")).text());
});
