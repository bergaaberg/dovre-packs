/**
 * Topo's rules (dovre-packs#68 step 3): owner, component, scratch-runs-nothing and uses, each
 * switched off by TOPO_RULES_OFF; the Rules panel on /topo, Topo's Settings panel, and Bino's lines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parsePeak } from "@bergaaberg/peak";
import yaml from "yaml";
import { checkRules, createTopoPack, rulesOff } from "../index.ts";
import { ruleLines, topoPage } from "../view.ts";
import type { TopoEntry } from "../scan.ts";
import { HOSTILE as H, assertInert, packApp, testContext } from "dovre/packs/testing.ts";

const entry = (repo: string, text: string): TopoEntry => {
  const r = parsePeak(yaml.parse(text));
  if (!("peak" in r)) throw new Error(r.problems.join(" "));
  return { repo, full: `acme/${repo}`, web: `https://github.com/acme/${repo}`, blob: `https://github.com/acme/${repo}/blob/HEAD/`, file: "peak.yaml", peak: r.peak };
};
const rules = (fs: ReturnType<typeof checkRules>) => fs.map((f) => `${f.repo} ${f.rule}`);

test("rulesOff: ids by comma or space, any case; other words are named, not rules", () => {
  const { off, unknown } = rulesOff(" Owner, uses  nope,owner\nnope ");
  assert.deepEqual([...off], ["owner", "uses"]);
  assert.deepEqual(unknown, ["nope"]);
  assert.equal(rulesOff(undefined).off.size, 0);
});

test("owner: an active repo (the default tier) names an owner; other tiers needn't", () => {
  const fs = checkRules({
    entries: [entry("a", "name: A\n"), entry("b", "name: B\ntier: active\nowner: '@ola'\n"), entry("c", "name: C\ntier: maintained\n"), entry("d", "name: D\ntier: Active\n")],
  });
  assert.deepEqual(rules(fs), ["a owner", "d owner"]);
  assert.match(fs[0]!.fix, /owner: @user/);
});

test("component: with components, every runs entry in every environment names one", () => {
  const fs = checkRules({
    entries: [
      entry("app", "name: App\nowner: '@o'\ncomponents:\n  - { name: web, owns: [web] }\nruns:\n  workers:\n    - { name: app-web, component: web }\n    - app-cron\nenvironments:\n  staging:\n    runs:\n      databases: [app-db-staging]\n"),
      entry("plain", "name: Plain\nowner: '@o'\nruns:\n  workers: [plain]\n"),
    ],
  });
  assert.deepEqual(rules(fs), ["app component"]);
  assert.match(fs[0]!.why, /2 runs entries name no component: workers app-cron, databases app-db-staging\./);
  assert.match(fs[0]!.fix, /one of web/);
});

test("scratch-runs-nothing: production runs are flagged; an environment's aren't", () => {
  const fs = checkRules({
    entries: [
      entry("toy", "name: Toy\ntier: scratch\nruns:\n  workers: [toy]\n"),
      entry("lab", "name: Lab\ntier: scratch\nenvironments:\n  preview:\n    runs:\n      workers: [lab-preview]\n"),
    ],
  });
  assert.deepEqual(rules(fs), ["toy scratch-runs-nothing"]);
  assert.match(fs[0]!.why, /runs workers toy in production/);
});

test("uses: followed, has a file, not deprecated, what matches; other owners, services, unread and broken files aren't judged", () => {
  const api = entry("api", "name: API\nowner: '@o'\nruns:\n  workers: [api-web]\n  queues: ['jobs-*']\n");
  const old = entry("old", "name: Old\ntier: deprecated\n");
  const user = entry(
    "user",
    [
      "name: User",
      "owner: '@o'",
      "uses:",
      "  - acme/api", // fine
      "  - { repo: acme/api, what: api-web }", // fine: a name
      "  - { repo: acme/api, what: jobs-email }", // fine: a pattern claims it
      "  - { repo: acme/api, what: api-cron }", // no such entry
      "  - acme/old", // deprecated
      "  - acme/bare", // no peak.yaml
      "  - acme/gone", // not followed
      "  - acme/broken", // its file has problems: coverage says so
      "  - acme/flaky", // couldn't be read this time
      "  - cloudflare/workers-sdk", // another owner
      "  - stripe", // a service
      "  - acme/user", // itself
      "",
    ].join("\n"),
  );
  const input = {
    entries: [api, old, user],
    bare: [{ repo: "bare", full: "acme/bare" }],
    problems: [{ repo: "broken", full: "acme/broken", file: "peak.yaml", problems: ["name is required."] }],
    owners: ["ACME"],
    unread: ["acme/flaky"],
    followedKnown: true,
  };
  const fs = checkRules(input).filter((f) => f.repo === "user");
  assert.deepEqual(fs.map((f) => f.why), [
    "It uses api-cron from acme/api, which runs no such thing.",
    "It uses acme/old, which is deprecated.",
    "It uses acme/bare, which has no peak.yaml.",
    "It uses acme/gone, which isn't followed (archived, renamed or gone).",
  ]);
  assert.match(fs[0]!.fix, /api-web, jobs-\*/);
  assert.equal(checkRules({ ...input, followedKnown: false }).filter((f) => f.why.includes("gone")).length, 0, "without a full repo list, unfollowed isn't said");
  assert.equal(checkRules({ ...input, owners: [] }).filter((f) => f.rule === "uses").length, 0, "no owners known: nothing to judge");
  // A checkout the forge didn't name is found by its folder name.
  const local = { ...api, full: undefined, repo: "API" };
  assert.equal(checkRules({ ...input, entries: [local, old, user] }).filter((f) => f.why.includes("acme/api,") || f.why.includes("from acme/api")).length, 1);
});

test("TOPO_RULES_OFF: a rule that's off finds nothing", () => {
  const e = entry("toy", "name: Toy\ntier: scratch\ncomponents:\n  - { name: web, owns: [web] }\nruns:\n  workers: [toy]\n");
  assert.deepEqual(rules(checkRules({ entries: [e] })), ["toy component", "toy scratch-runs-nothing"]);
  assert.deepEqual(rules(checkRules({ entries: [e], off: rulesOff("component scratch-runs-nothing").off })), []);
});

test("topoPage: rule findings on their repo with why and fix, the used repo's path in warn; the setting's unknown words; hostile text stays inert", () => {
  const e = entry("toy", `name: Toy\ntier: scratch\nruns:\n  workers: [${JSON.stringify(H)}]\nuses:\n  - { repo: acme/api, what: ${JSON.stringify(H)} }\n`);
  const api = entry("api", "name: API\nowner: '@o'\n");
  const findings = checkRules({ entries: [e, api], owners: ["acme"] });
  assert.equal(findings.length, 2);
  assert.equal(findings.find((f) => f.rule === "uses")?.uses, "acme/api");
  const out = String(topoPage({ entries: [e, api], hosted: true, rules: { findings, off: new Set(["owner"]), unknown: [H] } }));
  assert.match(out, /<a class="topo-place on" href="\/topo\?at=acme%2Ftoy"/, "the place with findings is picked");
  assert.match(out, /<text class="topo-bt"[^>]*>2<\/text>/);
  assert.match(out, /2 to look at/);
  assert.match(out, /<span class="topo-sev warn">rule: scratch-runs-nothing<\/span> It&#39;s scratch/);
  assert.match(out, /<span class="topo-sev warn">rule: uses<\/span> It uses/);
  assert.match(out, /<path class="topo-tr warn" d="M[^"]+"/, "the path to the used repo is drawn in warn");
  assert.match(out, /<a class="topo-pchip warn" href="\/topo\?at=acme%2Fapi">api<\/a>/);
  assert.match(out, /names something that isn&#39;t a rule/);
  assert.match(out, /href="\/agents\/new\?repo=toy&amp;prompt=Topo%20found[^"]*"[^>]*>Fix with an agent/, "an agent session fixes them");
  assertInert("topo rules", out);
  const clear = String(topoPage({ entries: [api], rules: { findings: [], off: new Set(), unknown: [] } }));
  assert.doesNotMatch(clear, /topo-badge|rule:/);
  assert.match(clear, /topo-sev ok">clear/);
});

test("ruleLines: a line per finding within the budget", () => {
  const many = checkRules({ entries: Array.from({ length: 30 }, (_, i) => entry(`r${i}`, `name: R${i}\n`)) });
  const lines = ruleLines(many, 300);
  assert.match(lines, /^Against the peak\.yaml rules:\n- r0 \(owner\): It&?/);
  assert.ok(lines.length <= 340);
  assert.match(lines, /\(and \d+ more\)$/);
  assert.equal(ruleLines([]), "");
});

test("/topo hosted: rule findings from the forge's files; Bino hears them; Settings lists the rules", async () => {
  const pack = createTopoPack();
  const { get } = packApp([pack], {
    hosted: true,
    env: { TOPO_RULES_OFF: "component" },
    forge: {
      id: "github",
      name: "GitHub",
      can: [],
      host: "github.com",
      repos: async () => ["ACME/quill", "ACME/old"],
      file: async (repo, path) =>
        (({
          "ACME/quill:peak.yaml": "name: Quill\ncomponents:\n  - { name: web, owns: [web] }\nruns:\n  workers: [quill]\nuses:\n  - ACME/old\n  - ACME/gone\n",
          "ACME/old:peak.yaml": "name: Old\ntier: deprecated\n",
        }) as Record<string, string>)[`${repo}:${path}`],
    },
  });
  const text = await (await get("/topo")).text();
  assert.match(text, /rule: owner<\/span> It&#39;s active, but names no owner/);
  assert.match(text, /It uses ACME\/old, which is deprecated/);
  assert.match(text, /It uses ACME\/gone, which isn&#39;t followed/);
  assert.doesNotMatch(text, /rule: component/, "switched off");
  const ctx = testContext({ hosted: true, env: { TOPO_RULES_OFF: "component" } });
  assert.match(String(pack.bino!(ctx)), /Against the peak\.yaml rules:\n- quill \(owner\)/);
  const settings = String(pack.settings!(ctx));
  assert.match(settings, /<code>component<\/code> \(off\)/);
  assert.match(settings, /<code>uses<\/code> \(on\)/);
});
