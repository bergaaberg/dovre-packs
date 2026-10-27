/**
 * My avatar in Dovre: the look I picked (kept in the settings table under "avatar"), the numbers
 * GHE gives it (stats.ts) and how things are right now (mood.ts, from `signals`). It's worked out
 * when asked (a page drawn, /avatar/now), so nothing has to push changes into it: the same here and
 * on the Worker. It draws the SVG pages show as an image, keyed by all three, so a page's <img>
 * changes address only when the picture does, and says why in a line (counts only). `onStart`
 * gets the idle picture whenever it changes (here: a copy for the starting page, data/avatar-start.svg).
 */
import type { D1 } from "dovre/db.ts";
import { hashOf } from "dovre/ui/style.ts";
import { AVATAR_CSS } from "./style.ts";
import { isoSvg } from "./iso.ts";
import { buildAvatar, DEFAULT_LOOK, type Look, lookOf, statsOf } from "./model.ts";
import { type Signals, type Situation, situationKey, situationOf } from "./mood.ts";
import type { AvatarData } from "./stats.ts";
import { hourAt } from "dovre/when.ts";

export const MOODS = ["idle", "working", "pop", "ask", "done", "sleep"] as const;
export type Mood = (typeof MOODS)[number];

/** How it is on Today: moving, standing still, or not there (kept in settings under "avatar-today"). */
export const TODAY_MODES = ["move", "still", "hide"] as const;
export type TodayMode = (typeof TODAY_MODES)[number];
export const todayModeOf = (v: unknown): TodayMode => (TODAY_MODES as readonly unknown[]).includes(v) ? (v as TodayMode) : "move";

/** A line the avatar says once (`at` tells a page whether it has shown it). */
export type Say = { text: string; tone: "bad" | "warn" | "ok" | "neutral"; href?: string; at: number };

export type AvatarNow = {
  /** Changes when the picture does: the image's address carries it. */
  key: string;
  scene: Situation["scene"];
  /** An agent here or in a terminal is working, or Bino is answering. */
  busy: boolean;
  /** Why the scene is what it is, in a line (counts only). */
  why: string[];
  /** What it says when the scene changes for the worse or the better. */
  say?: Say;
};

export type Avatar = {
  /** Reads the look I saved. */
  load(db: D1): Promise<void>;
  look(): Look;
  setLook(db: D1, l: Look): Promise<void>;
  /** How it is on Today. */
  today(): TodayMode;
  setToday(db: D1, m: TodayMode): Promise<void>;
  /** How things are now (worked out again: cheap, counts only). */
  now(): AvatarNow;
  /** The SVG for the current picture. */
  svg(o: { mood: Mood; facing: "left" | "right"; bare: boolean; still: boolean }): string;
  /** The stats and situation behind it, for the crafting page. */
  facts(): { stats: ReturnType<typeof statsOf>; situation: Situation; gathered?: number };
};
const SAY: Record<Situation["scene"], Omit<Say, "at"> | undefined> = {
  fire: { text: "This is fine.", tone: "bad" },
  storm: { text: "Rain coming in.", tone: "warn" },
  party: { text: "Merged!", tone: "ok", href: "/prs" },
  night: undefined,
  calm: undefined,
};

export function createAvatar(o: { data?: AvatarData; signals: () => Signals | undefined; busy?: () => boolean; onStart?: (svg: string) => void; now?: () => number }): Avatar {
  const clock = o.now ?? Date.now;
  let look: Look = DEFAULT_LOOK;
  let today: TodayMode = "move";
  const blank: Signals = { redBuilds: 0, deploysWaiting: 0, agentsWorking: 0, agentsAsking: 0, reviewsAsked: 0, mergedToday: 0, doing: 0, hour: 12 };
  // Known: the signals have come in. Until then the scene is a guess, and its first real one isn't a turn.
  let known = false;
  const situationNow = () => {
    const got = o.signals();
    known ||= got !== undefined;
    const s = got ?? { ...blank, hour: hourAt(clock()) };
    return situationOf({ ...s, mergedToday: Math.max(s.mergedToday, o.data?.facts()?.mergedToday ?? 0) });
  };
  const statsNow = () => statsOf(o.data?.facts()?.stats);
  const busyNow = () => {
    try {
      return !!o.busy?.();
    } catch {
      return false;
    }
  };
  let situation = situationNow();
  let say: AvatarNow["say"];
  const keyOf = () => hashOf(JSON.stringify([look, statsNow(), situationKey(situation)]));
  let key = "";
  const cache = new Map<string, string>();
  const draw = (mood: Mood, facing: "left" | "right", bare: boolean, still: boolean) => {
    const k = `${key}.${mood}.${facing}.${bare ? 1 : 0}.${still ? 1 : 0}`;
    let svg = cache.get(k);
    if (!svg) {
      // Bare: the creature and its props, without the ground and the weather (small places).
      const sit: Situation = bare ? { ...situation, scene: "calm" } : situation;
      let { voxels } = buildAvatar(look, statsNow(), sit);
      if (bare) voxels = voxels.filter((v) => !["ground", "sky", "fire", "cloud", "rain", "confetti"].includes(v.part));
      svg = isoSvg(voxels, { facing, shadow: true, headroom: bare ? 6 : 2, className: `mood-${mood} scene-${sit.scene} cr-${look.creature}`, style: still ? undefined : AVATAR_CSS, label: "My avatar" });
      if (cache.size > 60) cache.clear();
      cache.set(k, svg);
    }
    return svg;
  };
  /** Looks again; a new picture gets a new key (and a copy for the starting page), a turn in the scene a line. */
  const again = () => {
    const was = situation.scene;
    const wasKnown = known;
    situation = situationNow();
    if (situation.scene !== was && wasKnown) {
      const s = SAY[situation.scene];
      say = s ? { text: `${s.text}${situation.why[0] ? ` ${situation.why[0][0]!.toUpperCase()}${situation.why[0].slice(1)}.` : ""}`, tone: s.tone, href: situation.href ?? s.href, at: clock() } : undefined;
    }
    const k = keyOf();
    if (k !== key) {
      key = k;
      if (o.onStart) {
        try {
          o.onStart(draw("idle", "right", false, false));
        } catch {}
      }
    }
  };
  again();
  return {
    async load(db) {
      try {
        const row = await db.prepare("SELECT value FROM settings WHERE key = 'avatar'").first<{ value: string }>();
        if (row?.value) look = lookOf(JSON.parse(row.value));
        const t = await db.prepare("SELECT value FROM settings WHERE key = 'avatar-today'").first<{ value: string }>();
        today = todayModeOf(t?.value);
      } catch {}
      again();
    },
    look: () => look,
    async setLook(db, l) {
      look = lookOf(l);
      await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('avatar', ?, ?)").bind(JSON.stringify(look), new Date(clock()).toISOString()).run();
      cache.clear();
      again();
    },
    today: () => today,
    async setToday(db, m) {
      today = todayModeOf(m);
      await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('avatar-today', ?, ?)").bind(today, new Date(clock()).toISOString()).run();
    },
    now() {
      again();
      return { key, scene: situation.scene, busy: busyNow(), why: situation.why, ...(say ? { say } : {}) };
    },
    svg: ({ mood, facing, bare, still }) => draw(mood, facing, bare, still),
    facts: () => ({ stats: statsNow(), situation, gathered: o.data?.facts()?.at }),
  };
}
