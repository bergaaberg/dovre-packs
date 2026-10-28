/**
 * Topo's map (dovre-packs#72): the repos as places by tier, what each uses drawn between them, and
 * its findings drawn on it. One model for every style: `topoModel` says what's there (places, their
 * findings and links, and what's off the map), and `drawMap` gives each place its spot for the style
 * (lanes, rings or terrain) and the background paths. Deterministic: the same read draws the same
 * map, so live refreshes don't move anything. Only numbers and paths here; the view writes the
 * names through `html`, which escapes them.
 */
import { KINDS, type Kind, runsIn } from "@bergaaberg/peak";
import type { Coverage } from "./catalog.ts";
import { CF_NAMES, type Drift, type Missing, type Orphan } from "./drift.ts";
import type { Finding } from "./rules.ts";
import type { TopoEntry, TopoRepo } from "./scan.ts";

export const STYLES = ["lanes", "rings", "terrain", "off"] as const;
export type MapStyle = (typeof STYLES)[number];

/** The TOPO_MAP setting: a style, else lanes (with the word, when it isn't a style). */
export function mapStyle(setting: string | undefined): { style: MapStyle; unknown?: string } {
  const w = (setting ?? "").trim().toLowerCase();
  if (!w) return { style: "lanes" };
  const style = STYLES.find((s) => s === w);
  return style ? { style } : { style: "lanes", unknown: w };
}

/** A finding on a place: declared and missing on Cloudflare (bad), or against a rule, or a file warning (warn). */
export type RepoFinding = { sev: "bad" | "warn"; tag: string; why: string; fix: string; /** The used repo it's about (`owner/name`). */ uses?: string };

export type Glyph = { kind: Kind; miss: boolean };

export type Place = {
  /** `owner/name`, or the checkout's name, lowercased: the page's `at`. */
  key: string;
  entry: TopoEntry;
  /** 0 active, 1 maintained, 2 scratch and any other tier. */
  band: 0 | 1 | 2;
  deprecated: boolean;
  /** Bad first. */
  findings: RepoFinding[];
  /** What it runs in production, then what's missing in other environments. */
  glyphs: Glyph[];
  /** What it declares on Cloudflare that isn't there. */
  missing: Missing[];
  /** The places it uses, by key. */
  uses: string[];
  services: string[];
  usedBy: string[];
  /** The orphans whose names look like this repo's, by key. */
  looks: string[];
};

/** Off the map: something on Cloudflare no file claims, or a followed repo without a usable peak.yaml. */
export type Off =
  | { key: string; what: "orphan"; orphan: Orphan; /** The place whose name it looks like. */ like?: string }
  | { key: string; what: "bare" | "problems"; repo: Coverage };

export type TopoModel = { places: Place[]; off: Off[] };

export const keyOf = (r: TopoRepo) => (r.full ?? r.repo).toLowerCase();
const short = (s: string) => s.replace(/^.*\//, "").toLowerCase();
export const orphanKey = (o: Orphan) => `cf:${o.kind}:${o.worker ? `${o.worker}/` : ""}${o.name}`;
const CHECK = "npx github:bergaaberg/peak check";

function missingFinding(m: Missing): RepoFinding {
  const what = `${CF_NAMES[m.kind][0]} ${m.worker ? `${m.worker}/` : ""}${m.name}`;
  return {
    sev: "bad",
    tag: "missing",
    why: `Declares ${what} for ${m.envs.join(", ")}, but Cloudflare has none.`,
    fix: m.kind === "objects" ? `Deploy the class on ${m.worker}, or drop it from objects.` : "Create it on Cloudflare, or remove it from the file.",
  };
}

function glyphsOf(entry: TopoEntry, missing: Missing[]): Glyph[] {
  const prod = runsIn(entry.peak);
  const out: Glyph[] = [];
  const shown = new Set<Missing>();
  for (const kind of KINDS) {
    for (const r of prod[kind] ?? []) {
      const m = missing.find((x) => x.kind === kind && x.name === r.name && x.envs.includes("production"));
      if (m) shown.add(m);
      out.push({ kind, miss: !!m });
    }
  }
  for (const m of missing) if (!shown.has(m)) out.push({ kind: m.kind === "objects" ? "workers" : m.kind, miss: true });
  return out;
}

const bandOf = (tier: string | undefined): 0 | 1 | 2 => {
  const t = (tier ?? "").toLowerCase();
  return t === "active" ? 0 : t === "maintained" ? 1 : 2;
};

/** The place an orphan's name looks like: the longest repo name it starts with, up to a separator. */
function lookalike(places: Place[], o: Orphan): string | undefined {
  const name = (o.worker ?? o.name).toLowerCase();
  let best: { key: string; n: number } | undefined;
  for (const p of places) {
    for (const n of new Set([short(p.entry.repo), p.entry.peak.name.toLowerCase()])) {
      if (n.length < 2 || !name.startsWith(n) || !(name.length === n.length || /[-_.]/.test(name[n.length]!))) continue;
      if (!best || n.length > best.n) best = { key: p.key, n: n.length };
    }
  }
  return best?.key;
}

export function topoModel(o: { entries: TopoEntry[]; coverage?: Coverage[]; findings?: Finding[]; drift?: Drift }): TopoModel {
  const coverage = o.coverage ?? [];
  const byKey = <T extends TopoRepo>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) m.set(keyOf(x), [...(m.get(keyOf(x)) ?? []), x]);
    return m;
  };
  const missing = byKey(o.drift?.missing ?? []);
  const rules = byKey(o.findings ?? []);
  const warnings = byKey(coverage.filter((c) => c.kind === "warnings"));

  const byFull = new Map<string, string>();
  const byShort = new Map<string, string>();
  for (const e of o.entries) {
    if (e.full) byFull.set(e.full.toLowerCase(), keyOf(e));
    else byShort.set(short(e.repo), keyOf(e));
  }

  const places: Place[] = o.entries.map((entry) => {
    const key = keyOf(entry);
    const miss = missing.get(key) ?? [];
    const findings: RepoFinding[] = [
      ...miss.map(missingFinding),
      ...(rules.get(key) ?? []).map((f): RepoFinding => ({ sev: "warn", tag: `rule: ${f.rule}`, why: f.why, fix: f.fix, ...(f.uses ? { uses: f.uses } : {}) })),
      ...(warnings.get(key) ?? []).map((c): RepoFinding => ({ sev: "warn", tag: "warnings", why: c.lines.join(" "), fix: `Fix them, then run ${CHECK}.` })),
    ];
    const uses: string[] = [];
    const services: string[] = [];
    for (const u of entry.peak.uses ?? []) {
      if ("service" in u) {
        if (!services.includes(u.service)) services.push(u.service);
        continue;
      }
      const to = byFull.get(u.repo.toLowerCase()) ?? byShort.get(short(u.repo));
      if (to && to !== key && !uses.includes(to)) uses.push(to);
    }
    const tier = (entry.peak.tier ?? "").toLowerCase();
    return { key, entry, band: bandOf(tier), deprecated: tier === "deprecated", findings, glyphs: glyphsOf(entry, miss), missing: miss, uses, services, usedBy: [], looks: [] };
  });

  const at = new Map(places.map((p) => [p.key, p]));
  for (const p of places) for (const k of p.uses) at.get(k)?.usedBy.push(p.key);

  const off: Off[] = [
    ...coverage.filter((c) => c.kind === "problems").map((repo): Off => ({ key: keyOf(repo), what: "problems", repo })),
    ...coverage.filter((c) => c.kind === "uncataloged").map((repo): Off => ({ key: keyOf(repo), what: "bare", repo })),
    ...(o.drift?.orphans ?? []).map((orphan): Off => {
      const key = orphanKey(orphan);
      const like = lookalike(places, orphan);
      if (like) at.get(like)!.looks.push(key);
      return { key, what: "orphan", orphan, ...(like ? { like } : {}) };
    }),
  ];
  return { places, off };
}

// ── Drawing ────────────────────────────────────────────────────────────────

/** The map's width in SVG units (about pixels on a desktop). */
export const W = 880;
const MAP_H = 470;
const STRIP_H = 100;
/** From this many repos on, quiet ones (no links, no findings) fold into their tier's label. */
export const FOLD_AT = 30;
/** At most this many services are drawn along the top. */
const MAX_SERVICES = 8;

export const quiet = (p: Place) => !p.uses.length && !p.services.length && !p.usedBy.length && !p.findings.length && !p.looks.length;

export type Spot = { place: Place; x: number; y: number };
export type Chip = { off: Off; x: number; y: number; w: number };
type Trail = { d: string; ar: string };

export type Picture = {
  w: number;
  h: number;
  /** Tier areas, active first, and the contour lines. */
  bands: [string, string, string];
  index: string;
  minor: string;
  /** The off-the-map strip's ground and edge (empty when nothing's off the map). */
  shore: string;
  coast: string;
  labels: { text: string; x: number; y: number; start: boolean }[];
  /** `uses` paths with arrowheads: plain, the picked place's, and ones a finding is about. */
  trails: Record<"plain" | "hot" | "warn", Trail>;
  /** Dotted lines from an orphan to the place it looks like. */
  hints: { plain: string; hot: string };
  spots: Spot[];
  services: { name: string; x: number; y: number; hot: boolean }[];
  chips: Chip[];
  /** Off-the-map items there was no room for. */
  more: number;
  folded: Place[];
};

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
/** Approximate width of monospace text: the map's text is in --mono. */
export const textW = (s: string, size: number) => s.length * size * 0.6;
/** A label that fits: long names end in an ellipsis (the full name is in the link's label). */
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Each band's places, ordered so linked places sit near each other (a barycentre pass per band). */
function arrange(drawn: Place[]): Place[][] {
  const bands: Place[][] = [[], [], []];
  for (const p of drawn) bands[p.band]!.push(p);
  const byKey = (a: Place, b: Place) => a.key.localeCompare(b.key);
  for (const b of bands) b.sort(byKey);
  const at = new Map<string, number>();
  const set = (b: Place[]) => b.forEach((p, i) => at.set(p.key, (i + 0.5) / b.length));
  const resort = (b: Place[]) => {
    const score = new Map(
      b.map((p, i) => {
        const near = [...p.uses, ...p.usedBy].map((k) => at.get(k)).filter((v): v is number => v !== undefined);
        return [p.key, near.length ? near.reduce((a, v) => a + v, 0) / near.length : (i + 0.5) / b.length];
      }),
    );
    b.sort((a, c) => score.get(a.key)! - score.get(c.key)! || byKey(a, c));
    set(b);
  };
  set(bands[0]!);
  resort(bands[1]!);
  resort(bands[2]!);
  resort(bands[0]!);
  return bands;
}

const LANES = [0, 150, 300];
const LANE_X0 = 40;
const LANE_X1 = 840;

function lanes(bands: Place[][]): Spot[] {
  return bands.flatMap((b, band) => {
    const rows = Math.min(3, Math.ceil(b.length / 8));
    return b.map((place, i) => ({ place, x: LANE_X0 + ((i + 0.5) * (LANE_X1 - LANE_X0)) / b.length, y: LANES[band]! + 70 + ((i % rows) - (rows - 1) / 2) * 40 }));
  });
}

const CX = 440;
const CY = 228;
const RX = 380;
const RY = 188;
/** Each band's ring, and the two it splits into when one is too full. */
const RINGS: { one: number; two: [number, number]; start: number }[] = [
  { one: 0.2, two: [0.15, 0.3], start: -90 },
  { one: 0.54, two: [0.47, 0.62], start: -75 },
  { one: 0.85, two: [0.78, 0.93], start: -60 },
];

function ringPoint(t: number, deg: number, terrain: boolean): [number, number] {
  const a = (deg * Math.PI) / 180;
  const f = terrain ? 1 + 0.07 * Math.sin(3 * a + 0.6) + 0.04 * Math.sin(5 * a + 2.1) + 0.03 * Math.sin(2 * a + 1.3) : 1;
  return [CX + RX * t * f * Math.cos(a), CY + RY * t * f * Math.sin(a)];
}

function ring(t: number, terrain: boolean): string {
  let d = "";
  for (let i = 0; i < 120; i++) {
    const [x, y] = ringPoint(t, i * 3, terrain);
    d += `${i ? "L" : "M"}${f1(x)} ${f1(y)} `;
  }
  return `${d}Z `;
}

function rings(bands: Place[][], terrain: boolean): Spot[] {
  return bands.flatMap((b, band) => {
    const r = RINGS[band]!;
    if (band === 0 && b.length === 1) return [{ place: b[0]!, x: CX, y: CY }];
    // About one place per 95 units of ring.
    const radii = b.length <= Math.floor((1784 * r.one) / 95) ? [r.one] : r.two;
    return b.map((place, i) => {
      const [x, y] = ringPoint(radii[i % radii.length]!, r.start + (i * 360) / b.length, terrain);
      return { place, x, y };
    });
  });
}

/** A `uses` path from a to b: a gentle curve, stopping short of b, with an arrowhead. */
function trail(t: Trail, a: [number, number], b: [number, number], pad: number) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const s = [a[0] + ux * 9, a[1] + uy * 9];
  const e = [b[0] - ux * pad, b[1] - uy * pad];
  const c = [(s[0]! + e[0]!) / 2 - uy * len * 0.16, (s[1]! + e[1]!) / 2 + ux * len * 0.16];
  let tx = e[0]! - c[0]!;
  let ty = e[1]! - c[1]!;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const bx = e[0]! - tx * 7;
  const by = e[1]! - ty * 7;
  t.d += `M${f1(s[0]!)} ${f1(s[1]!)} Q${f1(c[0]!)} ${f1(c[1]!)} ${f1(e[0]!)} ${f1(e[1]!)} `;
  t.ar += `M${f1(e[0]!)} ${f1(e[1]!)} L${f1(bx - ty * 3.5)} ${f1(by + tx * 3.5)} L${f1(bx + ty * 3.5)} ${f1(by - tx * 3.5)} Z `;
}

/** What an off-the-map chip says after its name. */
export function offKind(o: Off): string {
  if (o.what !== "orphan") return o.what === "bare" ? "no peak.yaml" : "unreadable";
  return CF_NAMES[o.orphan.kind][0].replace(/^(D1|KV|R2) /, "");
}
export const offName = (o: Off) => (o.what === "orphan" ? `${o.orphan.worker ? `${o.orphan.worker}/` : ""}${o.orphan.name}` : (o.repo.full ?? o.repo.repo));

const CHIP_ROWS = [MAP_H + 42, MAP_H + 74];
/** The width of an off-the-map chip: glyph, name and kind. */
export const chipW = (o: Off) => 30 + textW(clip(offName(o), 28), 10.5) + textW(offKind(o), 9.5);

const TIER_NAMES = ["ACTIVE", "MAINTAINED"];

export function drawMap(model: TopoModel, style: Exclude<MapStyle, "off">, at?: string): Picture {
  const fold = model.places.length >= FOLD_AT;
  const folded = fold ? model.places.filter((p) => quiet(p) && p.key !== at) : [];
  const drawn = fold ? model.places.filter((p) => !folded.includes(p)) : model.places;
  const bands = arrange(drawn);
  const terrain = style === "terrain";
  const spots = style === "lanes" ? lanes(bands) : rings(bands, terrain);
  const pos = new Map(spots.map((s) => [s.place.key, s]));
  const offs = model.off;
  const h = offs.length ? MAP_H + STRIP_H : MAP_H;

  // Background.
  let bg: Pick<Picture, "bands" | "index" | "minor">;
  if (style === "lanes") {
    bg = { bands: [`M0 0 H${W} V150 H0 Z`, `M0 150 H${W} V300 H0 Z`, `M0 300 H${W} V${MAP_H} H0 Z`], index: `M0 150 H${W} M0 300 H${W}`, minor: "" };
  } else {
    bg = {
      bands: [ring(0.38, terrain), ring(0.7, terrain) + ring(0.38, terrain), ring(1, terrain) + ring(0.7, terrain)],
      index: ring(0.38, terrain) + ring(0.7, terrain) + ring(1, terrain),
      minor: terrain ? [0.13, 0.26, 0.5, 0.6, 0.8, 0.9].map((t) => ring(t, true)).join("") : "",
    };
  }
  let coast = "";
  let shore = "";
  if (offs.length) {
    coast = `M0 ${MAP_H - 6} `;
    for (let x = 20; x <= W; x += 20) coast += `L${x} ${f1(MAP_H - 6 + 3 * Math.sin(x / 37) + 2 * Math.sin(x / 13))} `;
    shore = `${coast}L${W} ${h} L0 ${h} Z`;
  }

  // Tier labels, with how many quiet places each holds.
  const others = [...new Set(model.places.filter((p) => p.band === 2).map((p) => (p.entry.peak.tier ?? "").toUpperCase()).filter(Boolean))].sort();
  const names = [...TIER_NAMES, clip(others.length ? others.join(" · ") : "SCRATCH", 40)];
  const labels = names.map((name, band) => {
    const q = folded.filter((p) => p.band === band).length;
    const text = q ? `${name} · +${q} QUIET` : name;
    if (style === "lanes") return { text, x: 18, y: LANES[band]! + 24, start: true };
    const [x, y] = ringPoint([0.38, 0.7, 1][band]!, 250 + band * 2, terrain);
    return { text, x: Math.round(x), y: Math.round(band === 2 ? y + 14 : y - 4), start: false };
  });

  // Services along the top, then the uses paths.
  const used = [...new Set(drawn.flatMap((p) => p.services))].sort().slice(0, MAX_SERVICES);
  const services = used.map((name, i) => ({
    name,
    x: Math.round(200 + ((i + 0.5) * 640) / used.length),
    y: 14,
    hot: !!at && drawn.some((p) => p.key === at && p.services.includes(name)),
  }));
  const trails: Picture["trails"] = { plain: { d: "", ar: "" }, hot: { d: "", ar: "" }, warn: { d: "", ar: "" } };
  for (const s of spots) {
    const p = s.place;
    for (const k of p.uses) {
      const to = pos.get(k);
      if (!to) continue;
      const warn = p.findings.some((f) => f.uses && keyOfFull(f.uses, to.place));
      trail(trails[warn ? "warn" : p.key === at || k === at ? "hot" : "plain"], [s.x, s.y], [to.x, to.y], 12);
    }
    for (const name of p.services) {
      const v = services.find((x) => x.name === name);
      if (v) trail(trails[p.key === at ? "hot" : "plain"], [s.x, s.y], [v.x, v.y + 10], 2);
    }
  }

  // The off-the-map strip: chips left to right in two rows, and hints to their look-alikes.
  const chips: Chip[] = [];
  let row = 0;
  let x = 18;
  let more = 0;
  for (const o of offs) {
    const w = chipW(o);
    if (x + w > W - 18 && row < CHIP_ROWS.length) {
      row++;
      x = 18;
    }
    if (row >= CHIP_ROWS.length) {
      more++;
      continue;
    }
    chips.push({ off: o, x, y: CHIP_ROWS[row]!, w });
    x += w + 10;
  }
  const hints = { plain: "", hot: "" };
  for (const c of chips) {
    const like = c.off.what === "orphan" && c.off.like ? pos.get(c.off.like) : undefined;
    if (!like) continue;
    const d = `M${f1(c.x + c.w / 2)} ${c.y - 11} L${f1(like.x)} ${f1(like.y + 32)} `;
    if (at && (at === c.off.key || at === like.place.key)) hints.hot += d;
    else hints.plain += d;
  }

  return { w: W, h, ...bg, shore, coast, labels, trails, hints, spots, services, chips, more, folded };
}

/** A `uses` finding's repo (`owner/name`) is this place. */
const keyOfFull = (full: string, p: Place) => (p.entry.full ? p.entry.full.toLowerCase() === full.toLowerCase() : short(p.entry.repo) === short(full));
