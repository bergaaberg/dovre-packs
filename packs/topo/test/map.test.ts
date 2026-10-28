/**
 * Topo's map (dovre-packs#72): the TOPO_MAP setting, the model (places, findings, links, what's off
 * the map), and the layouts: deterministic, inside the picture, quiet repos folded at 30+.
 */
import test from "node:test";
import assert from "node:assert/strict";
import yaml from "yaml";
import { parsePeak } from "@bergaaberg/peak";
import { drawMap, FOLD_AT, mapStyle, topoModel, W } from "../map.ts";
import { drift } from "../drift.ts";
import { checkRules } from "../rules.ts";
import type { TopoEntry } from "../scan.ts";
import { topoPage } from "../view.ts";
import { HOSTILE as H, assertInert } from "dovre/packs/testing.ts";

const entry = (repo: string, text: string): TopoEntry => {
  const r = parsePeak(yaml.parse(text));
  if (!("peak" in r)) throw new Error(r.problems.join(" "));
  return { repo, full: `acme/${repo}`, file: "peak.yaml", peak: r.peak };
};

const FIXTURE = [
  entry("web", "name: web\ntier: active\nowner: '@o'\nruns:\n  workers: [web]\n  buckets: [web-assets]\nuses: [acme/api, sentry]\n"),
  entry("api", "name: api\ntier: active\nowner: '@o'\nruns:\n  workers: [api]\n  databases: [api-db]\n  queues: [api-jobs]\nuses: [acme/auth, acme/gone]\n"),
  entry("auth", "name: auth\ntier: deprecated\n"),
  entry("docs", "name: docs\ntier: maintained\nuses: [acme/web]\n"),
  entry("lab", "name: lab\ntier: scratch\n"),
];

test("mapStyle: lanes by default; a style in any case; another word is named and falls back to lanes", () => {
  assert.deepEqual(mapStyle(undefined), { style: "lanes" });
  assert.deepEqual(mapStyle(" Rings "), { style: "rings" });
  assert.deepEqual(mapStyle("terrain"), { style: "terrain" });
  assert.deepEqual(mapStyle("OFF"), { style: "off" });
  assert.deepEqual(mapStyle("mountains"), { style: "lanes", unknown: "mountains" });
});

test("topoModel: bands by tier, uses and used by, services, findings bad first, glyphs with what's missing, and look-alikes off the map", () => {
  const cloud = { at: 1, account: "a", have: { workers: ["web", "api", "api-cron"], databases: [], buckets: ["web-assets"], queues: ["api-jobs"], stores: [] }, failed: [] };
  const findings = checkRules({ entries: FIXTURE, owners: ["acme"], followedKnown: true });
  const m = topoModel({ entries: FIXTURE, findings, drift: drift(FIXTURE, cloud), coverage: [{ repo: "bare", full: "acme/bare", kind: "uncataloged", lines: [] }] });
  const by = Object.fromEntries(m.places.map((p) => [p.entry.repo, p]));
  assert.deepEqual(m.places.map((p) => [p.entry.repo, p.band]), [["web", 0], ["api", 0], ["auth", 2], ["docs", 1], ["lab", 2]]);
  assert.equal(by.auth!.deprecated, true);
  assert.deepEqual([by.web!.uses, by.web!.services, by.api!.usedBy, by.web!.usedBy], [["acme/api"], ["sentry"], ["acme/web"], ["acme/docs"]]);
  assert.deepEqual(by.api!.uses, ["acme/auth"], "a repo that isn't followed isn't drawn");
  assert.deepEqual(by.api!.findings.map((f) => [f.sev, f.tag]), [["bad", "missing"], ["warn", "rule: uses"], ["warn", "rule: uses"]]);
  assert.deepEqual(by.api!.glyphs, [{ kind: "workers", miss: false }, { kind: "databases", miss: true }, { kind: "queues", miss: false }]);
  assert.deepEqual(m.off.map((o) => o.key), ["acme/bare", "cf:workers:api-cron"]);
  assert.deepEqual(by.api!.looks, ["cf:workers:api-cron"], "api-cron looks like api's");
});

test("drawMap: the same read draws the same map in every style, with every place inside it", () => {
  const m = topoModel({ entries: FIXTURE, coverage: [{ repo: "bare", full: "acme/bare", kind: "uncataloged", lines: [] }] });
  for (const style of ["lanes", "rings", "terrain"] as const) {
    const a = drawMap(m, style, "acme/web");
    assert.deepEqual(a, drawMap(topoModel({ entries: FIXTURE, coverage: [{ repo: "bare", full: "acme/bare", kind: "uncataloged", lines: [] }] }), style, "acme/web"), style);
    assert.equal(a.spots.length, FIXTURE.length);
    for (const s of a.spots) assert.ok(s.x > 0 && s.x < W && s.y > 0 && s.y < a.h - 100, `${style}: ${s.place.key} at ${s.x},${s.y}`);
    assert.equal(a.chips.length, 1);
    assert.match(a.trails.hot.d, /^M/, "the picked place's paths are lit");
    assert.equal(a.services.map((v) => v.name).join(), "sentry");
  }
  assert.notEqual(drawMap(m, "rings", undefined).bands[0], drawMap(m, "terrain", undefined).bands[0], "terrain wobbles");
});

test("drawMap: from 30 repos on, quiet ones fold into their tier's label, unless picked", () => {
  const quiet = Array.from({ length: FOLD_AT }, (_, i) => entry(`q${String(i).padStart(2, "0")}`, `name: q${i}\ntier: ${i % 2 ? "active" : "maintained"}\nowner: '@o'\n`));
  const m = topoModel({ entries: [...FIXTURE, ...quiet] });
  const pic = drawMap(m, "lanes");
  assert.equal(pic.folded.length, FOLD_AT + 1, "lab is quiet too");
  assert.equal(pic.spots.length, FIXTURE.length - 1);
  assert.deepEqual(pic.labels.map((l) => l.text), ["ACTIVE · +15 QUIET", "MAINTAINED · +15 QUIET", "DEPRECATED · SCRATCH · +1 QUIET"]);
  assert.equal(drawMap(m, "lanes", "acme/q03").spots.length, FIXTURE.length, "a picked quiet repo is drawn");
  const page = String(topoPage({ entries: [...FIXTURE, ...quiet] }));
  assert.match(page, /<summary>31 quiet repos: no links, no findings<\/summary>/);
  assert.equal(drawMap(topoModel({ entries: quiet.slice(0, FOLD_AT - 1) }), "lanes").folded.length, 0, "under 30, nothing folds");
});

test("drawMap: a long strip of unclaimed things keeps two rows and counts the rest", () => {
  const orphans = Array.from({ length: 40 }, (_, i) => ({ kind: "workers" as const, name: `leftover-worker-${i}` }));
  const pic = drawMap(topoModel({ entries: FIXTURE, drift: { missing: [], orphans } }), "lanes");
  assert.ok(pic.chips.length > 4 && pic.chips.length < 40);
  assert.equal(pic.chips.length + pic.more, 40);
  for (const c of pic.chips) assert.ok(c.x >= 18 && c.x + c.w <= W - 18 + 0.01, `${c.off.key} fits`);
  assert.match(String(topoPage({ entries: FIXTURE, drift: { configured: true, declares: true, drift: { missing: [], orphans } } })), new RegExp(`\\+${pic.more} MORE IN THE LIST`));
});

test("the map stays inert with hostile repo, tier, service and resource names", () => {
  const evil = entry("evil", `name: ${JSON.stringify(H)}\ntier: ${JSON.stringify(H)}\nruns:\n  workers: [${JSON.stringify(H)}]\nuses: [acme/web, ${JSON.stringify({ service: "x" })}]\n`);
  const e = { ...evil, repo: H, full: `acme/${H}` };
  const orphans = [{ kind: "workers" as const, name: H }, { kind: "objects" as const, name: H, worker: H }];
  for (const style of ["lanes", "rings", "terrain"] as const) {
    for (const at of [undefined, `acme/${H}`.toLowerCase(), `cf:workers:${H}`]) {
      assertInert(`map ${style} ${at}`, String(topoPage({ entries: [...FIXTURE, e], drift: { configured: true, declares: true, drift: { missing: [], orphans } }, map: { style }, at })));
    }
  }
});
