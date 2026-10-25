/**
 * Slack Pack (`slack`): direct mentions in watched channels and saved items, a dock beside
 * Bino's, saved-message proposals for My list, and a Bino act that sends a message.
 */
import { html } from "hono/html";
import { type Pack, PACK_API, type PackNeed } from "dovre/packs/types.ts";
import { logAction } from "dovre/actions/deploys.ts";
import { addTodo } from "dovre/todo/store.ts";
import { checkChannel, type SlackKept, readSlack, sendSlack } from "./data.ts";
import { slackCard, slackDock, slackPage } from "./view.ts";

export function createSlackPack(opts: { fetchFn?: typeof fetch } = {}): Pack & { kept(): SlackKept | undefined } {
  const fetchFn = opts.fetchFn ?? fetch;
  let kept: SlackKept | undefined;
  const dismissed = new Set<string>(); // saved items I've let go from My list's proposals
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: "slack",
      name: "Slack",
      description: "Direct mentions in watched channels and saved items from Slack, with a dock beside Bino's and proposals for My list.",
      domain: "work",
      execution: "any",
      everyMs: 3 * 60_000,
      settings: [
        { key: "SLACK_TOKEN", label: "Slack token", secret: true, required: true, help: "A user (xoxp-) or bot (xoxb-) token" },
        { key: "SLACK_CHANNELS", label: "Channels to watch", help: "Channel names or IDs, comma-separated (saved items need a user token)" },
      ],
      rings: [{ kind: "slack", label: "A direct mention", hint: "Someone names you in a watched channel" }],
    },
    async refresh(ctx) {
      kept = await readSlack(ctx, fetchFn);
      ctx.publish(["slack", "snapshot"]);
    },
    nav: () => [{ href: "/slack", title: "Slack", icon: "chat", group: "" }],
    pages: () => [{ title: "Slack", href: "/slack", icon: "💬", about: "Mentions and saved items", also: ["mentions", "chat"] }],
    routes(app, ctx) {
      app.get("/slack", (c) => ctx.page(c, { title: "Slack", body: slackPage(kept) }));
      app.get("/slack/dock", (c) => ctx.dockPage(c, { title: "Slack", body: slackDock(kept) }));
      /** A saved message becomes an ordinary item on My list (or is let go). */
      const proposal = (key: string): SlackKept["saved"][number] | undefined => kept?.saved.find((s) => s.key === key && !dismissed.has(key));
      app.post("/slack/proposal/:key/add", async (c) => {
        const m = proposal(c.req.param("key"));
        if (m) {
          await addTodo(ctx.db, { title: `Follow up in #${m.channel}: ${m.text || "a saved message"}`.slice(0, 200) });
          dismissed.add(m.key);
          ctx.publish(["slack"]);
        }
        return c.redirect("/todo");
      });
      app.post("/slack/proposal/:key/dismiss", (c) => {
        const m = proposal(c.req.param("key"));
        if (m) {
          dismissed.add(m.key);
          ctx.publish(["slack"]);
        }
        return c.redirect("/todo");
      });
    },
    dock: () =>
      kept?.ok
        ? {
            label: "Slack",
            count: kept.mentions.length || undefined,
            hot: kept.mentions.length > 0,
            title: kept.mentions.length ? `${kept.mentions.length} mention${kept.mentions.length === 1 ? "" : "s"} today` : undefined,
          }
        : undefined,
    today: () => (kept?.ok && (kept.mentions.length || kept.saved.length) ? [{ id: "now", render: slackCard(kept) }] : []),
    needs(): PackNeed[] {
      if (!kept?.ok) return [];
      return kept.mentions.slice(0, 20).map((m) => ({
        key: m.key,
        title: `#${m.channel}: ${m.who} named you`,
        line: m.text.slice(0, 120) || undefined,
        href: "/slack",
        tone: "warn" as const,
        rank: 2,
        at: m.at,
        ring: "slack",
        label: "Slack",
      }));
    },
    slots(ctx) {
      return {
        /** Saved Slack messages, proposed for My list (Teams' crawler does the same). */
        "todo.proposals": () => {
          if (!kept?.ok) return "";
          const items = kept.saved.filter((s) => !dismissed.has(s.key)).slice(0, 5);
          if (!items.length) return "";
          return html`<section class="todo-group" aria-labelledby="g-slack"><h2 id="g-slack">From Slack <span class="t3">${items.length}</span></h2>
<p class="notes">Messages you saved. Nothing is on your list until you add it; once added, it's an ordinary item.</p>
<ul class="todo-list">${items.map((m) => html`<li class="todo-item proposal"><div class="todo-main"><p class="todo-title"><span>#${m.channel} · ${m.who}</span> <span class="t3">saved message</span></p><p class="notes">${m.text || "(no text)"}</p></div><form method="post" action="/slack/proposal/${encodeURIComponent(m.key)}/add" class="buttons"><button type="submit" class="sm primary">Add</button><button type="submit" class="sm ghost" formaction="/slack/proposal/${encodeURIComponent(m.key)}/dismiss">Dismiss</button></form></li>`)}</ul></section>`;
        },
      };
    },
    /** Counts and channel names only, for the assistant: never a message body. */
    bino: () => {
      if (!kept) return "";
      if (!kept.ok) return `Slack is not readable: ${kept.error ?? ""}`;
      const chans = kept.channels.map((c) => `#${c.name}`).join(", ");
      return `Slack: ${kept.mentions.length} direct mention${kept.mentions.length === 1 ? "" : "s"} today in ${chans}; ${kept.saved.length} saved item${kept.saved.length === 1 ? "" : "s"}.`;
    },
    avatar: () => (kept?.ok && kept.mentions.length ? { asking: kept.mentions.length } : null),
    acts(ctx) {
      const token = () => (ctx.env.SLACK_TOKEN ?? "").trim();
      return [
        {
          kind: "send",
          title: "A Slack message",
          when: "I want to say something in one of the watched Slack channels, optionally as a reply in a thread.",
          fields: [
            { name: "channel", about: "the watched channel's name or ID", required: true, max: 60 },
            { name: "text", about: "the message", required: true, max: 4000, text: true },
            { name: "thread", about: "the timestamp of the message to reply to, e.g. 1234567890.123456", max: 30 },
          ],
          button: "Send",
          hint: "Sends the message from you in that channel.",
          question: "Send this Slack message?",
          inputs: (act) => html`${act.channel ?? ""}`,
          async run(form) {
            const key = token();
            const name = (form.channel ?? "").trim().replace(/^#/, "");
            const text = (form.text ?? "").trim().slice(0, 4000);
            const thread = (form.thread ?? "").trim();
            if (!key || !name || !text) return { ok: false, error: "Set SLACK_TOKEN, and give a channel and a message." };
            // Re-check: the channel must be one we watch, and Slack must still know it.
            const watched = kept?.channels.find((c) => c.id === name || c.name.toLowerCase() === name.toLowerCase());
            if (!watched) return { ok: false, error: `"${name}" is not a watched channel; add it to SLACK_CHANNELS first.` };
            const target = `#${watched.name}`;
            try {
              const chan = await checkChannel(key, watched.id, fetchFn);
              if (!chan) {
                await logAction(ctx.db, { kind: "slack.send", target, ok: false, error: "channel gone" });
                return { ok: false, error: `Slack no longer knows ${target}.` };
              }
              await sendSlack(key, chan.id, text, /^\d+\.\d+$/.test(thread) ? thread : undefined, fetchFn);
              await logAction(ctx.db, { kind: "slack.send", target, ok: true }); // never the message body
              return { ok: true, done: `Sent in ${target}`, href: "/slack" };
            } catch (e) {
              const error = String((e as Error)?.message ?? e);
              await logAction(ctx.db, { kind: "slack.send", target, ok: false, error });
              return { ok: false, error };
            }
          },
        },
      ];
    },
  };
}

export const slackPack: Pack = createSlackPack();
export const slackCrate = slackPack;
