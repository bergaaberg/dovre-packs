/**
 * The avatar's script (Pack.script), served beside the core's and run on every page while the pack
 * is on. Its image changes mood and picture as things happen: working while an agent or Bino works;
 * a hop and a line when something rings (ask when an agent needs me, done when one finished, pop
 * otherwise); the scene follows /avatar/now. Text goes in with textContent; links only to this
 * app's paths or what a notification already carries. It hears the core on `document`
 * (`dovreOn`, and `dovre:swap` on `document`).
 */
export const AVATAR_JS = String.raw`
// Still when the system asks for less motion, unless Settings → Look → Motion says Always.
const AV_STILL = document.documentElement.dataset.motion !== "always" && matchMedia("(prefers-reduced-motion: reduce)").matches;
let avNow = null;
let avHold = 0;
let avTimer = 0;
function avSrc(img, mood) {
  const k = avNow?.key ?? new URL(img.src, location.href).searchParams.get("k") ?? "";
  return "/avatar/image.svg?k=" + encodeURIComponent(k) + "&m=" + mood + "&f=" + (img.dataset.f || "l") + "&b=" + (img.dataset.b || "0") + (AV_STILL || img.dataset.s === "1" ? "&s=1" : "");
}
function avMood(mood, force) {
  for (const img of document.querySelectorAll("img[data-av]")) {
    const src = avSrc(img, mood);
    if (force || img.getAttribute("src") !== src) { img.dataset.mood = mood; img.setAttribute("src", src); }
  }
}
const avRest = () => (avNow?.busy || document.querySelector("[data-pending]") ? "working" : "idle");
function avSay(text, o = {}) {
  const host = document.getElementById("bdock") || document.querySelector(".av-hero");
  if (!host || !text) return;
  const up = host.querySelector(".av-say");
  // The same line again (a burst of changes as the page loads) stays put instead of popping in anew.
  if (up && up.textContent === text) {
    avHold = Date.now() + 7000;
    clearTimeout(avTimer);
    avTimer = setTimeout(() => { up.remove(); avMood(avRest()); }, 7000);
    return;
  }
  up?.remove();
  const b = document.createElement("div");
  b.className = "av-say" + (o.tone === "bad" || o.tone === "warn" ? " " + o.tone : "");
  b.setAttribute("role", "status");
  if (o.href && (o.href.startsWith("/") && !o.href.startsWith("//") || /^https:\/\//.test(o.href))) {
    const a = document.createElement("a");
    a.href = o.href;
    a.textContent = text;
    if (!o.href.startsWith("/")) { a.target = "_blank"; a.rel = "noopener"; }
    b.append(a);
  } else b.textContent = text;
  host.append(b);
  avMood(o.mood || "pop", true);
  avHold = Date.now() + 7000;
  clearTimeout(avTimer);
  avTimer = setTimeout(() => { b.remove(); avMood(avRest()); }, 7000);
}
// A region swapped in keeps what the avatar is doing: its line stays up and its mood holds.
function avKeep(from, to) {
  const say = from.querySelector(".av-say");
  if (say) to.querySelector(".av-hero")?.append(say);
  for (const img of from.querySelectorAll("img[data-av]")) {
    const next = to.querySelector('img[data-av="' + img.dataset.av + '"]');
    if (next && img.dataset.mood && Date.now() < avHold) { next.dataset.mood = img.dataset.mood; next.setAttribute("src", avSrc(next, img.dataset.mood)); }
  }
}
// What can move the avatar: its own topic, the snapshot its mood reads, the machines, and a note
// (dovreOn, src/ui/on.js.ts in core: one ask at a time, none while the tab is hidden).
async function avatarChange(c) {
  if (!document.querySelector("img[data-av]")) return;
  for (const n of (c?.notes || []).slice(-1)) avSay(n.title, { href: n.url, mood: n.kind === "agent-ask" ? "ask" : n.kind === "agent-done" ? "done" : "pop", tone: n.kind === "ci" ? "bad" : n.kind === "deploy" ? "warn" : "" });
  await avAsk();
}
async function avAsk() {
  let now;
  try { now = await (await fetch("/avatar/now", { headers: { accept: "application/json" } })).json(); } catch { return; }
  const wasKey = avNow?.key;
  avNow = now;
  if (now.scene) for (const f of document.querySelectorAll(".av-face")) f.dataset.scene = now.scene;
  for (const w of document.querySelectorAll("[data-av-why]")) w.textContent = (now.why || []).slice(0, 2).join(" · ");
  let seen = 0;
  try { seen = Number(sessionStorage.getItem("av-said")) || 0; } catch {}
  // Only a fresh line: one from minutes ago isn't news to a page opened now.
  if (now.say && now.say.at > seen && Date.now() - now.say.at < 120_000) {
    try { sessionStorage.setItem("av-said", String(now.say.at)); } catch {}
    return avSay(now.say.text, { href: now.say.href, tone: now.say.tone, mood: now.say.tone === "bad" ? "ask" : "pop" });
  }
  if (Date.now() > avHold) avMood(avRest(), wasKey !== undefined && wasKey !== now.key);
}
// Today's avatar: pause or play it, or take it off Today, at once; the choice is kept in the background
// (a plain form post when there's no script). Pointing at it while it moves makes it hop.
function avControl(e, form) {
  const btn = e.submitter;
  if (!btn || e.defaultPrevented) return;
  e.preventDefault();
  const mode = btn.value;
  const fig = form.closest(".av-hero");
  const body = new URLSearchParams({ mode });
  fetch(form.action, { method: "POST", body, credentials: "same-origin", headers: { "x-dovre-send": "1" } }).catch(() => {});
  if (!fig) return;
  if (mode === "hide") {
    fig.classList.add("going");
    setTimeout(() => fig.remove(), AV_STILL ? 0 : 220);
    return;
  }
  const still = mode === "still";
  fig.classList.toggle("still", still);
  const img = fig.querySelector("img[data-av]");
  if (img) {
    if (still) img.dataset.s = "1"; else delete img.dataset.s;
    img.setAttribute("src", avSrc(img, img.dataset.mood || "idle"));
  }
  btn.value = still ? "move" : "still";
  btn.title = still ? "Play" : "Pause";
  btn.setAttribute("aria-label", still ? "Play the avatar" : "Pause the avatar");
  btn.setAttribute("aria-pressed", still ? "true" : "false");
  const ico = btn.querySelector(".av-ico");
  if (ico) ico.className = "av-ico " + (still ? "play" : "pause");
}
let avPoked = 0;
document.addEventListener("pointerover", (e) => {
  const img = e.target.closest && e.target.closest('.av-hero img[data-av="hero"]');
  if (!img || AV_STILL || img.dataset.s === "1" || Date.now() < avHold || Date.now() - avPoked < 6000) return;
  if (img.dataset.mood !== "idle") return;
  avPoked = Date.now();
  img.dataset.mood = "pop";
  img.setAttribute("src", avSrc(img, "pop"));
  setTimeout(() => { if (img.dataset.mood === "pop" && Date.now() > avHold) { const m = avRest(); img.dataset.mood = m; img.setAttribute("src", avSrc(img, m)); } }, 1800);
});
// The crafting page: the stage shows the look being picked before it's saved, in a scene being tried.
{
  const form = document.querySelector("[data-av-form]");
  const stage = document.querySelector('img[data-av="stage"]');
  if (form && stage) form.addEventListener("change", () => {
    const q = new URLSearchParams(new FormData(form));
    stage.removeAttribute("data-av");
    stage.setAttribute("src", "/avatar/preview.svg?" + q.toString());
    // Trying a scene: the stage's line says what it would, and stops following how things are.
    const scene = form.querySelector('input[name="scene"]:checked');
    const why = document.querySelector(".av-stage .av-why");
    if (why && (scene && scene.value !== "now" || form.querySelector('input[name="try"]:checked'))) {
      why.removeAttribute("data-av-why");
      why.textContent = (scene?.dataset.say ? scene.dataset.say + " " : "") + "(Trying: nothing is kept.)";
    }
  });
}
// Before the core's own submit handler (it runs on the bubble): the choice goes in the background.
document.addEventListener("submit", (e) => { if (e.target.matches?.("form[data-av-ctl]")) avControl(e, e.target); }, true);
document.addEventListener("dovre:swap", (e) => avKeep(e.detail.from, e.detail.to));
dovreOn(["avatar", "snapshot", "mac"], avatarChange, { notes: true });
if (document.querySelector("img[data-av]") && window.top === window) setTimeout(() => avatarChange(), 400);
`;
