/** Topo's needs and Today line (dovre-packs#68 step 4). */
import test from "node:test";
import assert from "node:assert/strict";
import { parsePeak } from "@bergaaberg/peak";
import yaml from "yaml";
import { checkRules, drift, driftNeeds, topoBrief } from "../index.ts";
import type { TopoEntry } from "../scan.ts";
import { HOSTILE as H } from "dovre/packs/testing.ts";

const entry = (repo: string, text: string): TopoEntry => {
  const r = parsePeak(yaml.parse(text));
  if (!("peak" in r)) throw new Error(r.problems.join(" "));
  return { repo, full: `acme/${repo}`, file: "peak.yaml", peak: r.peak };
};
const read = (have: Record<string, string[]>) => ({ at: 7, account: "a", have, failed: [] });

test("driftNeeds: one per missing thing and per orphan, keyed by what it is, linked to its place, ringing topo-drift", () => {
  const d = drift([entry("shop", "name: shop\nruns:\n  workers: [shop-web]\n  databases: [shop-db]\n")], read({ workers: ["shop-web", "stray"], databases: [] }));
  const needs = driftNeeds(d, 7);
  assert.deepEqual(needs.map((n) => [n.key, n.title, n.href, n.tone, n.rank, n.at, n.ring]), [
    ["missing acme/shop databases shop-db", "shop declares D1 database shop-db, which isn't on Cloudflare", "/topo?at=acme%2Fshop", "warn", 2, 7, "topo-drift"],
    ["orphan cf:workers:stray", "worker stray is on Cloudflare, in no peak.yaml", "/topo?at=cf%3Aworkers%3Astray", "warn", 3, 7, "topo-drift"],
  ]);
  assert.deepEqual(driftNeeds(d, 99).map((n) => n.key), needs.map((n) => n.key), "the same drift keeps its keys, so it rings once");
  assert.deepEqual(driftNeeds(undefined, 1), []);
});

test("topoBrief: the repos out of line, the first linked; orphans after; empty when all is in line", () => {
  const shop = entry("shop", "name: shop\ntier: active\n");
  const lab = entry("lab", "name: lab\ntier: scratch\nruns:\n  workers: [lab]\n");
  const findings = checkRules({ entries: [shop, lab] });
  assert.deepEqual(findings.map((f) => f.repo), ["lab", "shop"]);
  assert.deepEqual(topoBrief({ findings, problems: [] }), [{ text: "2 repos", href: "/topo?at=acme%2Flab", tone: "warn" }, " are out of line on Topo", "."]);
  const bad = { repo: H, full: `acme/${H}`, file: "peak.yaml", problems: ["no"] };
  assert.deepEqual(topoBrief({ findings: [], problems: [bad] })[0], { text: H, href: `/topo?at=${encodeURIComponent(`acme/${H}`.toLowerCase())}`, tone: "bad" }, "a file that doesn't parse is bad; the name stays text (the core escapes it)");
  assert.deepEqual(topoBrief({ drift: { missing: [], orphans: [{ kind: "workers", name: "a" }, { kind: "queues", name: "b" }] }, findings: [], problems: [] }), [{ text: "2 things on Cloudflare", href: "/topo", tone: "warn" }, " are in no peak.yaml."]);
  assert.deepEqual(topoBrief({ drift: { missing: [], orphans: [] }, findings: [], problems: [] }), []);
});
