/**
 * My avatar, a pack for fun (dovre#130; nothing in Dovre needs it): a creature I pick, shaped by
 * what I do on the forge (PackContext.forge) and set in a scene by how things are. It shows in two
 * core places through slots (Today's header, the Bino button and Bino's header), brings its own
 * script and styles, and has its own page (/avatar). How things are comes from the snapshot,
 * My list and the packs' pulse (PackContext.pulse: what works and waits, what's wrong, whether
 * I'm on duty, whether Bino is answering), all counts.
 */
import { needsOf } from "dovre/home/needs.ts";
import { listTodos } from "dovre/todo/store.ts";
import { type Pack, PACK_API, type PackContext } from "dovre/packs/types.ts";
import { type Avatar, createAvatar } from "./avatar.ts";
import { signalsFrom } from "./feed.ts";
import { AVATAR_JS } from "./script.ts";
import { type AvatarData, createAvatarData } from "./stats.ts";
import { AVATAR_CSS, AVATAR_PAGE_CSS } from "./style.ts";
import { avatarDock, avatarHero, avatarMini, avatarRoutes } from "./view.ts";
import { hourAt } from "dovre/when.ts";

export type AvatarDeps = {
  now?: () => number;
};


export function createAvatarPack(o: AvatarDeps = {}): Pack {
  const clock = o.now ?? Date.now;
  let ctx: PackContext | undefined;
  /** My list: items I'm doing (read on refresh). */
  let doing = 0;
  let shown = "";
  // The forge's numbers shape it; a forge that doesn't say leaves its starting shape.
  const data: AvatarData = createAvatarData({ forge: () => ctx?.forge(), now: clock, onChange: () => ctx?.publish(["avatar"]), log: (l) => ctx?.log(l) });
  const avatar: Avatar = createAvatar({
    data,
    // The idle picture whenever it changes: a copy for the starting page.
    onStart: (svg) => ctx?.startPicture(svg),
    now: clock,
    busy: () => ctx?.pulse().busy ?? false,
    signals: () => {
      const s = ctx?.snapshot();
      if (!s) return undefined;
      return signalsFrom({ snap: s, needs: needsOf(s), pulse: ctx!.pulse(), doing, mergedToday: 0, hour: hourAt(clock()) });
    },
  });
  return {
    manifest: {
      api: PACK_API,
      id: "avatar",
      name: "Avatar",
      description: "Me in Dovre: a creature shaped by what I do on the forge, in a scene set by how things are",
      domain: "fun",
      execution: "any",
      everyMs: 60_000,
    },
    styles: AVATAR_PAGE_CSS + AVATAR_CSS,
    script: AVATAR_JS,
    async init(c) {
      ctx = c;
      await Promise.all([avatar.load(c.db), data.load(c.db)]);
    },
    async refresh(c) {
      ctx = c;
      try {
        doing = (await listTodos(c.db)).filter((t) => t.state === "doing" && !t.parent).length;
      } catch {}
      await data.refresh(c.db);
      // Open pages ask /avatar/now on every change; this covers what changes on its own (the hour, My list).
      const key = avatar.now().key;
      if (shown && key !== shown) c.publish(["avatar"]);
      shown = key;
    },
    pages: () => [{ title: "Your avatar", href: "/avatar", icon: "◉", about: "Pick a creature and its colours; what you do shapes the rest", also: ["avatar", "creature", "look"] }],
    slots: () => ({
      "today.hero": () => avatarHero(avatar.now(), avatar.today()),
      "bino.face": ({ place, thinking }) => (place === "dock" ? avatarDock(avatar.now()) : avatarMini(avatar.now(), thinking)),
    }),
    routes: (app, c) => {
      ctx = c;
      avatarRoutes(app, c, avatar);
    },
  };
}

export const avatarPack: Pack = createAvatarPack();
