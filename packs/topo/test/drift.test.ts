/**
 * Topo's drift (dovre-packs#68 step 2): the Cloudflare inventory (cloud.ts: paging, R2's cursor, a
 * kind it can't read), missing and orphan findings (drift.ts: environments, patterns in order,
 * other providers, Durable Object classes), the Drift panels on /topo, and Bino's lines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parsePeak } from "@bergaaberg/peak";
import yaml from "yaml";
import { CloudInventory, type CloudRead, createTopoPack, drift } from "../index.ts";
import { claimer, declaresCloudflare } from "../drift.ts";
import { driftLines, topoPage } from "../view.ts";
import type { TopoEntry } from "../scan.ts";
import { HOSTILE as H, assertInert, packApp, testContext } from "dovre/packs/testing.ts";

const entry = (repo: string, text: string): TopoEntry => {
  const r = parsePeak(yaml.parse(text));
  if (!("peak" in r)) throw new Error(r.problems.join(" "));
  return { repo, full: `acme/${repo}`, web: `https://github.com/acme/${repo}`, blob: `https://github.com/acme/${repo}/blob/HEAD/`, file: "peak.yaml", peak: r.peak };
};

const read = (have: CloudRead["have"], objects?: CloudRead["objects"], failed: CloudRead["failed"] = []): CloudRead => ({ at: 1, account: "acc", have, objects, failed });

/** A Cloudflare API with these lists; `deny` answers 403 for paths containing it. Records the paths asked. */
function fakeCf(o: { scripts?: string[]; objects?: { script: string; class: string }[]; d1?: string[]; kv?: string[]; r2?: string[][]; queues?: string[]; deny?: string[]; calls?: string[] }): typeof fetch {
  const ok = (result: unknown, result_info?: unknown) => new Response(JSON.stringify({ success: true, errors: [], result, result_info }), { status: 200 });
  const page = <T>(rows: T[], url: URL) => {
    const per = Number(url.searchParams.get("per_page")), p = Number(url.searchParams.get("page"));
    return ok(rows.slice((p - 1) * per, p * per), { page: p, per_page: per, total_pages: Math.max(1, Math.ceil(rows.length / per)) });
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    o.calls?.push(`${url.pathname}${url.search}`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer tok");
    if (o.deny?.some((d) => url.pathname.includes(d))) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
    const p = url.pathname.replace("/client/v4/accounts/acc", "");
    if (p === "/workers/scripts") return ok((o.scripts ?? []).map((id) => ({ id })));
    if (p === "/workers/durable_objects/namespaces") return page(o.objects ?? [], url);
    if (p === "/d1/database") return page((o.d1 ?? []).map((name) => ({ name, uuid: name })), url);
    if (p === "/storage/kv/namespaces") return page((o.kv ?? []).map((title) => ({ title, id: title })), url);
    if (p === "/queues") return page((o.queues ?? []).map((queue_name) => ({ queue_name })), url);
    if (p === "/r2/buckets") {
      const pages = o.r2 ?? [[]];
      const i = Number(url.searchParams.get("cursor") ?? 0);
      return ok({ buckets: pages[i]!.map((name) => ({ name })) }, i + 1 < pages.length ? { cursor: String(i + 1) } : {});
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

test("CloudInventory: every kind, paged and by cursor; Durable Object classes by worker; kept 15 min", async () => {
  const calls: string[] = [];
  let now = 1000;
  const d1 = Array.from({ length: 130 }, (_, i) => `db-${String(i).padStart(3, "0")}`);
  const inv = new CloudInventory({
    env: () => ({ account: " acc ", token: "tok\n" }),
    now: () => now,
    fetchFn: fakeCf({ scripts: ["web", "api", "web"], objects: [{ script: "api", class: "Room" }, { script: "api", class: "Lock" }], d1, kv: ["CACHE"], r2: [["a", "b"], ["c"]], queues: ["jobs"], calls }),
  });
  assert.equal(inv.configured(), true);
  const r = (await inv.load())!;
  assert.deepEqual(r.have.workers, ["api", "web"], "sorted, once each");
  assert.equal(r.have.databases!.length, 130, "two pages of D1");
  assert.deepEqual([r.have.stores, r.have.buckets, r.have.queues], [["CACHE"], ["a", "b", "c"], ["jobs"]]);
  assert.deepEqual(r.objects, { api: ["Room", "Lock"] });
  assert.deepEqual(r.failed, []);
  assert.ok(calls.some((c) => c.includes("/r2/buckets") && c.includes("cursor=1")), "R2 follows the cursor");
  const n = calls.length;
  assert.equal(await inv.load(), r, "kept");
  assert.equal(calls.length, n);
  now += 15 * 60_000;
  assert.notEqual(await inv.load(), r, "read again once it's old");
});

test("CloudInventory: a kind the token can't read is named with the permission it needs, and left out", async () => {
  const inv = new CloudInventory({ env: () => ({ account: "acc", token: "tok" }), fetchFn: fakeCf({ scripts: ["web"], deny: ["/r2/", "/queues"] }) });
  const r = (await inv.load())!;
  assert.deepEqual(r.have.workers, ["web"]);
  assert.equal(r.have.buckets, undefined, "not taken for an empty list");
  assert.deepEqual(r.failed.map((f) => f.what), ["buckets", "queues"]);
  assert.match(r.failed[0]!.why, /HTTP 403: Authentication error \(does the token have Workers R2 Storage Read\?\)/);
});

test("CloudInventory: not configured without both settings; nothing is fetched", async () => {
  const calls: string[] = [];
  const inv = new CloudInventory({ env: () => ({ account: "acc", token: " " }), fetchFn: fakeCf({ calls }) });
  assert.equal(inv.configured(), false);
  assert.equal(await inv.load(), undefined);
  assert.deepEqual(calls, []);
});

test("claimer: a pattern claims what no entry before it names; order matters", () => {
  const list = [{ name: "skribb-web" }, { name: "skribb-cms-*" }, { name: "skribb-*" }];
  assert.equal(claimer(list, "skribb-web")!.name, "skribb-web");
  assert.equal(claimer(list, "skribb-cms-acme")!.name, "skribb-cms-*");
  assert.equal(claimer(list, "skribb-api")!.name, "skribb-*");
  assert.equal(claimer(list, "other"), undefined);
  assert.equal(claimer([{ name: "skribb-*" }, { name: "skribb-web" }], "skribb-web")!.name, "skribb-*", "a pattern first claims a later name too");
});

test("drift: missing names (once, with their environments), orphans by kind; patterns are never missing", () => {
  const skribb = entry(
    "skribb",
    `name: Skribb
runs:
  workers: [skribb-web, skribb-cms-*]
  databases: [skribb-db]
  buckets: [skribb-media]
environments:
  staging:
    runs:
      databases: [skribb-db-staging]
`,
  );
  const d = drift([skribb], read({ workers: ["other", "skribb-cms-a", "skribb-cms-b"], databases: ["skribb-db", "stray-db"], buckets: [], stores: ["KV1"] }));
  assert.deepEqual(
    d.missing.map((m) => [m.kind, m.name, m.envs.join("+")]),
    [
      ["workers", "skribb-web", "production+staging"],
      ["databases", "skribb-db-staging", "staging"],
      ["buckets", "skribb-media", "production+staging"],
    ],
    "staging inherits workers and buckets from production, so they're missing in both",
  );
  assert.equal(d.missing[0]!.blob, "https://github.com/acme/skribb/blob/HEAD/", "a finding keeps where its file opens");
  assert.deepEqual(
    d.orphans.map((o) => [o.kind, o.name]),
    [
      ["workers", "other"],
      ["databases", "stray-db"],
      ["stores", "KV1"],
    ],
  );
});

test("drift: other providers are skipped (no provider means Cloudflare); unread kinds aren't judged", () => {
  const e = entry(
    "mixed",
    `name: Mixed
provider: cloudflare
runs:
  workers:
    - web
    - name: lambda-fn
      provider: aws
  queues: [jobs]
`,
  );
  const aws = entry("elsewhere", "name: Elsewhere\nprovider: fly\nruns:\n  workers: [other]\n");
  const d = drift([e, aws], read({ workers: ["web", "other"] }, undefined, [{ what: "queues", why: "HTTP 403" }]));
  assert.deepEqual(d.missing, [], "lambda-fn runs on aws; queues weren't read");
  assert.deepEqual(d.orphans.map((o) => o.name), ["other"], "a fly entry doesn't claim a Cloudflare worker");
  assert.equal(declaresCloudflare([aws]), false);
  assert.equal(declaresCloudflare([e]), true);
  assert.equal(declaresCloudflare([entry("bare", "name: Bare\n")]), false);
  assert.equal(declaresCloudflare([entry("st", "name: St\nenvironments:\n  staging:\n    runs:\n      workers: [st-staging]\n")]), true, "an environment's runs count");
});

test("drift: Durable Object classes on claimed workers: declared but not held is missing, held but not named is an orphan", () => {
  const e = entry(
    "rooms",
    `name: Rooms
runs:
  workers:
    - name: rooms-api
      objects: [Room, Lock]
    - name: rooms-*
`,
  );
  const d = drift([e], read({ workers: ["rooms-api", "rooms-edge", "loose"] }, { "rooms-api": ["Room", "Counter"], "rooms-edge": ["Cache"], loose: ["Thing"] }));
  assert.deepEqual(d.missing.map((m) => [m.kind, m.worker, m.name]), [["objects", "rooms-api", "Lock"]]);
  assert.deepEqual(
    d.orphans.map((o) => [o.kind, o.worker ?? "", o.name]),
    [
      ["workers", "", "loose"],
      ["objects", "rooms-api", "Counter"],
      ["objects", "rooms-edge", "Cache"],
    ],
    "an orphan worker's classes go with it",
  );
  assert.deepEqual(drift([e], read({ workers: ["rooms-api"] })).missing, [], "classes aren't judged when they couldn't be read");
});

test("topoPage: the Drift panels, the settings hint, what Cloudflare couldn't read, and all clear", () => {
  const e = entry("skribb", "name: Skribb\nruns:\n  workers: [skribb-web]\n");
  const r = read({ workers: ["loose-a", "loose-b"] }, { "loose-a": ["X"] }, [{ what: "buckets", why: "HTTP 403: Authentication error" }]);
  const out = String(topoPage({ entries: [e], drift: { configured: true, read: r, drift: drift([e], r), declares: true } }));
  assert.match(out, /Missing in Cloudflare/);
  assert.match(out, /Declares worker <code>skribb-web<\/code>, but Cloudflare has none · production/);
  assert.match(out, /href="https:\/\/github\.com\/acme\/skribb\/blob\/HEAD\/peak\.yaml"/);
  assert.match(out, /Not in any peak\.yaml/);
  assert.match(out, /<code>loose-a<\/code>, <code>loose-b<\/code>/);
  assert.match(out, /3 out of line with Cloudflare/);
  assert.match(out, /aren(&#39;|')t checked: R2 buckets \(HTTP 403: Authentication error\)/);

  assert.match(String(topoPage({ entries: [e], drift: { configured: false, declares: true } })), /Set <code>CF_ACCOUNT_ID<\/code>/);
  assert.doesNotMatch(String(topoPage({ entries: [], drift: { configured: false, declares: false } })), /CF_ACCOUNT_ID/, "no hint when no file declares Cloudflare runs");
  const fine = read({ workers: ["skribb-web"] });
  assert.match(String(topoPage({ entries: [e], drift: { configured: true, read: fine, drift: drift([e], fine), declares: true } })), /everything there is claimed/);
  assert.doesNotMatch(String(topoPage({ entries: [e], filter: "active", drift: { configured: true, read: r, drift: drift([e], r), declares: true } })), /Missing in Cloudflare/, "a tier filter shows repos only");
});

test("topoPage: hostile names in drift stay inert", () => {
  const e = entry(H.replace(/\s/g, ""), `name: x\nruns:\n  workers:\n    - name: ${JSON.stringify(H)}\n      objects: [Gone]\n`);
  const r = read({ workers: [H, `${H}2`] }, { [H]: [H, `${H}b`] }, [{ what: "queues", why: H }]);
  const d = drift([e], r);
  assert.ok(d.missing.length && d.orphans.length);
  assertInert("topo drift", String(topoPage({ entries: [e], drift: { configured: true, read: r, drift: d, declares: true } })));
});

test("driftLines: missing then orphans, within the limit", () => {
  const e = entry("skribb", "name: Skribb\nruns:\n  workers: [skribb-web]\n");
  const d = drift([e], read({ workers: Array.from({ length: 40 }, (_, i) => `orphan-worker-${i}`) }));
  const lines = driftLines(d, 300);
  assert.match(lines, /^Drift against Cloudflare:\n- missing: skribb declares worker skribb-web \(production\), not on Cloudflare\n- orphan: worker orphan-worker-0 is on Cloudflare/);
  assert.ok(lines.length <= 330);
  assert.match(lines, /\(and \d+ more\)$/);
  assert.equal(driftLines(undefined), "");
  assert.equal(driftLines({ missing: [], orphans: [] }), "");
});

test("/topo hosted with Cloudflare set: reads the inventory and shows drift; Bino hears it first", async () => {
  const pack = createTopoPack({ cloud: new CloudInventory({ env: () => ({ account: "acc", token: "tok" }), fetchFn: fakeCf({ scripts: ["quill-web", "stray"] }) }) });
  const { get } = packApp([pack], {
    hosted: true,
    forge: { id: "github", name: "GitHub", can: [], host: "github.com", repos: async () => ["ACME/quill"], file: async (repo, path) => (repo === "ACME/quill" && path === "peak.yaml" ? "name: Quill\nruns:\n  workers: [quill-web, quill-api]\n" : undefined) },
  });
  const text = await (await get("/topo")).text();
  assert.match(text, /Missing in Cloudflare/);
  assert.match(text, /<code>quill-api<\/code>/);
  assert.match(text, /Not in any peak\.yaml[\s\S]*<code>stray<\/code>/);
  const bino = String(pack.bino!(testContext({ hosted: true })));
  assert.match(bino, /^Drift against Cloudflare:\n- missing: quill declares worker quill-api/);
  assert.match(bino, /Quill/, "then the repos");
});
