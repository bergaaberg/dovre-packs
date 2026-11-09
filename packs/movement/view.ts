/** The Moved page's view (#405). */
import { html } from "hono/html";
import type { Snapshot } from "dovre/gather.ts";
import { Ago, failed, safeUrl } from "dovre/pages/parts.ts";
import { byPerson, type Move } from "dovre/sources/ghe.ts";
import { Empty, type Html, Item, List, PageHeader, Panel, Tabs } from "dovre/ui/kit.ts";

function moveItem(m: Move, s: Snapshot, showActor: boolean) {
  const title = m.title ?? (m.ref ? s.refs.get(m.ref)?.title : undefined);
  const num = m.ref ? `#${m.ref.split("#")[1]} ` : "";
  return Item({
    href: safeUrl(m.url),
    title: html`${showActor ? html`<strong>${m.actor}</strong> ` : ""}${m.verb} ${num}${title ?? ""}`,
    line: m.repo.replace(`${s.org}/`, ""),
    trail: Ago(m.at),
    quiet: m.bot,
  });
}

/** /movement: what happened in the org in the last 24 hours, by person or as a timeline. */
export function movementBody(s: Snapshot, view: string): Html {
  const moves = s.moves.ok ? s.moves.value : [];
  const humans = moves.filter((m) => !m.bot && m.actor !== s.login);
  const bots = moves.filter((m) => m.bot);
  const mine = moves.filter((m) => m.actor === s.login);
  const tabs = Tabs({
    label: "Views",
    items: [
      { href: "/movement", label: "People", n: humans.length, current: view === "people" },
      { href: "/movement?view=timeline", label: "Timeline", n: humans.length, current: view === "timeline" },
      { href: "/movement?view=me", label: "Me", n: mine.length, current: view === "me" },
      { href: "/movement?view=bots", label: "Bots", n: bots.length, current: view === "bots" },
    ],
  });
  let content;
  if (view === "people")
    content = byPerson(humans).map((p) =>
      Panel({ id: `p-${p.who}`, title: p.who, meta: `${p.moves.length} · ${p.repos.map((r) => r.replace(`${s.org}/`, "")).join(", ")}`, flush: true, children: List(p.moves.map((m) => moveItem(m, s, false))) }),
    );
  else {
    const list = view === "bots" ? bots : view === "me" ? mine : humans;
    content = Panel({ flush: true, children: list.length ? List(list.map((m) => moveItem(m, s, view !== "me"))) : Empty({ title: "Nothing in the last 24 hours" }) });
  }
  return html`${PageHeader({ title: "Movement", sub: `What happened in ${s.org} in the last 24 hours.`, tabs })}${failed("Movement", s.moves)}<div data-live id="movement">${content}</div>`;
}
