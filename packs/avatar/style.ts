/**
 * The avatar's styles, served as its pack's stylesheet (linked from every page): the animation
 * suite that also goes inside every SVG it draws, and where it sits on pages.
 */
import { BODIES, FINISHES } from "./model.ts";

/**
 * The animation suite: the same rules inside every avatar SVG (an SVG shown as
 * an image can't see this stylesheet) and in it. Units are the drawing's grid (a voxel is 2 tall).
 * A mood is a class on the root group: idle, working (an agent or Bino at work), pop (something
 * happened), ask (something needs me), done (something finished), sleep (night, nothing going on).
 * Scene parts move on their own: flames flicker, rain falls, confetti drifts, drones hover, steam
 * rises, the beacon blinks, stars twinkle. Nothing moves under prefers-reduced-motion.
 *
 * Its life on top: the root also says the scene (scene-fire, -storm, -party, -night, -calm) and the
 * creature (cr-dino, -fox, -owl, -troll). Idle, it blinks (the dino's binoculars glint instead), looks
 * about, wags and stretches now and then, each on its own long loop so they rarely line up. Each mood
 * and scene adds its own: reading while at work, a wiggle on pop, a happy dance when done, a curious tilt
 * on ask, a droop asleep; it dances at a party and shivers in a storm (in a fire it keeps calm).
 * These use the separate translate / rotate / scale properties, so they stack with the transform
 * animations above instead of replacing them.
 */
export const AVATAR_CSS = String.raw`
.av .av-all, .av .av-head, .av .av-tail, .av .av-flag, .av .av-fire, .av .av-rain, .av .av-confetti, .av .av-drone1, .av .av-drone2, .av .av-drone3, .av .av-steam, .av .av-shadow, .av .av-cloud { transform-box: fill-box; }
.av .av-all { transform-origin: 50% 100%; }
.av .av-shadow { transform-origin: 50% 50%; }
.av .av-tail { transform-origin: 100% 60%; animation: av-sway 2.6s ease-in-out infinite alternate; }
.av .av-flag { transform-origin: 0% 100%; animation: av-wave 1.6s ease-in-out infinite alternate; }
.av .av-lensL, .av .av-lensR, .av .av-lamp { animation: av-glow 4s ease-in-out infinite alternate; }
.av .av-lensR { animation-delay: -2s; }
.av .av-beacon { animation: av-blink .9s steps(2, jump-none) infinite; }
.av .av-fire { animation: av-flicker .45s steps(3, jump-none) infinite alternate; }
.av .av-over .av-fire { animation-delay: -.2s; }
.av .av-rain { animation: av-fall .9s linear infinite; }
.av .av-confetti { animation: av-drift 3.2s ease-in-out infinite alternate; }
.av .av-cloud { animation: av-float 6s ease-in-out infinite alternate; }
.av .av-drone1 { animation: av-hover 1.5s ease-in-out infinite alternate; }
.av .av-drone2 { animation: av-hover 1.7s ease-in-out -.6s infinite alternate; }
.av .av-drone3 { animation: av-hover 1.3s ease-in-out -1s infinite alternate; }
.av .av-steam { animation: av-steam 2.2s ease-out infinite; }
.av .av-sky { animation: av-glow 5s ease-in-out infinite alternate; }
.av.mood-idle .av-all { animation: av-breathe 3.4s ease-in-out infinite alternate; }
.av.mood-sleep .av-all { animation: av-breathe 6s ease-in-out infinite alternate; }
.av.mood-sleep .av-lensL, .av.mood-sleep .av-lensR { animation: none; opacity: .35; }
.av.mood-working .av-all { animation: av-breathe .9s ease-in-out infinite alternate; }
.av.mood-working .av-head { animation: av-nod .5s ease-in-out infinite alternate; }
.av.mood-working .av-lensL, .av.mood-working .av-lensR { animation: av-scan .7s ease-in-out infinite alternate; }
.av.mood-working .av-lensR { animation-delay: -.35s; }
.av.mood-working .av-tail { animation-duration: .8s; }
.av.mood-pop .av-all { animation: av-hop .8s cubic-bezier(.3, .7, .4, 1) 1, av-breathe 3.4s ease-in-out .8s infinite alternate; }
.av.mood-pop .av-shadow { animation: av-shadow .8s cubic-bezier(.3, .7, .4, 1) 1; }
.av.mood-done .av-all { animation: av-hop .7s cubic-bezier(.3, .7, .4, 1) 2, av-breathe 3.4s ease-in-out 1.4s infinite alternate; }
.av.mood-done .av-shadow { animation: av-shadow .7s cubic-bezier(.3, .7, .4, 1) 2; }
.av.mood-done .av-flag { animation-duration: .4s; }
.av.mood-ask .av-all { animation: av-peek 2.4s ease-in-out infinite; }
.av.mood-ask .av-lensL, .av.mood-ask .av-lensR { animation: av-blink .5s steps(2, jump-none) 3; }
.av .av-lensL, .av .av-lensR { transform-box: fill-box; transform-origin: 50% 50%; }
.av .av-head { transform-origin: 50% 100%; }
.av.mood-idle .av-head { animation: av-look 11s ease-in-out infinite; }
.av.mood-idle:not(.cr-dino) .av-lensL, .av.mood-idle:not(.cr-dino) .av-lensR { animation: av-glow 4s ease-in-out infinite alternate, av-shut 5.3s ease-in-out infinite; }
.av.mood-idle.cr-dino .av-lensL, .av.mood-idle.cr-dino .av-lensR { animation: av-glow 4s ease-in-out infinite alternate, av-glint 7.4s ease-out infinite; }
.av.mood-idle.av .av-lensR { animation-delay: -2s, -1.7s; }
.av.mood-idle .av-tail { animation: av-sway 2.6s ease-in-out infinite alternate, av-wag 8.6s ease-in-out infinite; }
.av.mood-idle .av-all { animation: av-breathe 3.4s ease-in-out infinite alternate, av-stretch 15s ease-in-out 4s infinite; }
.av.mood-working .av-all { animation: av-breathe .9s ease-in-out infinite alternate, av-read 3.2s ease-in-out infinite alternate; }
.av.mood-pop .av-head { animation: av-wiggle .6s ease-in-out .7s 1; }
.av.mood-done .av-head { animation: av-wiggle .55s ease-in-out .3s 3; }
.av.mood-done .av-tail { animation: av-sway 2.6s ease-in-out infinite alternate, av-wag 1.4s ease-in-out 2; }
.av.mood-ask .av-head { animation: av-tilt 2.4s ease-in-out infinite; }
.av.mood-sleep .av-head { animation: av-droop 6s ease-in-out infinite; }
.av.mood-sleep:not(.cr-dino) .av-lensL, .av.mood-sleep:not(.cr-dino) .av-lensR { scale: 1 .2; }
.av.scene-party.mood-idle .av-all, .av.scene-party.mood-working .av-all { translate: 0 0; animation: av-breathe 3.4s ease-in-out infinite alternate, av-dance .62s ease-in-out infinite alternate; }
.av.scene-party.mood-idle .av-shadow { animation: av-shadow .62s ease-in-out infinite alternate; }
.av.scene-storm.mood-idle .av-all { animation: av-breathe 3.4s ease-in-out infinite alternate, av-shiver 5s linear infinite; }
.av.scene-night.mood-idle .av-head { animation: av-droop 8s ease-in-out infinite; }
@keyframes av-look { 0%, 52%, 100% { rotate: 0deg; } 58%, 68% { rotate: -5deg; } 76%, 86% { rotate: 4deg; } 93% { rotate: 0deg; } }
@keyframes av-shut { 0%, 93%, 100% { scale: 1; } 95.5% { scale: 1 .1; } }
@keyframes av-glint { 0%, 88%, 100% { scale: 1; } 91% { scale: 1.18; opacity: 1; } }
@keyframes av-wag { 0%, 78%, 100% { rotate: 0deg; } 81%, 87% { rotate: 9deg; } 84%, 90% { rotate: -9deg; } 93% { rotate: 0deg; } }
@keyframes av-stretch { 0%, 86%, 100% { scale: 1; } 90% { scale: .98 1.07; } 94% { scale: 1.02 .96; } 97% { scale: 1; } }
@keyframes av-read { from { rotate: -1.5deg; } to { rotate: 1.5deg; } }
@keyframes av-wiggle { 0%, 100% { rotate: 0deg; } 25% { rotate: -7deg; } 75% { rotate: 7deg; } }
@keyframes av-tilt { 0%, 15%, 100% { rotate: 0deg; } 30%, 70% { rotate: 8deg; } }
@keyframes av-droop { 0%, 100% { translate: 0 0; rotate: 0deg; } 45%, 80% { translate: 0 1.2px; rotate: 3deg; } 84% { translate: 0 -.4px; rotate: -1deg; } }
@keyframes av-dance { from { translate: -.8px 0; rotate: -3deg; } to { translate: .8px -2.4px; rotate: 3deg; } }
@keyframes av-shiver { 0%, 60%, 80%, 100% { translate: 0 0; } 62%, 66%, 70%, 74%, 78% { translate: -.35px 0; } 64%, 68%, 72%, 76% { translate: .35px 0; } }
@keyframes av-breathe { from { transform: none; } to { transform: translateY(-1.2px) scaleY(1.012); } }
@keyframes av-nod { from { transform: none; } to { transform: translateY(1.4px); } }
@keyframes av-hop { 0% { transform: none; } 18% { transform: translateY(1px) scaleY(.93); } 50% { transform: translateY(-9px) scaleY(1.05); } 82% { transform: translateY(0) scaleY(.94); } 100% { transform: none; } }
@keyframes av-shadow { 0%, 100% { transform: none; opacity: .22; } 50% { transform: scale(.7); opacity: .12; } }
@keyframes av-peek { 0%, 70%, 100% { transform: none; } 80% { transform: translateY(-3px); } 90% { transform: translateY(-.5px); } }
@keyframes av-sway { from { transform: rotate(-3deg); } to { transform: rotate(3deg); } }
@keyframes av-wave { from { transform: skewY(-6deg); } to { transform: skewY(6deg); } }
@keyframes av-glow { from { opacity: .72; } to { opacity: 1; } }
@keyframes av-scan { from { opacity: .45; } to { opacity: 1; } }
@keyframes av-blink { from { opacity: 1; } to { opacity: .2; } }
@keyframes av-flicker { from { transform: none; opacity: 1; } to { transform: translateY(-1.5px) scaleY(1.08); opacity: .82; } }
@keyframes av-fall { from { transform: translateY(-4px); opacity: 0; } 20% { opacity: 1; } to { transform: translateY(10px); opacity: 0; } }
@keyframes av-drift { from { transform: translateY(-3px); } to { transform: translate(1px, 5px); } }
@keyframes av-float { from { transform: none; } to { transform: translateX(2px); } }
@keyframes av-hover { from { transform: translateY(-1.5px); } to { transform: translateY(1.5px); } }
@keyframes av-steam { from { transform: none; opacity: .9; } to { transform: translateY(-6px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .av, .av * { animation: none !important; } }
`;

/** Where the avatar sits on pages: the dock button, Today's header, Bino's page and pane, and what it says. */
export const AVATAR_PAGE_CSS = String.raw`
.av-img { display: block; width: 100%; height: auto; }
.face-btn .av-img { width: 76px; margin: -14px -6px 0; }
.av-face { display: contents; }
.face-btn:has(.av-face[data-scene="fire"]) { border-color: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft), var(--shadow); }
.face-btn:has(.av-face[data-scene="storm"]) { border-color: var(--warn); }
.face-btn:has(.av-face[data-scene="party"]) { border-color: var(--ok); }
@media (max-width: 900px) { body:has(.tab-gap) #bdock-btn.face-btn:has(.av-face[data-scene="fire"]) { box-shadow: 0 0 0 5px var(--bg), 0 0 0 8px var(--bad-soft), 0 10px 24px -10px var(--bad); } }
.av-say { position: absolute; right: 0; bottom: calc(100% + 10px); width: max-content; max-width: 260px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--line-2); background: var(--surface); color: var(--ink); font: 500 var(--fs-s)/1.35 var(--sans); box-shadow: var(--shadow); pointer-events: auto; animation: av-say-in .25s ease-out both; }
.av-say::after { content: ""; position: absolute; right: 26px; bottom: -6px; width: 10px; height: 10px; background: var(--surface); border-right: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); transform: rotate(45deg); }
.av-say a { color: var(--accent); }
.av-say.bad { border-color: var(--bad); } .av-say.warn { border-color: var(--warn); }
.av-hero { position: relative; width: 250px; }
.av-hero .av-img { max-height: 210px; width: auto; max-width: 100%; margin: 0 auto; }
.av-hero .av-say { right: auto; left: 50%; transform: translateX(-50%); bottom: calc(100% - 8px); }
.av-hero .av-say::after { right: calc(50% - 5px); }
.av-ctl { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s ease; }
.av-hero:hover .av-ctl, .av-ctl:focus-within, .av-hero.still .av-ctl { opacity: 1; }
@media (hover: none) { .av-ctl { opacity: .8; } }
.av-ctl button { display: inline-grid; place-items: center; width: 28px; height: 28px; min-height: 0; padding: 0; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface); color: var(--ink-2); box-shadow: var(--shadow); cursor: pointer; }
.av-ctl button:hover { color: var(--ink); background: var(--surface-2); }
.av-ico { position: relative; display: block; width: 10px; height: 10px; }
.av-ico.pause { width: 8px; border-left: 3px solid currentColor; border-right: 3px solid currentColor; box-sizing: border-box; }
.av-ico.play { width: 0; height: 0; margin-left: 3px; border-top: 5.5px solid transparent; border-bottom: 5.5px solid transparent; border-left: 9px solid currentColor; }
.av-ico.hide::before, .av-ico.hide::after { content: ""; position: absolute; left: -1px; top: 4px; width: 12px; height: 2px; border-radius: 1px; background: currentColor; rotate: 45deg; }
.av-ico.hide::after { rotate: -45deg; }
@keyframes av-leave { to { opacity: 0; translate: 0 8px; scale: .9; } }
.av-hero.going { animation: av-leave .22s ease-in both; pointer-events: none; }
.av-why { margin: 4px 0 0; font-size: var(--fs-xs); color: var(--ink-3); text-align: center; }
.av-mini { width: 56px; flex: none; }
.av-craft { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 380px); gap: 24px; align-items: start; }
.av-stage { border: 1px solid var(--line); border-radius: 16px; background: var(--sky); padding: 16px; }
.av-stage .av-img { max-height: 460px; }
.av-picks { display: flex; flex-wrap: wrap; gap: 8px; }
.av-pick { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--surface-2); cursor: pointer; font-size: var(--fs-s); }
.av-pick:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.av-pick input { accent-color: var(--accent); }
.av-sw { width: 14px; height: 14px; border-radius: 4px; flex: none; border: 1px solid var(--line-2); }
` + Object.entries(BODIES).map(([k, v]) => `.av-sw.b-${k} { background: ${v.body}; }`).join("\n") + "\n" + Object.entries(FINISHES).map(([k, v]) => `.av-sw.f-${k} { background: ${v.ring}; }`).join("\n") + String.raw`
.av-traits { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; font-size: var(--fs-s); }
.av-traits b { color: var(--ink); }
.av-traits span { color: var(--ink-3); }
@keyframes av-say-in { from { opacity: 0; translate: 0 6px; } to { opacity: 1; translate: none; } }
@media (max-width: 760px) { .av-craft { grid-template-columns: 1fr; } .av-hero { width: 160px; } }
@media (prefers-reduced-motion: reduce) { .av-say, .av-hero.going { animation: none; } .av-ctl { transition: none; } }
.tdock.open > .av-say { display: none; }
@media (max-width: 900px) {
  body:has(.tab-gap) .av-say { position: fixed; left: 50%; right: auto; bottom: calc(86px + var(--sab)); max-width: calc(100vw - 32px); transform: translateX(-50%); }
  body:has(.tab-gap) .av-say::after { right: calc(50% - 5px); }
  body:has(.side.open) .av-say { display: none; }
}
`;
