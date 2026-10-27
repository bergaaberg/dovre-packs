/**
 * The avatar on pages, and the page to craft it (/avatar). The picture is an image
 * (/avatar/image.svg), drawn by the server from numbers and the palettes only, so pages
 * never put markup of it inline. Its address carries the picture's key and a mood; the page script
 * (src/ui/app.js.ts, "avatar") swaps the mood and the key as things happen and shows what it says.
 */
import type { Avatar, AvatarNow, Mood, TodayMode } from "./avatar.ts";
import { MOODS, todayModeOf } from "./avatar.ts";
import { isoSvg } from "./iso.ts";
import { BODIES, buildAvatar, CREATURES, type Creature, effects, EXTRAS, type Extra, FINISHES, type Look, lookOf } from "./model.ts";
import { situationOf } from "./mood.ts";
import type { App } from "dovre/env.ts";
import type { PackContext } from "dovre/packs/types.ts";
import { AVATAR_CSS } from "./style.ts";
import { html, PageHeader, Panel } from "dovre/ui/kit.ts";
import { Ago } from "dovre/pages/parts.ts";

export type AvatarPlace = "dock" | "hero" | "mini" | "stage";

/** The image's address: the picture's key, a mood, which way it faces, whether the scene is left out, and whether it stands still. */
export const avatarSrc = (now: Pick<AvatarNow, "key">, o: { mood?: Mood; facing?: "left" | "right"; bare?: boolean; still?: boolean }) =>
  `/avatar/image.svg?k=${encodeURIComponent(now.key)}&m=${o.mood ?? "idle"}&f=${o.facing === "right" ? "r" : "l"}&b=${o.bare ? 1 : 0}${o.still ? "&s=1" : ""}`;

/** The avatar as an image, marked for the page script (data-av). */
export function avatarImg(now: AvatarNow, o: { place: AvatarPlace; facing?: "left" | "right"; bare?: boolean; mood?: Mood; still?: boolean }) {
  const mood = o.mood ?? (now.busy ? "working" : "idle");
  return html`<img class="av-img" src="${avatarSrc(now, { ...o, mood })}" alt="" data-av="${o.place}" data-f="${o.facing === "right" ? "r" : "l"}" data-b="${o.bare ? 1 : 0}"${o.still ? html` data-s="1"` : ""} data-mood="${mood}" width="400" height="400" decoding="async">`;
}

/**
 * Today's: the full scene, facing the briefing, with why it looks the way it does, and two buttons to
 * pause it (or play it again) and to take it off Today. Both are kept (POST /avatar/today); the page
 * script does them at once without leaving the page, and /avatar brings a hidden one back.
 */
export function avatarHero(now: AvatarNow, mode: TodayMode = "move") {
  if (mode === "hide") return "";
  const still = mode === "still";
  return html`<figure class="av-hero${still ? " still" : ""}" data-av-box><a href="/avatar" title="Your avatar: what shapes it">${avatarImg(now, { place: "hero", facing: "right", still })}</a><form method="post" action="/avatar/today" class="av-ctl" data-av-ctl><button type="submit" name="mode" value="${still ? "move" : "still"}" title="${still ? "Play" : "Pause"}" aria-label="${still ? "Play the avatar" : "Pause the avatar"}" aria-pressed="${still ? "true" : "false"}"><span class="av-ico ${still ? "play" : "pause"}" aria-hidden="true"></span></button><button type="submit" name="mode" value="hide" title="Hide from Today (bring it back on its page)" aria-label="Hide the avatar from Today"><span class="av-ico hide" aria-hidden="true"></span></button></form><figcaption class="av-why" data-av-why>${now.why.slice(0, 2).join(" · ")}</figcaption></figure>`;
}

/** The Bino button's face (bare, at work while Bino answers); `data-scene` colours the button's edge. */
export const avatarDock = (now: AvatarNow) => html`<span class="av-face" data-scene="${now.scene}">${avatarImg(now, { place: "dock", bare: true })}</span>`;

/** Beside Bino's header (the dock isn't on Bino's pages): at work while Bino answers. */
export const avatarMini = (now: AvatarNow, thinking = false) => html`<a class="av-mini" href="/avatar" title="Your avatar" data-av-box>${avatarImg(now, { place: "mini", bare: true, mood: thinking ? "working" : undefined })}</a>`;

/** A colour chip: its colour comes from the stylesheet (one rule per palette entry), never a style attribute. */
const swatch = (cls: string) => html`<span class="av-sw ${cls}" aria-hidden="true"></span>`;

export function avatarPage(o: { /** Where the numbers come from: GHE here, GitHub hosted. */ from: string; now: AvatarNow; look: Look; today?: TodayMode; stats: ReturnType<Avatar["facts"]>["stats"]; gathered?: number; why: string[]; saved?: boolean }) {
  const e = effects(o.stats);
  const radio = (name: string, value: string, label: string, checked: boolean, sw?: string) =>
    html`<label class="av-pick"><input type="radio" name="${name}" value="${value}"${checked ? html` checked` : ""}>${sw ? swatch(sw) : ""}${label}</label>`;
  const body = html`${PageHeader({ title: "Your avatar", crumbs: [{ href: "/bino", label: "Bino" }], sub: `Pick a creature and its colours; what you do on ${o.from} shapes the rest, and how things are going sets the scene.` })}
<div class="av-craft">
<div class="av-stage">${avatarImg(o.now, { place: "stage", facing: "left" })}<p class="av-why" data-av-why>${o.why.join(" · ") || "All calm."}</p></div>
<form method="post" action="/avatar" class="fields" data-av-form>
${Panel({ title: "Creature", children: html`<div class="av-picks">${(Object.keys(CREATURES) as Creature[]).map((c) => radio("creature", c, CREATURES[c], o.look.creature === c))}</div>` })}
${Panel({ title: "Colours", children: html`<div class="av-picks">${Object.entries(BODIES).map(([k, v]) => radio("body", k, v.label, o.look.body === k, `b-${k}`))}</div>` })}
${Panel({ title: o.look.creature === "dino" ? "Binoculars" : "Eyes and trim", children: html`<div class="av-picks">${Object.entries(FINISHES).map(([k, v]) => radio("finish", k, v.label, o.look.finish === k, `f-${k}`))}</div>` })}
${Panel({ title: "On Today", children: html`<div class="av-picks">${([["move", "Moving"], ["still", "Still"], ["hide", "Hidden"]] as const).map(([v, l]) => radio("today", v, l, (o.today ?? "move") === v))}</div>` })}
${Panel({ title: "Show", children: html`<div class="av-picks">${(Object.keys(EXTRAS) as Extra[]).map((k) => html`<label class="av-pick"><input type="checkbox" name="show" value="${k}"${o.look.show[k] ? html` checked` : ""}>${EXTRAS[k]}</label>`)}</div>` })}
<div class="buttons"><button type="submit" class="primary" data-busy="Saving">Save</button>${o.saved ? html`<span class="t3">Saved.</span>` : ""}</div>
</form>
</div>
${Panel({
  title: `From ${o.from}, the last 12 weeks`,
  children: html`<ul class="av-traits">
<li><b>${o.stats.prs} PRs merged</b> <span>→ ${e.prs}</span></li>
<li><b>${o.stats.reviews} PRs reviewed</b> <span>→ ${e.reviews}</span></li>
<li><b>${o.stats.repos} repos committed to</b> <span>→ ${e.repos}</span></li>
<li><b>${o.stats.streak} days in a row</b> <span>→ ${e.streak}</span></li>
<li><b>${o.stats.night} % of commits after 20:00</b> <span>→ ${e.night}</span></li>
<li><b>Languages</b> <span>→ ${e.langs}</span></li>
</ul><p class="hint t3">${o.gathered ? html`Read from ${o.from} ${Ago(o.gathered)}; again every six hours.` : `Not read from ${o.from} yet: it's read in the background soon after Dovre starts.`} Around it: a hard hat while a deploy waits for you, a drone per agent working (red when one needs you), papers for reviews asked of you, notes for what you're doing on My list, a beacon while you're on duty; rain for a red build or an alert, fire when production is burning, confetti when a PR of yours merged today.</p>`,
})}`;
  return body;
}

const MOOD = new Set<string>(MOODS);

/** Its pages: the image, a preview while picking, how things are now, and the crafting page. */
export function avatarRoutes(app: App, ctx: PackContext, a: Avatar) {
  app.get("/avatar/image.svg", (c) => {
    const m = c.req.query("m") ?? "idle";
    const mood = (MOOD.has(m) ? m : "idle") as Mood;
    const svg = a.svg({ mood, facing: c.req.query("f") === "r" ? "right" : "left", bare: c.req.query("b") === "1", still: c.req.query("s") === "1" });
    // Its key names the picture: one for an older key draws what's current, and isn't kept.
    const current = c.req.query("k") === a.now().key;
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": current ? "private, max-age=31536000, immutable" : "no-store" });
  });
  /** A look not saved yet, while picking (the crafting page's preview). */
  app.get("/avatar/preview.svg", (c) => {
    const q = c.req.queries();
    const look = lookOf({ creature: q.creature?.[0], body: q.body?.[0], finish: q.finish?.[0], show: Object.fromEntries(Object.keys(EXTRAS).map((k) => [k, (q.show ?? []).includes(k)])) });
    const f = a.facts();
    const svg = isoSvg(buildAvatar(look, f.stats, f.situation).voxels, { shadow: true, headroom: 2, className: "mood-idle", style: AVATAR_CSS, label: "Preview" });
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
  });
  /** Pause, play or hide it on Today: the page script sends it quietly, a plain form goes back to Today. */
  app.post("/avatar/today", async (c) => {
    const form = await c.req.parseBody();
    await a.setToday(ctx.db, todayModeOf(typeof form.mode === "string" ? form.mode : undefined));
    ctx.publish(["avatar"]);
    if (c.req.header("x-dovre-send") === "1") return c.body(null, 204);
    return c.redirect("/", 303);
  });
  app.get("/avatar/now", (c) => c.json(a.now(), 200, { "cache-control": "no-store" }));
  app.get("/avatar", (c) => {
    const f = a.facts();
    const body = avatarPage({ from: ctx.hosted ? "GitHub" : "GHE", now: a.now(), look: a.look(), today: a.today(), stats: f.stats, gathered: f.gathered, why: f.situation.why, saved: c.req.query("saved") === "1" });
    return ctx.page(c, { title: "Your avatar · Bino", current: "/bino", body, head: html`<meta name="u-topics" content="avatar">` });
  });
  app.post("/avatar", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const one = (k: string) => (Array.isArray(form[k]) ? String((form[k] as unknown[])[0]) : typeof form[k] === "string" ? (form[k] as string) : undefined);
    const shown = ([] as unknown[]).concat(form.show ?? []).map(String);
    if (one("today")) await a.setToday(ctx.db, todayModeOf(one("today")));
    await a.setLook(ctx.db, lookOf({ creature: one("creature"), body: one("body"), finish: one("finish"), show: Object.fromEntries(Object.keys(EXTRAS).map((k) => [k, shown.includes(k)])) }));
    ctx.publish(["avatar"]);
    return c.redirect("/avatar?saved=1", 303);
  });
}

/** The picture for a situation without an Avatar (tests, the lab). */
export const avatarFor = (look: Look, stats: Parameters<typeof buildAvatar>[1], signals: Parameters<typeof situationOf>[0]) => isoSvg(buildAvatar(look, stats, situationOf(signals)).voxels, { shadow: true });
