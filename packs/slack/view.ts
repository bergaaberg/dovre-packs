/** Slack Pack (`slack`) views. */
import { Card, Empty, type Html, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import { html } from "hono/html";
import { SNIPPET_MAX, type SlackKept, type SlackMsg } from "./data.ts";

const ago = (at: number) => {
  const m = Math.max(1, Math.round((Date.now() - at) / 60_000));
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

function mentionItem(m: SlackMsg) {
  return Item({
    href: "/slack",
    title: html`<strong>#${m.channel}</strong> · ${m.who}`,
    line: m.text.slice(0, SNIPPET_MAX) || "(no text)",
    trail: Pill({ tone: "warn", children: ago(m.at) }),
  });
}

export function slackPage(k: SlackKept | undefined) {
  return html`${PageHeader({ title: "Slack", sub: k?.ok ? `${k.channels.length} watched channel${k.channels.length === 1 ? "" : "s"}` : "Mentions and saved items" })}
<div data-live id="slack">
${k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Slack is not readable" }) : ""}
${Panel({
    title: "Direct mentions",
    meta: String(k?.mentions.length ?? 0),
    flush: true,
    children: k?.mentions.length ? List(k.mentions.map(mentionItem)) : Empty({ title: k?.ok ? "No one has named you today" : "Not read yet" }),
  })}
${Panel({
    title: "Watched channels",
    meta: String(k?.channels.length ?? 0),
    flush: true,
    children: k?.channels.length
      ? List(
          k.channels.map((c) =>
            Item({
              href: "/slack",
              lead: Pill({ tone: k.mentions.some((m) => m.channelId === c.id) ? "warn" : "neutral", children: `#${c.name}` }),
              title: k.mentions.some((m) => m.channelId === c.id) ? "You are named here" : "Quiet today",
              quiet: true,
            }),
          ),
        )
      : Empty({ title: "No channels watched" }),
  })}
${Panel({
    title: "Saved for later",
    meta: String(k?.saved.length ?? 0),
    flush: true,
    children: k?.saved.length ? List(k.saved.map((m) => Item({ href: "/slack", title: html`<strong>#${m.channel}</strong> · ${m.who}`, line: m.text || "(no text)", trail: Pill({ children: ago(m.at) }) }))) : Empty({ title: "Nothing starred lately" }),
  })}
</div>`;
}

/** The dock's compact page: what's newest, in a panel sized for the corner. */
export function slackDock(k: SlackKept | undefined): Html {
  const rows = k?.mentions.slice(0, 10) ?? [];
  return html`${k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Slack is not readable" }) : ""}${Panel({
    title: "Mentions",
    meta: String(rows.length),
    flush: true,
    children: rows.length ? List(rows.map(mentionItem)) : Empty({ title: k?.ok ? "No one has named you today" : "Not read yet" }),
  })}`;
}

export function slackCard(k: SlackKept) {
  return Card({
    id: "slack-now",
    title: "Slack",
    meta: html`<a href="/slack">Open</a>`,
    children: k.ok
      ? k.mentions.length
        ? List(k.mentions.slice(0, 5).map(mentionItem))
        : html`<p class="t2">${k.channels.length} channels watched, no mentions today</p>`
      : html`<p class="t2">${k.error ?? "Slack is not readable"}</p>`,
  });
}
