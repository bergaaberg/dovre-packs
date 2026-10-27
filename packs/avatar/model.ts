/**
 * Avatars: a voxel creature per person, shaped by what they do on GHE. Pure: stats and a look in,
 * voxels out (./iso.ts draws them). Everything the drawing holds is numbers and colours
 * from the fixed palettes here, so nothing a person types reaches the SVG.
 *
 * A look picks a creature (the binocular dino is one; a fox, an owl, a troll), its colours, its
 * finish (the dino's binoculars, the others' eyes and metal) and which extras show. Every creature
 * has the same slots, so the same numbers shape any of them:
 *   PRs merged → a ridge along the back (the dino's plates, the fox's tufts, the owl's crest, the troll's moss)
 *   reviews given → bigger, brighter eyes (or lenses), a badge on the chest from 60
 *   active repos → patches on the backpack
 *   languages → the scarf's stripes
 *   days in a row with a commit → a summit flag, taller with the streak
 *   commits after 20:00 → a headlamp
 * Voxels carry a part, so a drawing can move the head, wag the tail or light the eyes on its own.
 */

import type { Situation } from "./mood.ts";

/** What GHE says about someone over the last 12 weeks (./stats.ts). */
export type AvatarStats = { prs: number; reviews: number; repos: number; streak: number; night: number; langs: string[] };

export const CREATURES = { dino: "Dino", fox: "Fox", owl: "Owl", troll: "Troll" } as const;
export type Creature = keyof typeof CREATURES;

type Palette = { label: string; body: string; belly: string; ridge: string; claw: string };
export const BODIES: Record<string, Palette> = {
  moss: { label: "Moss", body: "#5f8a4a", belly: "#b3cc93", ridge: "#e3b452", claw: "#efe6cf" },
  fjord: { label: "Fjord", body: "#3f6f93", belly: "#a9c8de", ridge: "#eda05c", claw: "#efe6cf" },
  lingon: { label: "Lingon", body: "#a8434d", belly: "#e8b2aa", ridge: "#f1d27a", claw: "#f3ead6" },
  granite: { label: "Granite", body: "#6c7a86", belly: "#c1cad1", ridge: "#84b9df", claw: "#eef0f2" },
  heather: { label: "Heather", body: "#7d5f9e", belly: "#cdb9e0", ridge: "#9fd6c2", claw: "#f1ecf6" },
  rust: { label: "Rust", body: "#c0602f", belly: "#f1dcc0", ridge: "#5b3a24", claw: "#2a2420" },
  snow: { label: "Snow", body: "#d9e1e7", belly: "#ffffff", ridge: "#8c9aa5", claw: "#3b4650" },
};
type Finish = { label: string; barrel: string; grip: string; metal: string; ring: string; eye: string };
export const FINISHES: Record<string, Finish> = {
  brass: { label: "Brass", barrel: "#2f3338", grip: "#1d2024", metal: "#c49237", ring: "#e6bf5f", eye: "#ffd36b" },
  gunmetal: { label: "Gunmetal", barrel: "#3d4650", grip: "#262c33", metal: "#7f8c98", ring: "#b7c3cd", eye: "#9fd6ff" },
  enamel: { label: "Enamel", barrel: "#2f5f86", grip: "#1e3d57", metal: "#c9d7e1", ring: "#eef3f6", eye: "#b5f0d8" },
};
/** Languages GHE names, as scarf stripes; any other is grey. */
export const LANGS: Record<string, string> = {
  "C#": "#2f9e3f", TypeScript: "#3178c6", JavaScript: "#e9d44d", SQL: "#e38c00", TSQL: "#e38c00", Python: "#f2cf4a", Go: "#00add8",
  PowerShell: "#5391fe", Bicep: "#7fc1d9", Kotlin: "#a97bff", Java: "#b07219", HTML: "#e34c26", CSS: "#663399", Shell: "#89e051", Dockerfile: "#384d54",
};
export const EXTRAS = { strap: "Neck strap", scarf: "Scarf", pack: "Backpack", ridge: "Back ridge", flag: "Summit flag", lamp: "Headlamp", badge: "Review badge" } as const;
export type Extra = keyof typeof EXTRAS;

export type Look = { creature: Creature; body: string; finish: string; show: Record<Extra, boolean> };
export const DEFAULT_LOOK: Look = { creature: "dino", body: "moss", finish: "brass", show: { strap: true, scarf: true, pack: true, ridge: true, flag: true, lamp: true, badge: true } };

/** A look read narrowly: anything unknown falls back to the default. */
export function lookOf(v: unknown): Look {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const pick = <T extends string>(x: unknown, keys: readonly T[], d: T): T => (keys.includes(x as T) ? (x as T) : d);
  const show = (o.show && typeof o.show === "object" ? o.show : {}) as Record<string, unknown>;
  return {
    creature: pick(o.creature, Object.keys(CREATURES) as Creature[], DEFAULT_LOOK.creature),
    body: pick(o.body, Object.keys(BODIES), DEFAULT_LOOK.body),
    finish: pick(o.finish, Object.keys(FINISHES), DEFAULT_LOOK.finish),
    show: Object.fromEntries((Object.keys(EXTRAS) as Extra[]).map((k) => [k, typeof show[k] === "boolean" ? show[k] : DEFAULT_LOOK.show[k]])) as Record<Extra, boolean>,
  };
}

/** Stats read narrowly: whole numbers in range, at most four known-shaped language names. */
export function statsOf(v: unknown): AvatarStats {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, max: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(max, Math.round(x))) : 0);
  const langs = Array.isArray(o.langs) ? o.langs.filter((l): l is string => typeof l === "string" && /^[\w#+. -]{1,30}$/.test(l)).slice(0, 4) : [];
  return { prs: n(o.prs, 999), reviews: n(o.reviews, 999), repos: n(o.repos, 99), streak: n(o.streak, 365), night: n(o.night, 100), langs };
}

/** Stats → what they change (pure; the crafting page explains the same numbers). */
export function traits(s: AvatarStats) {
  return {
    ridge: s.prs === 0 ? 0 : Math.min(9, Math.max(1, Math.round(s.prs / 7))),
    ridgeH: s.prs >= 50 ? 3 : s.prs >= 20 ? 2 : 1,
    lensR: 1.45 + Math.min(1, s.reviews / 120) * 0.6,
    glow: 0.35 + Math.min(1, s.reviews / 120) * 0.65,
    badge: s.reviews >= 60,
    patches: Math.min(9, s.repos),
    flagH: s.streak >= 3 ? Math.min(12, 3 + Math.floor(s.streak / 3)) : 0,
    lamp: s.night >= 25 ? Math.min(1, s.night / 70) : 0,
    langs: s.langs.slice(0, 4),
  };
}
export type Traits = ReturnType<typeof traits>;

/** What each number does, in words, for the crafting page. */
export function effects(s: AvatarStats, t: Traits = traits(s)): Record<"prs" | "reviews" | "repos" | "streak" | "night" | "langs", string> {
  return {
    prs: t.ridge ? `${t.ridge} on the back ridge, ${["", "low", "medium", "tall"][t.ridgeH]}` : "No ridge yet",
    reviews: `Eyes ${t.lensR >= 1.95 ? "wide" : t.lensR >= 1.7 ? "larger" : "standard"}, ${Math.round(t.glow * 100)} % glow${t.badge ? ", a review badge on the chest" : ""}`,
    repos: t.patches ? `${t.patches} patch${t.patches > 1 ? "es" : ""} on the backpack` : "An empty backpack",
    streak: t.flagH ? `A flag on a pole ${t.flagH} high` : "No flag below 3 days",
    night: t.lamp ? `Headlamp on, ${Math.round(t.lamp * 100)} % bright` : "No headlamp below 25 %",
    langs: t.langs.length ? `A scarf in ${t.langs.join(", ")}` : "A grey scarf",
  };
}

/**
 * The parts a drawing moves on their own. Layers are drawn in order (`under` the creature: the
 * ground, the sky, flames and drones behind it; then its `back`, `body`, `head`; then `over`:
 * what's in front of it), each over a complete layer under it, so a part can move without leaving holes.
 */
export const LAYERS = ["under", "back", "body", "head", "over"] as const;
export type Layer = (typeof LAYERS)[number];
export const PARTS = ["ground", "sky", "fire", "tail", "flag", "back", "body", "head", "lensL", "lensR", "lamp", "beacon", "cloud", "rain", "confetti", "drone1", "drone2", "drone3", "steam"] as const;
export type Part = (typeof PARTS)[number];
export const LAYER: Record<Part, Layer> = {
  ground: "under", sky: "under", fire: "under", tail: "back", flag: "back", back: "back", body: "body", head: "head", lensL: "head", lensR: "head", lamp: "head", beacon: "head",
  cloud: "over", rain: "over", confetti: "over", drone1: "over", drone2: "over", drone3: "over", steam: "over",
};

/** `layer`: where a scene voxel goes when it isn't its part's (a flame in front of the creature is `over`). */
export type Voxel = { x: number; y: number; z: number; c: string; part: Part; glow?: boolean; layer?: Layer };
export const layerOf = (v: Voxel): Layer => v.layer ?? LAYER[v.part];

/** Where a creature's shared extras go. */
type Anchors = {
  /** The neck: centre, radius and the two rows a scarf takes. */
  neck: { y: number; z: number; r: number };
  /** The spine the ridge follows: z from `from` back to `to`, on top of x = 0. */
  spine: { from: number; to: number };
  /** The back the pack sits on: its top row and centre. */
  pack: { top: number; y: number; z: number; r: number };
  /** The forehead's height, where a headlamp goes. */
  brow: { y: number };
  chest: { y: number; z: number };
  /** Where the strap hangs from (the eyes' outer edge), when there's one. */
  strapFrom?: { x: number; y: number; z: number };
};

class Grid {
  m = new Map<string, Voxel>();
  put(x: number, y: number, z: number, c: string, part: Part, glow = false, layer?: Layer) {
    const k = `${x},${y},${z}`;
    const v: Voxel = { x, y, z, c, part };
    if (glow) v.glow = true;
    if (layer) v.layer = layer;
    this.m.set(k, v);
  }
  has(x: number, y: number, z: number) {
    return this.m.has(`${x},${y},${z}`);
  }
  ell(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, col: (x: number, y: number, z: number) => string, part: Part) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1) this.put(x, y, z, col(x, y, z), part);
  }
  ring(y: number, cz: number, r: number, c: (a: number) => string, part: Part, keep = false) {
    for (let a = 0; a < 64; a++) {
      const ang = (a / 64) * Math.PI * 2;
      const x = Math.round(Math.cos(ang) * r), z = Math.round(cz + Math.sin(ang) * r);
      if (keep && this.has(x, y, z)) continue;
      this.put(x, y, z, c(ang), part);
    }
  }
}

// ── The creatures: each draws its body, head and eyes, and says where the extras go ──

function dino(g: Grid, B: Palette, F: Finish, t: Traits): Anchors {
  const skin = (_x: number, y: number, z: number) => (z >= 2 && y <= 8.5 ? B.belly : B.body);
  g.ell(0, 7, -1, 4.2, 4.2, 5, skin, "body");
  for (const s of [-1, 1]) {
    g.ell(s * 2.7, 4.2, -1, 1.8, 2.4, 2.3, () => B.body, "body");
    for (let y = 0; y <= 2; y++) for (let z = -2; z <= 0; z++) for (const x of [s * 2, s * 3]) g.put(x, y, z, B.body, "body");
    for (let z = 1; z <= 2; z++) for (const x of [s * 2, s * 3]) g.put(x, 0, z, B.body, "body");
    for (const x of [s * 2, s * 3]) g.put(x, 0, 3, B.claw, "body");
  }
  for (let i = 0; i < 10; i++) {
    const r = 2.6 - i * 0.22;
    g.ell(0, 6.6 - i * 0.42, -5 - i, Math.max(0.6, r), Math.max(0.6, r * 0.85), 0.75, () => B.body, i < 2 ? "body" : "tail");
  }
  g.ell(0, 10.6, 1.4, 2.6, 2.6, 2.6, skin, "head");
  g.ell(0, 13, 2.4, 3.2, 2.8, 3.4, (_x, y) => (y <= 11 ? B.belly : B.body), "head");
  for (let x = -2; x <= 2; x++) for (let z = 2; z <= 6; z++) g.put(x, 10, z, B.belly, "head");
  for (let x = -2; x <= 2; x++) g.put(x, 11, 6, x % 2 === 0 ? B.claw : "#2a1d1d", "head");
  for (const s of [-1, 1]) {
    g.put(s * 3, 8, 3, B.body, "body");
    g.put(s * 3, 8, 4, B.body, "body");
    g.put(s * 3, 7, 4, B.claw, "body");
  }
  // Binoculars: the eyes and the snout. Wider and brighter with more reviews.
  const r = t.lensR, off = r >= 2 ? 3 : 2, front = 9, back = 3;
  for (const s of [-1, 1]) {
    for (let dx = -3; dx <= 3; dx++)
      for (let dy = -3; dy <= 3; dy++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const edge = d2 > (r - 1) * (r - 1);
        for (let z = back; z <= front; z++) {
          const x = s * off + dx, y = 14 + dy;
          if (z === front) edge ? g.put(x, y, z, F.ring, "head") : g.put(x, y, z, "#9fd6ff", s < 0 ? "lensL" : "lensR", true);
          else g.put(x, y, z, z === 6 ? F.grip : z === back + 1 && edge ? F.ring : F.barrel, "head");
        }
      }
  }
  for (let x = -off + 1; x <= off - 1; x++) for (let z = 5; z <= 6; z++) g.put(x, 14, z, F.metal, "head");
  for (let z = 5; z <= 6; z++) g.put(0, 15 + (off - 2), z, F.ring, "head");
  return {
    neck: { y: 8, z: 1.2, r: 3.6 },
    spine: { from: 1, to: -10 },
    pack: { top: 11, y: 7, z: -1, r: 4.2 },
    brow: { y: 15 },
    chest: { y: 8, z: 4 },
    strapFrom: { x: off + Math.ceil(r), y: 13, z: 4 },
  };
}

/** Plain round eyes for the creatures without binoculars: bigger and brighter with reviews. */
function eyes(g: Grid, F: Finish, t: Traits, o: { y: number; z: number; off: number; scale?: number }) {
  const r = Math.max(0.9, (t.lensR - 0.45) * (o.scale ?? 1));
  for (const s of [-1, 1])
    for (let dx = -3; dx <= 3; dx++)
      for (let dy = -3; dy <= 3; dy++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const edge = r >= 1.6 && d2 > (r - 1) * (r - 1);
        const x = s * o.off + dx, y = o.y + dy;
        if (edge) g.put(x, y, o.z, F.ring, "head");
        else g.put(x, y, o.z, F.eye, s < 0 ? "lensL" : "lensR", true);
        g.put(x, y, o.z - 1, "#1a1d22", "head");
      }
}

function fox(g: Grid, B: Palette, F: Finish, t: Traits): Anchors {
  const skin = (_x: number, y: number, z: number) => (z >= 1 && y <= 8 ? B.belly : B.body);
  g.ell(0, 6.5, -1, 3.6, 4.4, 4.2, skin, "body");
  for (const s of [-1, 1]) {
    g.ell(s * 2.4, 3.6, -1.5, 1.6, 2.2, 2.4, () => B.body, "body");
    for (let y = 0; y <= 2; y++) for (const x of [s * 1, s * 2]) g.put(x, y, 2, B.body, "body");
    for (const x of [s * 1, s * 2]) {
      g.put(x, 0, 3, B.claw, "body");
      g.put(x, 0, -3, B.claw, "body");
    }
  }
  // The tail: big and bushy, with a pale tip.
  for (let i = 0; i < 9; i++) {
    const r = 1.4 + Math.sin((i / 8) * Math.PI) * 1.6;
    g.ell(0, 3 + i * 0.75, -5 - i * 0.55, r, r, 1.2, () => (i >= 7 ? B.belly : B.body), i < 1 ? "body" : "tail");
  }
  // Head with a snout and pointed ears.
  g.ell(0, 12.5, 1.5, 3.4, 3, 3, (_x, y, z) => (y <= 11.5 && z >= 2 ? B.belly : B.body), "head");
  for (let z = 4; z <= 7; z++) for (let x = -1; x <= 1; x++) for (let y = 10; y <= 12 - (z >= 6 ? 1 : 0); y++) g.put(x, y, z, z === 7 && y === 11 && x === 0 ? "#1a1d22" : y <= 10 || x !== 0 ? B.belly : B.body, "head");
  g.put(0, 11, 8, "#1a1d22", "head");
  for (const s of [-1, 1])
    for (let h = 0; h < 4; h++)
      for (let w = 0; w < 3 - Math.floor(h / 1.5); w++) g.put(s * (2 + w), 15 + h, 1, h >= 2 ? "#2a2420" : B.body, "head");
  eyes(g, F, t, { y: 13, z: 5, off: 2, scale: 0.7 });
  return {
    neck: { y: 9, z: 0.8, r: 3.2 },
    spine: { from: 0, to: -4 },
    pack: { top: 10, y: 6.5, z: -1, r: 3.8 },
    brow: { y: 14 },
    chest: { y: 7, z: 3 },
  };
}

function owl(g: Grid, B: Palette, F: Finish, t: Traits): Anchors {
  const skin = (x: number, y: number, z: number) => (z >= 2 && Math.abs(x) <= 2 && y <= 10 ? B.belly : B.body);
  g.ell(0, 6.5, 0, 4.4, 5.6, 4, skin, "body");
  // Wings folded at the sides, a little darker at the tips.
  for (const s of [-1, 1]) g.ell(s * 4.4, 6.5, -0.5, 1.2, 4.2, 3, (_x, y) => (y <= 3 ? B.ridge : B.body), "body");
  for (const s of [-1, 1]) for (const dx of [0, 1]) for (let z = 1; z <= 3; z++) g.put(s * (1 + dx), 0, z, F.metal, "body");
  // A short tail.
  for (let x = -1; x <= 1; x++) for (let y = 1; y <= 3; y++) g.put(x, y, -4, B.body, "tail");
  // Head: wide, with ear tufts and a beak.
  g.ell(0, 14, 0.5, 4.6, 3.6, 3.6, (x, y, z) => (z >= 2 && y <= 15 ? B.belly : B.body), "head");
  for (const s of [-1, 1]) for (let h = 0; h < 3; h++) g.put(s * (3 + Math.floor(h / 2)), 17 + h, 0, B.body, "head");
  g.put(0, 13, 5, F.metal, "head");
  g.put(0, 12, 5, F.metal, "head");
  g.put(0, 12, 4, F.metal, "head");
  eyes(g, F, t, { y: 14, z: 4, off: 2, scale: 1.25 });
  return {
    neck: { y: 10, z: 0.2, r: 3.9 },
    spine: { from: 3, to: -1 },
    pack: { top: 11, y: 6.5, z: 0, r: 4.2 },
    brow: { y: 16 },
    chest: { y: 8, z: 4 },
  };
}

function troll(g: Grid, B: Palette, F: Finish, t: Traits): Anchors {
  const skin = (_x: number, y: number, z: number) => (z >= 2 && y <= 9 && y >= 4 ? B.belly : B.body);
  g.ell(0, 7, 0, 4.4, 4.6, 3.6, skin, "body");
  for (const s of [-1, 1]) {
    for (let y = 0; y <= 3; y++) for (const x of [s * 1, s * 2, s * 3]) for (let z = -1; z <= 1; z++) g.put(x, y, z, y === 0 ? B.claw : B.body, "body");
    // Long arms hanging to the knees.
    for (let y = 3; y <= 9; y++) g.put(s * 5, y, 0, B.body, "body");
    g.put(s * 5, 2, 1, B.claw, "body");
    g.put(s * 5, 2, 0, B.body, "body");
  }
  // A thin tail with a tuft.
  for (let i = 0; i < 5; i++) g.put(0, 3 + Math.round(i * 0.4), -4 - i, B.body, "tail");
  for (let dy = 0; dy <= 1; dy++) for (const dx of [-1, 0, 1]) g.put(dx, 5 + dy, -9, B.ridge, "tail");
  // Head: big nose, ears, a wide mouth.
  g.ell(0, 13.5, 0.5, 3.6, 3.2, 3.2, () => B.body, "head");
  g.ell(0, 12.5, 4, 1.4, 1.6, 1.6, () => B.belly, "head");
  for (const s of [-1, 1]) for (let h = 0; h < 2; h++) g.put(s * (4 + h), 14 + h, 0, B.body, "head");
  for (let x = -2; x <= 2; x++) g.put(x, 11, 3, x === 0 ? B.body : "#2a1d1d", "head");
  for (const s of [-1, 1]) g.put(s * 2, 11, 3, B.claw, "head");
  eyes(g, F, t, { y: 14, z: 3, off: 2, scale: 0.85 });
  return {
    neck: { y: 10, z: 0.5, r: 3.6 },
    spine: { from: 2, to: -3 },
    pack: { top: 10, y: 7, z: 0, r: 4.2 },
    brow: { y: 15 },
    chest: { y: 8, z: 3 },
  };
}

const BUILD: Record<Creature, (g: Grid, B: Palette, F: Finish, t: Traits) => Anchors> = { dino, fox, owl, troll };

const STRAP = "#4a3426";
const PATCH = ["#e3b452", "#84b9df", "#e8644a", "#9fd6c2", "#c8b3dd", "#f2cf4a", "#7fc1d9", "#efe6cf", "#a8434d"];

/** A creature in its look, shaped by the stats: its voxels, and the traits that shaped them. */
export function buildAvatar(look: Look, stats: AvatarStats, now?: Situation): { voxels: Voxel[]; traits: Traits } {
  const l = lookOf(look);
  const t = traits(statsOf(stats));
  const B = BODIES[l.body]!, F = FINISHES[l.finish]!;
  const g = new Grid();
  const a = BUILD[l.creature](g, B, F, t);

  if (l.show.strap && a.strapFrom) {
    const s0 = a.strapFrom;
    for (const s of [-1, 1]) {
      g.put(s * s0.x, s0.y, s0.z, STRAP, "head");
      g.put(s * s0.x, s0.y - 1, s0.z - 1, STRAP, "body");
      g.put(s * s0.x, s0.y - 2, s0.z - 2, STRAP, "body");
    }
    for (let i = 0; i < 40; i++) {
      const ang = (i / 40) * Math.PI * 2, x = Math.round(Math.cos(ang) * (a.neck.r - 0.2)), z = Math.round(a.neck.z + Math.sin(ang) * (a.neck.r - 0.2));
      if (z < a.neck.z) g.put(x, s0.y - 2, z, STRAP, "body");
    }
  }
  if (l.show.scarf) {
    const cols = t.langs.length ? t.langs.map((x) => LANGS[x] ?? "#8c9aa5") : ["#8c9aa5"];
    for (const y of [a.neck.y, a.neck.y + 1]) g.ring(y, a.neck.z, a.neck.r, (ang) => cols[Math.floor(((ang + Math.PI / 2) / (Math.PI * 2)) * cols.length * 2) % cols.length]!, "body");
    for (let i = 0; i < 4; i++) g.put(-Math.round(a.neck.r - 0.6), a.neck.y - 1 - i, Math.round(a.neck.z - 3 - Math.floor(i / 2)), cols[i % cols.length]!, "body");
  }
  if (l.show.pack) {
    const p = a.pack;
    const spots = [[-2, p.top - 1], [0, p.top - 1], [2, p.top - 1], [-2, p.top - 3], [0, p.top - 3], [2, p.top - 3], [-1, p.top - 2], [1, p.top - 2], [0, p.top - 4]];
    for (let x = -2; x <= 2; x++)
      for (let y = p.top - 5; y <= p.top; y++) {
        const zs = p.z - p.r * 1.2 * Math.sqrt(Math.max(0, 1 - (x / p.r) ** 2 - ((y - p.y) / p.r) ** 2));
        const zb = Math.floor(zs);
        for (let z = zb - 2; z <= zb; z++) g.put(x, y, z, y === p.top ? "#6e5638" : "#8a6f4d", "body");
        const i = spots.findIndex(([px, py]) => px === x && py === y);
        if (i >= 0 && i < t.patches) g.put(x, y, zb - 3, PATCH[i]!, "body");
      }
  }
  if (l.show.ridge && t.ridge) {
    const { from, to } = a.spine;
    // One spike per row of the spine, at most: the tops are read before any spike goes on.
    const zs = [...new Set(Array.from({ length: t.ridge }, (_, i) => Math.round(from - i * ((from - to) / Math.max(1, t.ridge - 1)))))];
    const tops = zs.map((z) => {
      for (let y = 24; y >= 0; y--) if (g.has(0, y, z)) return y;
      return -1;
    });
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i]!, top = tops[i]!;
      if (top < 0) continue;
      const h = t.ridgeH + (i === Math.floor(zs.length / 3) ? 1 : 0);
      for (let k = 1; k <= h; k++) g.put(0, top + k, z, B.ridge, "body");
      if (h >= 2) {
        g.put(0, top + 1, z - 1, B.ridge, "body");
        g.put(0, top + 1, z + 1, B.ridge, "body");
      }
    }
  }
  if (l.show.flag && t.flagH) {
    const base = l.show.pack ? a.pack.top + 1 : a.pack.top;
    const px = 2, pz = Math.round(a.pack.z - a.pack.r * 0.8);
    for (let y = base; y < base + t.flagH; y++) g.put(px, y, pz, "#c9d7e1", "flag");
    for (let x = 1; x <= 3; x++) for (let y = 0; y < 2; y++) g.put(px + x, base + t.flagH - 1 - y, pz, x === 2 && y === 0 ? "#f3ead6" : "#d8443c", "flag");
  }
  if (l.show.lamp && t.lamp) {
    // A small lamp on the forehead: on the head's own front surface at the brow's height.
    const y = a.brow.y;
    let front = -99;
    for (let z = 20; z >= -20; z--)
      if (g.has(0, y, z)) {
        front = z;
        break;
      }
    if (front > -99) {
      for (const x of [-1, 0, 1]) g.put(x, y, front + 1, "#2a2f35", "head");
      g.put(0, y + 1, front + 1, "#2a2f35", "head");
      g.put(0, y, front + 2, "#ffe9a8", "lamp", true);
    }
  }
  if (l.show.badge && t.badge) for (const [x, y] of [[0, 0], [-1, 0], [1, 0], [0, 1], [0, -1]] as const) g.put(x, a.chest.y + y, a.chest.z, x === 0 && y === 0 ? "#fff3c4" : F.ring, "body");
  if (now) surroundings(g, a, now, F);
  return { voxels: [...g.m.values()], traits: t };
}

// ── Surroundings and live props (./mood.ts says which) ──

const FLAME = ["#ff5a1f", "#ff8a2a", "#ffc23d", "#ffe28a"];
const CONFETTI = ["#e8644a", "#f2cf4a", "#84b9df", "#9fd6c2", "#c8b3dd", "#ffffff"];
const hashOf = (x: number, y: number, z: number) => {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
/** In front of the creature (nearer the viewer, who looks from +x +z) or behind it. */
const side = (x: number, z: number): Layer => (x + z > 1 ? "over" : "under");

function surroundings(g: Grid, a: Anchors, now: Situation, F: Finish) {
  const own = [...g.m.values()];
  const head = own.filter((v) => LAYER[v.part] === "head");
  const top = Math.max(...head.map((v) => v.y));
  const crown = head.filter((v) => v.y === top);
  const cz = Math.round(crown.reduce((n, v) => n + v.z, 0) / Math.max(1, crown.length));
  const scene = now.scene;

  // The ground: a rock under the feet, snow on top (scorched when it burns).
  const R = 8.5;
  for (let x = -9; x <= 9; x++)
    for (let z = -9; z <= 9; z++) {
      const d = (x / R) ** 2 + (z / R) ** 2;
      if (d > 1) continue;
      g.put(x, -1, z, scene === "fire" ? (hashOf(x, 1, z) > 0.6 ? "#3b2f2b" : "#5a4a42") : d > 0.7 ? "#7f95a5" : "#a9bccb", "ground");
      g.put(x, -2, z, "#253a4a", "ground");
    }

  if (scene === "fire") {
    // Flames all round, taller at the back; the creature sits it out.
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2;
      const x = Math.round(Math.cos(ang) * 7.4), z = Math.round(Math.sin(ang) * 7.4);
      // Low in front, so the creature shows; tall behind it.
      const h = x + z > 1 ? 1 + Math.floor(hashOf(i, 2, 3) * 2) : 3 + Math.floor(hashOf(i, 2, 3) * 3) + (x + z < -4 ? 1 : 0);
      for (let y = 0; y < h; y++) g.put(x, y, z, FLAME[Math.min(3, Math.floor((y / h) * 4))]!, "fire", true, side(x, z));
    }
  }
  if (scene === "storm") {
    // A raincloud over the head, and rain in front of it.
    // Back from the face and well above it, so it never sits on the head.
    const cy = top + 9, oz = cz - 4;
    for (let x = -6; x <= 6; x++)
      for (let z = -3; z <= 3; z++)
        for (let y = cy; y <= cy + 2; y++) {
          const d = (x / 6.4) ** 2 + (z / 3.4) ** 2 + ((y - cy - 0.6) / 1.7) ** 2;
          if (d <= 1 + 0.25 * hashOf(x, y, z)) g.put(x, y, oz + z, y === cy ? "#4a5560" : "#6b7884", "cloud");
        }
    // Rain from under it, beside the creature rather than through its face.
    for (let i = 0; i < 10; i++) {
      const x = (i % 2 ? 1 : -1) * (4 + Math.round(hashOf(i, 7, 1) * 2)), z = Math.round(oz - 2 + hashOf(i, 3, 9) * 4);
      const y = Math.round(cy - 2 - hashOf(i, 5, 5) * 8);
      g.put(x, y, z, "#84b9df", "rain", true, side(x, z));
      g.put(x, y - 1, z, "#84b9df", "rain", true, side(x, z));
    }
  }
  if (scene === "night" || scene === "calm") {
    // A pine behind, on the rock's edge.
    for (let y = 0; y <= 1; y++) g.put(5, y, -6, "#5b3a24", "ground", false, "under");
    for (let k = 0; k < 4; k++) for (let x = -2 + Math.floor(k / 2); x <= 2 - Math.floor(k / 2); x++) for (let z = -2 + Math.floor(k / 2); z <= 2 - Math.floor(k / 2); z++) if (Math.abs(x) + Math.abs(z) <= 3 - Math.floor(k / 2)) for (const dy of [0, 1]) g.put(5 + x, 2 + k * 2 + dy, -6 + z, dy ? (scene === "night" ? "#2c4b37" : "#3f6d50") : scene === "night" ? "#24402f" : "#355e44", "ground", false, "under");
    g.put(5, 10, -6, scene === "night" ? "#dfe8ef" : "#355e44", "ground", false, "under");
  }
  if (scene === "night") {
    // The moon and a few stars, far behind.
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) if (Math.abs(x) + Math.abs(y) < 2) g.put(-10 + x, top + 6 + y, -10, "#f3ead6", "sky", true);
    for (let i = 0; i < 7; i++) g.put(Math.round(-14 + hashOf(i, 1, 1) * 10), Math.round(top + 1 + hashOf(i, 2, 2) * 9), Math.round(-14 + hashOf(i, 3, 3) * 6), "#dce7ef", "sky", true);
  }
  if (scene === "party") {
    for (let i = 0; i < 26; i++) {
      const x = Math.round(-8 + hashOf(i, 4, 4) * 16), z = Math.round(-8 + hashOf(i, 6, 6) * 16), y = Math.round(top - 6 + hashOf(i, 8, 8) * 12);
      if (Math.abs(x) < 4 && Math.abs(z) < 5 && y < top + 2) continue;
      g.put(x, y, z, CONFETTI[i % CONFETTI.length]!, "confetti", true, side(x, z));
    }
  }

  const p = now.props;
  let hat = top;
  if (p.hardhat) {
    // A hard hat while a deploy waits for me.
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (x * x + z * z <= 10) g.put(x, top + 1, cz + z, "#f2c230", "head");
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (x * x + z * z <= 5) g.put(x, top + 2, cz + z, "#f6d055", "head");
    for (let x = -1; x <= 1; x++) g.put(x, top + 1, cz + 4, "#e0ad1e", "head");
    hat = top + 2;
  }
  if (p.beacon) {
    g.put(0, hat + 1, cz, "#2a2f35", "head");
    g.put(0, hat + 2, cz, "#5fa8ff", "beacon", true);
  }
  // Drones: one per agent working, the first red when one needs me.
  const spots = [{ x: 8, y: top - 2, z: 4 }, { x: -7, y: top + 1, z: 6 }, { x: 6, y: top + 3, z: -8 }];
  for (let i = 0; i < p.drones; i++) {
    const d = spots[i]!, part = (["drone1", "drone2", "drone3"] as const)[i]!, layer = side(d.x, d.z);
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.put(d.x + dx, d.y, d.z + dz, "#c9d7e1", part, false, layer);
    for (const [dx, dz] of [[-1, -1], [2, -1], [-1, 2], [2, 2]]) g.put(d.x + dx, d.y + 1, d.z + dz, "#3d4650", part, false, layer);
    g.put(d.x + 1, d.y, d.z + 2, i === 0 && p.droneAsks ? "#ff5a4f" : F.eye, part, true, layer);
  }
  // Papers by the feet: reviews asked of me.
  for (let i = 0; i < p.papers; i++) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.put(5 + dx, i, 3 + dz, i % 2 ? "#e6e2d6" : "#f6f3ea", "body", false, "over");
  // Notes on the backpack's side: what I'm doing on My list.
  for (let i = 0; i < p.notes; i++) g.put(3, a.pack.top - 1 - i, Math.round(a.pack.z - a.pack.r) + (i % 2), i % 2 ? "#ff8fb1" : "#ffe066", "body");
  if (p.mug) {
    const m = { x: 4, y: a.chest.y - 2, z: a.chest.z + 1 };
    for (let y = 0; y < 2; y++) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.put(m.x + dx, m.y + y, m.z + dz, "#f3ead6", "body", false, "over");
    g.put(m.x + 2, m.y + 1, m.z, "#f3ead6", "body", false, "over");
    g.put(m.x, m.y + 2, m.z + 1, "#e6e2d6", "steam", true);
    g.put(m.x + 1, m.y + 3, m.z, "#e6e2d6", "steam", true);
  }
}
