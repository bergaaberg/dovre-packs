/**
 * How things look right now, for the avatar's surroundings and live props. Pure: counts in, a
 * situation out. Only counts and flags, never a title or a message: the avatar's picture is served
 * as an image and has no business holding work text.
 *
 * Scenes, worst first:
 *   fire   "This is fine": production is burning (a pack says so: its `avatar` hook's trouble).
 *          The avatar sits in the flames with a coffee.
 *   storm  something's wrong but not on fire: a red build, or a pack's storm.
 *   party  a PR of mine merged in the last day and nothing is wrong.
 *   night  after 20:00 or before 06:00.
 *   calm   the rest.
 * Props come and go with what's going on: a hard hat while a deploy waits for me, a drone per agent
 * working (a red one when an agent needs me), papers by the feet for reviews asked of me, notes on
 * the pack for what I'm doing on My list, a beacon while I'm on duty, a mug when reviews pile up.
 */
export type Signals = {
  /** On duty, as a pack says (its `avatar` hook's `onDuty`). */
  onCall?: boolean;
  redBuilds: number;
  deploysWaiting: number;
  agentsWorking: number;
  agentsAsking: number;
  reviewsAsked: number;
  /** My PRs merged in the last 24 h. */
  mergedToday: number;
  /** My list: items I'm doing. */
  doing: number;
  /** Local hour 0–23. */
  hour: number;
  /** What the packs say is wrong (src/packs/registry.ts avatarFrom): a line of counts each, and where to look. */
  trouble?: { level: "storm" | "fire"; why: string; href?: string }[];
};

export const SCENES = ["calm", "night", "party", "storm", "fire"] as const;
export type Scene = (typeof SCENES)[number];
export type Props = { hardhat: boolean; drones: number; droneAsks: boolean; papers: number; notes: number; beacon: boolean; mug: boolean };
/** `href`: where to look when it turns bad (the first trouble with a page). */
export type Situation = { scene: Scene; props: Props; why: string[]; href?: string };

export function situationOf(s: Signals): Situation {
  const why: string[] = [];
  const trouble = s.trouble ?? [];
  const fires = trouble.filter((t) => t.level === "fire");
  let scene: Scene;
  let href: string | undefined;
  if (fires.length) {
    scene = "fire";
    for (const t of fires) why.push(t.why);
    href = fires.find((t) => t.href)?.href;
  } else if (s.redBuilds > 0 || trouble.length) {
    scene = "storm";
    if (s.redBuilds) why.push(`${s.redBuilds} red build${s.redBuilds === 1 ? "" : "s"}`);
    for (const t of trouble) why.push(t.why);
    href = trouble.find((t) => t.href)?.href;
  } else if (s.mergedToday > 0) {
    scene = "party";
    why.push(`${s.mergedToday} PR${s.mergedToday === 1 ? "" : "s"} merged today`);
  } else if (s.hour >= 20 || s.hour < 6) scene = "night";
  else scene = "calm";
  const props: Props = {
    hardhat: s.deploysWaiting > 0,
    drones: Math.min(3, s.agentsWorking + s.agentsAsking),
    droneAsks: s.agentsAsking > 0,
    papers: Math.min(5, s.reviewsAsked),
    notes: Math.min(4, s.doing),
    beacon: !!s.onCall,
    mug: scene === "fire" || s.reviewsAsked >= 3,
  };
  if (props.hardhat) why.push(`${s.deploysWaiting} deploy${s.deploysWaiting === 1 ? "" : "s"} waiting for you`);
  if (s.agentsWorking) why.push(`${s.agentsWorking} agent${s.agentsWorking === 1 ? "" : "s"} working`);
  if (s.agentsAsking) why.push(`${s.agentsAsking} agent${s.agentsAsking === 1 ? "" : "s"} asking`);
  if (s.reviewsAsked) why.push(`${s.reviewsAsked} review${s.reviewsAsked === 1 ? "" : "s"} asked of you`);
  if (s.doing) why.push(`${s.doing} on My list in progress`);
  if (s.onCall) why.push("on duty");
  return { scene, props, why, ...(href ? { href } : {}) };
}

/** The props /avatar's "Try a scene" can add, each as it would look with something going on. */
export const TRY_PROPS = {
  beacon: "Beacon (on duty)",
  hardhat: "Hard hat (a deploy waits)",
  drones: "Drones (agents working)",
  asking: "A red drone (an agent asks)",
  papers: "Papers (reviews asked)",
  notes: "Notes (My list)",
} as const;
export type TryProp = keyof typeof TRY_PROPS;

/**
 * A scene to look at without it happening (/avatar's "Try a scene"): `scene` replaces the real one
 * (anything else keeps it), and each known prop in `props` is added on top. Only known words count;
 * nothing here is kept.
 */
export function trySituation(real: Situation, scene: unknown, props: unknown[]): Situation {
  const sc = (SCENES as readonly unknown[]).includes(scene) ? (scene as Scene) : real.scene;
  const on = (k: TryProp) => props.includes(k);
  const p = real.props;
  return {
    scene: sc,
    why: [],
    props: {
      hardhat: p.hardhat || on("hardhat"),
      drones: Math.max(p.drones, on("drones") ? 2 : 0, on("asking") ? 1 : 0),
      droneAsks: p.droneAsks || on("asking"),
      papers: Math.max(p.papers, on("papers") ? 3 : 0),
      notes: Math.max(p.notes, on("notes") ? 2 : 0),
      beacon: p.beacon || on("beacon"),
      mug: p.mug || sc === "fire" || on("papers"),
    },
  };
}

/** A short key that changes when the picture would: what the image's address carries. */
export const situationKey = (x: Situation) => `${x.scene}.${Object.values(x.props).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)).join("")}`;
