/** The avatar: model, drawing, the situation it reacts to, GHE's numbers, the service and its pages. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAvatar } from "../avatar.ts";
import { createAvatarPack } from "../index.ts";
import { activePacks } from "dovre/packs/registry.ts";
import { PACK_API, type Pack, type PackForge } from "dovre/packs/types.ts";
import { isoSvg, shade } from "../iso.ts";
import { signalsFrom } from "../feed.ts";
import { buildAvatar, CREATURES, type Creature, DEFAULT_LOOK, effects, LAYER, lookOf, PARTS, statsOf, traits } from "../model.ts";
import { type Signals, situationKey, situationOf, trySituation } from "../mood.ts";
import { createAvatarData, gatherAvatarStats, gatherMerges, nightShareOf, statsFrom, streakOf } from "../stats.ts";
import { openDb } from "dovre/db.ts";
import { needsOf } from "dovre/home/needs.ts";
import { AVATAR_CSS, AVATAR_PAGE_CSS } from "../style.ts";
import { AVATAR_JS } from "../script.ts";
import { ON_JS } from "dovre/ui/on.js.ts";
import { resetWhen, setWhen } from "dovre/when.ts";
import { HOSTILE as H, assertInert, packApp, testDeploy as deploy, testPr as pr, testSession as session, testSnapshot as snapshot } from "dovre/packs/testing.ts";

const STATS = { prs: 30, reviews: 90, repos: 5, streak: 12, night: 40, langs: ["C#", "TypeScript"] };
const CALM: Signals = { redBuilds: 0, deploysWaiting: 0, agentsWorking: 0, agentsAsking: 0, reviewsAsked: 0, mergedToday: 0, doing: 0, hour: 11 };

test("looks and stats are read narrowly: anything unknown falls back, numbers are clamped", () => {
  assert.deepEqual(lookOf({ creature: "dragon", body: H, finish: "brass", show: { scarf: false, lamp: "yes" } }), { ...DEFAULT_LOOK, show: { ...DEFAULT_LOOK.show, scarf: false } });
  assert.deepEqual(lookOf(null), DEFAULT_LOOK);
  assert.deepEqual(statsOf({ prs: -4, reviews: 1e9, repos: 2.6, streak: "9", night: Number.NaN, langs: ["C#", H, 3, "TypeScript", "Go", "SQL", "Python"] }), { prs: 0, reviews: 999, repos: 3, streak: 0, night: 0, langs: ["C#", "TypeScript", "Go", "SQL"] });
});

test("the numbers shape the traits, and the page says how", () => {
  const none = traits(statsOf({}));
  assert.equal(none.ridge, 0);
  assert.equal(none.flagH, 0);
  assert.equal(none.lamp, 0);
  assert.equal(none.badge, false);
  const lots = traits({ ...STATS, prs: 300, reviews: 200, streak: 30, night: 80 });
  assert.equal(lots.ridge, 9);
  assert.equal(lots.ridgeH, 3);
  assert.equal(lots.badge, true);
  assert.equal(lots.flagH, 12);
  assert.equal(lots.lamp, 1);
  assert.match(effects(STATS).prs, /4 on the back ridge, medium/);
  assert.equal(effects({ ...STATS, langs: [] }).langs, "A grey scarf");
});

test("every creature builds, from palette colours and known parts only, the same each time", () => {
  for (const c of Object.keys(CREATURES) as Creature[]) {
    const a = buildAvatar({ ...DEFAULT_LOOK, creature: c }, STATS);
    assert.ok(a.voxels.length > 300, c);
    assert.ok(a.voxels.every((v) => /^#[0-9a-f]{6}$/i.test(v.c) && (PARTS as readonly string[]).includes(v.part)), c);
    assert.ok(a.voxels.some((v) => v.part === "lensL") && a.voxels.some((v) => v.part === "lensR"), `${c}: two eyes that glow`);
    assert.deepEqual(buildAvatar({ ...DEFAULT_LOOK, creature: c }, STATS).voxels, a.voxels);
  }
  const bare = buildAvatar({ ...DEFAULT_LOOK, show: { strap: false, scarf: false, pack: false, ridge: false, flag: false, lamp: false, badge: false } }, STATS);
  assert.ok(bare.voxels.length < buildAvatar(DEFAULT_LOOK, STATS).voxels.length);
  // The ridge never stacks into a pole: one spike column per row of the spine.
  for (const c of ["fox", "owl", "troll"] as Creature[]) {
    const { voxels } = buildAvatar({ ...DEFAULT_LOOK, creature: c }, { ...STATS, prs: 300 });
    const top = Math.max(...voxels.filter((v) => v.part !== "flag").map((v) => v.y));
    assert.ok(top < 24, `${c}: nothing towers over the head (${top})`);
  }
});

test("the drawing: whole-number paths in layers, parts as groups, a label escaped, nothing else from outside", () => {
  const { voxels } = buildAvatar(DEFAULT_LOOK, STATS, situationOf({ ...CALM, agentsWorking: 2 }));
  const svg = isoSvg(voxels, { label: H, className: `mood-idle ${H}`, shadow: true, style: AVATAR_CSS });
  assertInert("avatar", svg);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[-\d. ]+"/);
  assert.match(svg, /<title>&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(svg, /<g class="av mood-idle scriptxscript/, "classes keep letters, digits and dashes only");
  for (const g of ["av-under", "av-all", "av-back", "av-body", "av-head", "av-lensL", "av-lensR", "av-tail", "av-drone1", "av-drone2"]) assert.ok(svg.includes(`class="${g}"`), g);
  for (const d of svg.matchAll(/ d="([^"]*)"/g)) assert.match(d[1]!, /^(M-?\d+ -?\d+v2l-?1-1z)+$/);
  for (const f of svg.matchAll(/fill="([^"]*)"/g)) assert.match(f[1]!, /^#[0-9a-f]{6}$|^#000$/);
  // Each layer keeps one face per grid triangle: no triangle twice in a layer.
  const layer = svg.slice(svg.indexOf('class="av-body"'), svg.indexOf('class="av-head"'));
  const tris = [...layer.matchAll(/M(-?\d+) (-?\d+)v2l(-?1)/g)].map((m) => m.slice(1).join(","));
  assert.equal(new Set(tris).size, tris.length);
  assert.ok(svg.length < 60_000, `${svg.length} bytes`);
  const mirrored = isoSvg(voxels, { facing: "right" });
  assert.notEqual(mirrored, isoSvg(voxels));
  assert.equal(isoSvg([]), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`);
  assert.equal(shade("#808080", 0.5), "#404040");
  assert.equal(shade("red", 1), "#808080");
  assert.ok(!isoSvg(voxels, { style: "</style><script>x</script>" }).includes("</style><script>"));
  assert.ok(Object.values(LAYER).every((l) => ["under", "back", "body", "head", "over"].includes(l)));
});

test("the situation: fire when a pack says so, storm when something's wrong, party after a merge, night late; props follow what's going on", () => {
  assert.equal(situationOf(CALM).scene, "calm");
  assert.equal(situationOf({ ...CALM, hour: 22 }).scene, "night");
  assert.equal(situationOf({ ...CALM, hour: 5 }).scene, "night");
  assert.equal(situationOf({ ...CALM, mergedToday: 1 }).scene, "party");
  assert.equal(situationOf({ ...CALM, mergedToday: 1, redBuilds: 1 }).scene, "storm", "trouble beats a party");
  const fire = situationOf({ ...CALM, trouble: [{ level: "fire", why: "50 failed messages" }], onCall: true });
  assert.equal(fire.scene, "fire");
  assert.equal(fire.why[0], "50 failed messages");
  assert.equal(fire.props.mug, true, "a coffee in the flames");
  assert.equal(fire.props.beacon, true);
  const busy = situationOf({ ...CALM, deploysWaiting: 2, agentsWorking: 4, agentsAsking: 1, reviewsAsked: 7, doing: 9 });
  assert.deepEqual(busy.props, { hardhat: true, drones: 3, droneAsks: true, papers: 5, notes: 4, beacon: false, mug: true });
  assert.notEqual(situationKey(busy), situationKey(situationOf(CALM)));
  assert.equal(situationKey(situationOf(CALM)), situationKey(situationOf({ ...CALM, hour: 12 })), "the same picture, the same key");
  // Scenes and props draw.
  for (const scene of [{ trouble: [{ level: "fire" as const, why: "x" }] }, { redBuilds: 1 }, { mergedToday: 1 }, { hour: 23 }, {}]) {
    const v = buildAvatar(DEFAULT_LOOK, STATS, situationOf({ ...CALM, ...scene, deploysWaiting: 1, reviewsAsked: 2, doing: 1, onCall: true })).voxels;
    assert.ok(v.some((x) => x.part === "ground"), JSON.stringify(scene));
  }
});

test("the packs' troubles: a storm rains, a fire burns, each says why, and the line it says links to where to look", () => {
  const storm = situationOf({ ...CALM, trouble: [{ level: "storm", why: "1 red signal", href: "/signals" }] });
  assert.deepEqual([storm.scene, storm.why, storm.href], ["storm", ["1 red signal"], "/signals"]);
  const fire = situationOf({ ...CALM, trouble: [{ level: "storm", why: "a" }, { level: "fire", why: "3 red signals" }] });
  assert.deepEqual([fire.scene, fire.why, fire.href], ["fire", ["3 red signals"], undefined]);
  assert.equal(situationOf({ ...CALM, trouble: [{ level: "fire", why: "x" }, { level: "fire", why: "y", href: "/signals" }] }).href, "/signals", "the first fire with a page");
  assert.equal(situationOf({ ...CALM, mergedToday: 2, trouble: [] }).scene, "party");
});

test("signals come from the snapshot, the packs' activity and duty, and My list as counts", () => {
  const s = snapshot({
    login: "me",
    red: [{ repo: "ACME/shop-api", branch: "main", workflow: "ci", since: "2026-10-22T06:00:00Z", failures: 1, url: "https://acme.ghe.com/x" }] as never,
    prs: { ok: true, value: { mine: [pr({ repo: "ACME/shop-api" })], review: [pr({ number: 7 }), pr({ number: 8 })] } },
  });
  // The agents pack counts its own (src/packs/core/agents/test/turns.test.ts).
  const sig = signalsFrom({ snap: s, needs: needsOf(s), pulse: { working: 3, asking: 1, trouble: [{ level: "fire", why: "55 failed messages" }], onDuty: true }, doing: 2, mergedToday: 1, hour: 9 });
  assert.deepEqual(sig, { redBuilds: 1, deploysWaiting: 0, agentsWorking: 3, agentsAsking: 1, reviewsAsked: 2, mergedToday: 1, doing: 2, hour: 9, trouble: [{ level: "fire", why: "55 failed messages" }], onCall: true });
  assert.equal(situationOf(sig).scene, "fire");
  const off = signalsFrom({ snap: snapshot({ deploys: { ok: true, value: [deploy()] } }), needs: [], pulse: { working: 0, asking: 0, trouble: [] }, doing: 0, mergedToday: 0, hour: 9 });
  assert.equal(off.onCall, undefined, "no pack on duty: nothing said about it");
});

test("the forge's numbers: streaks skip weekends and allow an empty today, late commits by their own clock", () => {
  const cal = (days: [string, number][]) => days.map(([date, count]) => ({ date, count }));
  // 2026-10-23 is a Friday.
  assert.equal(streakOf(cal([["2026-10-19", 1], ["2026-10-20", 2], ["2026-10-21", 1], ["2026-10-22", 3], ["2026-10-23", 0]]), "2026-10-23"), 4, "today without a commit yet doesn't break it");
  assert.equal(streakOf(cal([["2026-10-16", 1], ["2026-10-17", 0], ["2026-10-18", 0], ["2026-10-19", 1], ["2026-10-20", 1]]), "2026-10-20"), 3, "a weekend neither counts nor breaks it");
  assert.equal(streakOf(cal([["2026-10-21", 0], ["2026-10-22", 0], ["2026-10-23", 0]]), "2026-10-23"), 0);
  assert.equal(nightShareOf(["2026-10-13T21:05:51.000+02:00", "2026-10-13T11:46:03.000+02:00", "2026-10-14T05:10:00+02:00", "bad"]), 67);
  assert.equal(nightShareOf([]), 0);
  const s = statsFrom({ prs: 12, reviews: 30, calendar: [], today: "2026-10-23", commits: [{ repo: "ACME/a", date: "2026-10-13T10:00:00+02:00" }, { repo: "ACME/a", date: "2026-10-14T10:00:00+02:00" }, { repo: "ACME/b", date: "2026-10-13T22:00:00+02:00" }], languages: new Map([["ACME/a", ["C#", "HCL"]], ["ACME/b", ["C#", "TypeScript", "Shell"]]]) });
  assert.deepEqual(s, { prs: 12, reviews: 30, repos: 2, streak: 0, night: 33, langs: ["C#", "HCL", "TypeScript", "Shell"] });
});

const FORGE: PackForge = { id: "github", name: "GitHub", host: "github.com", login: "me", owners: "ACME" };

test("from the forge's work: the numbers it shapes; a forge that doesn't say leaves its starting shape", async () => {
  const at = Date.parse("2026-10-23T10:00:00Z");
  let since = "";
  const work = { merged: 12, reviewed: 30, days: [], commits: [{ repo: "ACME/a", date: "2026-10-13T22:00:00+02:00" }], languages: { "ACME/a": ["C#"] } };
  const s = await gatherAvatarStats({ ...FORGE, work: async (d) => ((since = d), work) }, at);
  assert.equal(since, "2026-07-31", "twelve weeks back");
  assert.deepEqual(s, { prs: 12, reviews: 30, repos: 1, streak: 0, night: 100, langs: ["C#"] });
  assert.deepEqual(await gatherAvatarStats(FORGE, at), statsOf({}));
  assert.equal(await gatherMerges(FORGE, at), 0);
  assert.equal(await gatherMerges({ ...FORGE, merged: async (t) => (t === "2026-10-22T10:00:00Z" ? 3 : -1) }, at), 3, "the last 24 hours");
});

test("the forge's numbers are gathered in the background, kept, and the merges read more often", async () => {
  const db = openDb();
  let t = Date.parse("2026-10-22T10:00:00Z");
  let gathers = 0, merges = 0;
  const changed: number[] = [];
  const data = createAvatarData({ forge: () => FORGE, now: () => t, onChange: () => changed.push(t), gather: async () => (gathers++, STATS), merges: async () => (merges++, 2) });
  await data.refresh(db.DB);
  assert.deepEqual(data.facts(), { stats: STATS, mergedToday: 2, at: t, mergesAt: t, login: "me" });
  t += 11 * 60e3;
  await data.refresh(db.DB);
  assert.deepEqual([gathers, merges], [1, 2], "merges every ten minutes, the rest every six hours");
  await data.refresh(db.DB);
  assert.deepEqual([gathers, merges], [1, 2], "nothing due, nothing read");
  const again = createAvatarData({ forge: () => FORGE, now: () => t });
  await again.load(db.DB);
  assert.deepEqual(again.facts()?.stats, STATS, "kept across a restart");
  const kept = await db.DB.prepare("SELECT value FROM settings WHERE key = 'avatar-stats'").first<{ value: string }>();
  assert.ok(kept && !kept.value.includes("title"));
  const failing = createAvatarData({ forge: () => FORGE, now: () => t, gather: async () => Promise.reject(new Error("GHE down")), log: (l) => changed.push(l.length) });
  await failing.refresh(db.DB);
  assert.equal(failing.facts(), undefined);
});

test("the service: one key per picture, a line when the scene turns, the look kept, a copy for the starting page", async () => {
  const db = openDb();
  let sig: Signals = CALM;
  let starts = 0;
  let start = "";
  const a = createAvatar({ signals: () => sig, onStart: (svg) => (starts++, (start = svg)) });
  await a.load(db.DB);
  assert.match(start, /^<svg/);
  const k0 = a.now().key;
  a.now();
  assert.equal(starts, 1, "nothing changed, nothing drawn again");
  sig = { ...CALM, trouble: [{ level: "fire" as const, why: "120 failed messages", href: "/signals" }] };
  assert.notEqual(a.now().key, k0);
  assert.equal(starts, 2);
  assert.equal(a.now().scene, "fire");
  assert.equal(a.now().say?.text, "This is fine. 120 failed messages.");
  assert.equal(a.now().say?.href, "/signals");
  sig = { ...CALM, trouble: [{ level: "storm", why: "2 red signals", href: "/signals" }] };
  assert.deepEqual([a.now().say?.text, a.now().say?.href], ["Rain coming in. 2 red signals.", "/signals"]);
  sig = { ...CALM, trouble: [{ level: "fire" as const, why: "120 failed messages", href: "/signals" }] };
  a.now();
  const svg = a.svg({ mood: "working", facing: "left", bare: false, still: false });
  assert.match(svg, /class="av mood-working scene-fire cr-dino"/, "the root says the mood, the scene and the creature");
  assert.match(svg, /class="av-fire"/);
  assert.match(svg, /@keyframes av-hop/);
  assert.equal(a.svg({ mood: "working", facing: "left", bare: false, still: false }), svg, "drawn once");
  const bare = a.svg({ mood: "idle", facing: "left", bare: true, still: true });
  assert.ok(!bare.includes("av-fire") && !bare.includes("av-ground") && !bare.includes("@keyframes"), "bare: no scene; still: no motion");
  await a.setLook(db.DB, { ...DEFAULT_LOOK, creature: "owl", body: "snow" });
  assert.equal(starts, 5, "fire, storm, fire again, then the new look");
  const again = createAvatar({ signals: () => sig });
  await again.load(db.DB);
  assert.equal(again.look().creature, "owl", "kept in settings");
});

test("the service: the first scene once the signals come in is where it starts, not a turn to say (#hosted first load)", () => {
  let sig: Signals | undefined;
  const a = createAvatar({ signals: () => sig });
  assert.equal(a.now().say, undefined);
  sig = { ...CALM, trouble: [{ level: "storm", why: "2 red signals", href: "/signals" }] };
  assert.equal(a.now().scene, "storm");
  assert.equal(a.now().say, undefined, "a fresh start (a new Worker isolate) doesn't announce what was already so");
  sig = { ...CALM, trouble: [{ level: "fire" as const, why: "120 failed messages", href: "/signals" }] };
  assert.equal(a.now().say?.text, "This is fine. 120 failed messages.", "a turn after that is said");
});

test("trying a scene: a known scene replaces the real one, known props add on top, the rest is ignored", () => {
  const real = situationOf({ ...CALM, deploysWaiting: 1 });
  const fire = trySituation(real, "fire", ["beacon"]);
  assert.equal(fire.scene, "fire");
  assert.deepEqual(fire.props, { ...real.props, beacon: true, mug: true }, "a coffee in the flames, the hard hat kept");
  assert.deepEqual(fire.why, [], "no reasons: nothing is going on");
  const busy = trySituation(real, "now", ["drones", "asking", "papers", "notes"]);
  assert.equal(busy.scene, "calm", "'now' keeps the real scene");
  assert.deepEqual([busy.props.drones, busy.props.droneAsks, busy.props.papers, busy.props.notes], [2, true, 3, 2]);
  const odd = trySituation(real, H, [H, "__proto__", 1]);
  assert.deepEqual([odd.scene, odd.props], [real.scene, real.props], "unknown words change nothing");
});

test("the crafting page tries a scene: the panel, what each would say, and the preview drawn in it, nothing kept", async (t) => {
  setWhen({ tz: "UTC" });
  t.after(resetWhen);
  const pack = createAvatarPack({ now: () => Date.parse("2026-10-22T10:00:00Z") });
  const { get } = packApp([pack], { snapshot: snapshot() });
  const page = await (await get("/avatar")).text();
  assertInert("avatar page", page);
  assert.match(page, /name="scene" value="now" data-say="" checked>As things are/);
  assert.match(page, /name="scene" value="fire" data-say="This is fine\.">Fire/);
  assert.match(page, /name="try" value="beacon">/);
  const fire = await (await get("/avatar/preview.svg?creature=dino&scene=fire&try=beacon")).text();
  assert.match(fire, /class="av mood-idle scene-fire"/);
  assert.match(fire, /class="av-fire"/, "the flames");
  assert.match(fire, /class="av-beacon"/);
  const odd = await (await get(`/avatar/preview.svg?scene=${encodeURIComponent(H)}&try=${encodeURIComponent(H)}`)).text();
  assert.match(odd, /class="av mood-idle scene-calm"/, "an unknown scene is the real one");
  assert.doesNotMatch(odd, /class="av-fire"|<script|javascript:/);
  const now = await (await get("/avatar/now")).json();
  assert.equal(now.scene, "calm", "trying changes nothing real");
  assert.equal(now.say, undefined);
});

test("the pack: the image with its cache rules, what's going on now, Today and the Bino button, the crafting page, and saving a look", async (t) => {
  // 10:00 UTC is daytime here, wherever the tests run.
  setWhen({ tz: "UTC" });
  t.after(resetWhen);
  const s = snapshot();
  const pack = createAvatarPack({ now: () => Date.parse("2026-10-22T10:00:00Z") });
  // Another pack with something at work: the pulse says busy.
  const worker = { manifest: { api: PACK_API, id: "worker", name: "Worker", description: "Works", domain: "general", execution: "any" }, pulse: () => ({ working: 1 }) } as Pack;
  const { get, post } = packApp([pack, worker], { snapshot: s });
  const now = await (await get("/avatar/now")).json();
  assert.equal(now.busy, true);
  assert.equal(now.scene, "calm");
  const img = await get(`/avatar/image.svg?k=${now.key}&m=working&f=r&b=1`);
  assert.equal(img.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(img.headers.get("cache-control") ?? "", /immutable/);
  assert.match(await img.text(), /class="av mood-working /);
  const old = await get(`/avatar/image.svg?k=old&m=${encodeURIComponent(H)}`);
  assert.equal(old.headers.get("cache-control"), "no-store", "an old key isn't kept");
  assert.match(await old.text(), /class="av mood-idle /, "an unknown mood is idle");
  const today = await (await get("/")).text();
  assert.match(today, /class="av-hero"/);
  assert.match(today, /data-av="hero"/);
  // Its script comes beside the core's, in a block of its own.
  const js = today.match(/<script type="module" src="(\/assets\/packs\.[0-9a-z]+\.js)">/)?.[1];
  assert.ok(js, "the packs' script is linked");
  const body = await (await get(js)).text();
  assert.match(body, /^\/\/ avatar\n\{\n[^]*dovreOn\(\["avatar"/);
  const face = pack.slots!({} as never)["bino.face"]!;
  assert.match(String(face({ place: "dock" })), /^<span class="av-face" data-scene="calm"><img [^>]*data-av="dock"/, "the Bino button's face");
  assert.match(String(face({ place: "mini", thinking: true })), /href="\/avatar"[^]*data-mood="working"/, "at work while Bino answers");
  const page = await (await get("/avatar")).text();
  assertInert("avatar page", page);
  assert.match(page, /name="creature" value="dino" checked/);
  assert.match(page, /class="av-sw b-moss"/);
  assert.doesNotMatch(page.slice(page.indexOf("av-craft")), /style="/, "swatches take their colour from the stylesheet");
  const r = await post("/avatar", { creature: "troll", body: "lingon", finish: H, show: "scarf" });
  assert.equal(r.headers.get("location"), "/avatar?saved=1");
  const look = async () => (await (await get("/avatar")).text()).match(/name="creature" value="(\w+)" checked/)?.[1];
  assert.equal(await look(), "troll");
  const saved = await get("/avatar");
  const text = await saved.text();
  assert.match(text, /name="finish" value="brass" checked/, "an unknown finish isn't kept");
  assert.match(text, /name="show" value="scarf" checked/);
  assert.equal((await post("/avatar", { creature: "fox" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(await look(), "troll", "a post from elsewhere changes nothing");
  const preview = await get(`/avatar/preview.svg?creature=fox&body=rust&finish=brass&show=${encodeURIComponent(H)}`);
  assert.match(await preview.text(), /^<svg/);
});

test("Today's avatar: paused, played and hidden from Today, kept, and brought back from its page", async () => {
  const s = snapshot();
  const pack = createAvatarPack({ now: () => Date.parse("2026-10-22T10:00:00Z") });
  const { get, post } = packApp([pack], { snapshot: s });
  let today = await (await get("/")).text();
  assert.match(today, /<form method="post" action="\/avatar\/today" class="av-ctl" data-av-ctl><button type="submit" name="mode" value="still"/, "moving: a pause button");
  assert.doesNotMatch(today, /data-av="hero"[^>]*data-s="1"/);
  const r = await post("/avatar/today", { mode: "still" });
  assert.deepEqual([r.status, r.headers.get("location")], [303, "/"], "a plain form goes back to Today");
  today = await (await get("/")).text();
  assert.match(today, /class="av-hero still"/);
  assert.match(today, /src="\/avatar\/image\.svg\?[^"]*&amp;s=1"[^>]*data-av="hero"[^>]*data-s="1"/, "still: the picture without its motion");
  assert.match(today, /name="mode" value="move"[^>]*aria-pressed="true"/, "and a play button");
  assert.equal((await post("/avatar/today", { mode: "hide" }, { "x-dovre-send": "1" })).status, 204, "the page script's quiet post");
  today = await (await get("/")).text();
  assert.doesNotMatch(today, /av-hero/, "hidden from Today");
  assert.match(String(pack.slots!({} as never)["bino.face"]!({ place: "dock" })), /data-av="dock"/, "the Bino button keeps its face");
  assert.match(await (await get("/avatar")).text(), /name="today" value="hide" checked/);
  assert.equal((await post("/avatar/today", { mode: "still" }, { origin: "https://evil.example" })).status, 403);
  await post("/avatar/today", { mode: H });
  assert.match(await (await get("/avatar")).text(), /name="today" value="move" checked/, "anything unknown is moving");
  await post("/avatar/today", { mode: "hide" });
  await post("/avatar", { creature: "dino", today: "move" });
  assert.match(await (await get("/")).text(), /class="av-hero"/, "brought back from its page");
});

test("the animation suite: life on its own loops, a move per mood and scene, all stacked, none under reduced motion", () => {
  for (const k of ["av-look", "av-shut", "av-glint", "av-wag", "av-stretch", "av-read", "av-wiggle", "av-tilt", "av-droop", "av-dance", "av-shiver"]) {
    assert.match(AVATAR_CSS, new RegExp(`@keyframes ${k} \\{`), k);
    assert.match(AVATAR_CSS, new RegExp(`animation: [^;]*\\b${k} `), `${k} is used`);
  }
  // The new ones move with translate / rotate / scale, so they stack with the transform ones.
  for (const m of AVATAR_CSS.matchAll(/@keyframes av-(look|shut|glint|wag|stretch|read|wiggle|tilt|droop|dance|shiver) \{([^\n]*)\}/g)) assert.doesNotMatch(m[2]!, /transform:/, m[1]);
  // Still under reduced motion, unless Settings → Look → Motion says Always (data-motion on <html>).
  assert.match(AVATAR_CSS, /prefers-reduced-motion: reduce\) \{ :root:not\(\[data-motion="always"\]\) \.av, :root:not\(\[data-motion="always"\]\) \.av \* \{ animation: none !important; \}/);
  assert.match(AVATAR_JS, /const AV_STILL = document\.documentElement\.dataset\.motion !== "always" && matchMedia/);
});

test("without the avatar pack, the Bino button is the word and Today has no avatar", async () => {
  const today = await (await packApp([]).get("/")).text();
  assert.doesNotMatch(today, /av-hero|face-btn/);
});

test("the pack runs hosted too: nothing it needs is this machine's", () => {
  const { on, off } = activePacks([createAvatarPack()], { env: {}, bindings: {}, hosted: true });
  assert.deepEqual([on.length, off], [1, []]);
});

test("every class its views use is styled, by its own stylesheet or the core's", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { STYLE } = await import("dovre/ui/style.ts");
  const css = STYLE + AVATAR_PAGE_CSS + AVATAR_CSS;
  const dir = new URL("../", import.meta.url);
  const missing: string[] = [];
  for (const f of readdirSync(dir).filter((n: string) => n.endsWith(".ts"))) {
    for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(/class="([^"]*)"/g)) {
      for (const name of m[1]!.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean)) {
        if (/^[a-z][a-z0-9-]*$/.test(name) && !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css)) missing.push(`${name} (${f})`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("the avatar's script asks /avatar/now only for changes that move it, not while hidden, and one at a time", async () => {
  const on = new Map<string, ((e: { detail?: unknown }) => void)[]>();
  const doc = {
    hidden: false,
    documentElement: { dataset: {} },
    querySelector: (s: string) => (s === "img[data-av]" ? {} : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (e: { detail?: unknown }) => void) => on.set(t, [...(on.get(t) ?? []), f]),
  };
  let asked = 0;
  let answer: () => void = () => {};
  const fetch = () => {
    asked++;
    return new Promise((res) => (answer = () => res({ json: async () => ({ key: "k", why: [] }) })));
  };
  const win: { dovreOn?: unknown } = {};
  new Function("window", "document", ON_JS)(win, doc);
  const run = new Function("document", "fetch", "matchMedia", "sessionStorage", "location", "window", "setTimeout", "dovreOn", AVATAR_JS);
  run(doc, fetch, () => ({ matches: false }), { getItem: () => null, setItem() {} }, { href: "https://d.test/" }, {}, () => 0, win.dovreOn);
  const change = (detail: unknown) => on.get("dovre:change")!.forEach((f) => f({ detail }));
  const settle = () => new Promise((r) => setImmediate(r));

  change({ topics: [] });
  change({ topics: ["packs"] });
  change({ topics: ["run:abc", "bino:1"] });
  assert.equal(asked, 0, "a pack's refresh, a stream or a synced tick asks nothing");

  change({ topics: ["snapshot"] });
  change({ topics: ["avatar"] });
  change({ topics: ["mac"] });
  await settle();
  assert.equal(asked, 1, "one ask out at a time");
  answer();
  await settle();
  await settle();
  assert.equal(asked, 2, "changes while it was out share one ask after it");
  answer();
  await settle();
  await settle();
  assert.equal(asked, 2);

  doc.hidden = true;
  change({ topics: ["snapshot"] });
  change({ topics: ["snapshot"] });
  assert.equal(asked, 2, "a hidden tab waits");
  doc.hidden = false;
  on.get("visibilitychange")!.forEach((f) => f({}));
  await settle();
  assert.equal(asked, 3, "and asks once when shown");
});
