/**
 * Slack Pack (`slack`): direct mentions in watched channels and saved items, from the Slack Web
 * API. Bounded metadata in memory only — snippet lines, never full bodies or threads.
 */
import type { PackContext } from "dovre/packs/types.ts";

/** One message that concerns me: where, who, and its first line (kept short and inert). */
export type SlackMsg = {
  key: string; // `<channel id>:<ts>`
  channelId: string;
  channel: string; // its name, without the # (kept short)
  who: string;
  text: string; // first line, tags stripped, ≤140 chars
  at: number; // ms
};

export type SlackKept = {
  at: number;
  ok: boolean;
  error?: string;
  me: string; // my user id
  mentions: SlackMsg[];
  saved: SlackMsg[];
  channels: { id: string; name: string }[];
};

export const SNIPPET_MAX = 140;

/** A message's first line as text: Slack's `<@U1>`, `<#C1>` and links become plain words, nothing else survives. */
export function snippet(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<[^|<>]*\|([^>]*)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "$1")
    .replace(/<@(?:[^|>]+\|)?([^>]*)>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f<>]+/g, " ")
    .trim()
    .slice(0, SNIPPET_MAX);
}

/** The channels to watch: IDs, `#names`, or names, from one comma-separated setting. */
export function wantedChannels(setting: string | undefined): string[] {
  return (setting ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 20);
}

type SlackJson = Record<string, unknown>;

async function call(path: string, params: Record<string, string>, token: string, fetchFn: typeof fetch): Promise<SlackJson> {
  const url = `https://slack.com/api/${path}?${new URLSearchParams(params)}`;
  const res = await fetchFn(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
  const j = (await res.json()) as SlackJson;
  if (j.ok !== true) throw new Error(String(j.error ?? "Slack said no").slice(0, 120));
  return j;
}

function channelName(v: unknown): string {
  return typeof v === "string" ? v.replace(/[^\w.-]+/g, "-").slice(0, 40) : "";
}

const ms = (ts: unknown): number => {
  const n = typeof ts === "string" ? Number(ts) : 0;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n * 1000) : 0;
};

/** Slack's API rows, as far as they name a channel and a message. */
function toMsg(channelId: string, channel: string, row: unknown): SlackMsg | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as { ts?: unknown; user?: unknown; text?: unknown; bot_id?: unknown };
  const at = ms(r.ts);
  if (!at) return undefined;
  const who = typeof r.user === "string" && r.user ? r.user : typeof r.bot_id === "string" ? "a bot" : "someone";
  return { key: `${channelId}:${r.ts}`, channelId, channel, who: who.slice(0, 30), text: snippet(r.text), at };
}

/** Reads mentions and saved items. `sinceMs` bounds what history it asks for (default: the last day). */
export async function readSlack(ctx: PackContext, fetchFn: typeof fetch = fetch, now = Date.now(), sinceMs = 86_400_000): Promise<SlackKept> {
  const token = (ctx.env.SLACK_TOKEN ?? "").trim();
  const fail = (error: string): SlackKept => ({ at: now, ok: false, error, me: "", mentions: [], saved: [], channels: [] });
  if (!token) return fail("Set SLACK_TOKEN (a user or bot token) to read Slack.");
  try {
    const auth = await call("auth.test", {}, token, fetchFn);
    const me = typeof auth.user_id === "string" ? auth.user_id : "";
    const wanted = wantedChannels(ctx.env.SLACK_CHANNELS);
    if (!wanted.length) return { ...fail("Set SLACK_CHANNELS to the channels to watch (names or IDs, comma-separated)."), me };

    // Resolve names to IDs: list the channels I can see (up to 5 pages of 200), match case-insensitively.
    const rows: unknown[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const list = await call("conversations.list", { types: "public_channel,private_channel", limit: "200", exclude_archived: "true", ...(cursor ? { cursor } : {}) }, token, fetchFn);
      if (Array.isArray(list.channels)) rows.push(...list.channels);
      cursor = String((list.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor ?? "");
      if (!cursor) break;
    }
    const known = rows.flatMap((r) => {
      if (typeof r !== "object" || r === null) return [];
      const { id, name } = r as { id?: unknown; name?: unknown };
      return typeof id === "string" && id ? [{ id, name: channelName(name) }] : [];
    });
    const lower = new Map(known.map((c) => [c.name.toLowerCase(), c.id]));
    const channels: { id: string; name: string }[] = [];
    for (const w of wanted) {
      const c = known.find((x) => x.id === w) ?? known.find((x) => x.id === lower.get(w.toLowerCase()));
      // An ID past the listed pages (a big workspace): ask Slack for that one channel.
      const found = c ?? (/^[CG][A-Z0-9]{6,}$/.test(w) ? await checkChannel(token, w, fetchFn) : null);
      if (found && !channels.some((x) => x.id === found.id)) channels.push(found);
    }
    if (!channels.length) return { ...fail("None of SLACK_CHANNELS matched a channel I can see."), me };

    // Each watched channel's recent history: only messages naming me are kept.
    const mentions: SlackMsg[] = [];
    const needle = `<@${me}>`;
    for (const c of channels.slice(0, 8)) {
      const h = await call("conversations.history", { channel: c.id, limit: "50", oldest: String(Math.floor((now - sinceMs) / 1000)) }, token, fetchFn);
      for (const row of Array.isArray(h.messages) ? h.messages : []) {
        if (typeof row === "object" && row !== null && typeof (row as { text?: unknown }).text === "string") {
          if (((row as { text: string }).text as string).includes(needle)) {
            const m = toMsg(c.id, c.name, row);
            if (m) mentions.push(m);
          }
        }
      }
    }
    mentions.sort((a, b) => b.at - a.at);

    // Saved items (a user token's stars): proposals for My list.
    const stars = await call("stars.list", { count: "50" }, token, fetchFn).catch(() => ({ items: [] as unknown[] }));
    const saved: SlackMsg[] = (Array.isArray(stars.items) ? stars.items : []).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const i = item as { channel?: unknown; message?: unknown; ts?: unknown };
      const cid = typeof i.channel === "string" ? i.channel : "";
      const cname = typeof i.channel === "string" ? channelName((known.find((c) => c.id === i.channel) ?? { name: "" }).name) || "a saved item" : "a saved item";
      const m = toMsg(cid, cname, i.message ?? { ts: i.ts, text: "" });
      if (!m) return [];
      return [{ ...m, key: `star:${m.key}` }];
    });

    return { at: now, ok: true, me, mentions: mentions.slice(0, 30), saved: saved.slice(0, 20), channels };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e).slice(0, 180));
  }
}

/** The channel a form names, re-checked against Slack before a send. */
export async function checkChannel(token: string, channelId: string, fetchFn: typeof fetch = fetch): Promise<{ id: string; name: string } | null> {
  const j = await call("conversations.info", { channel: channelId }, token, fetchFn).catch(() => null);
  if (!j || typeof j.channel !== "object" || j.channel === null) return null;
  const c = j.channel as { id?: unknown; name?: unknown };
  return typeof c.id === "string" && c.id ? { id: c.id, name: channelName(c.name) } : null;
}

async function post(path: string, body: Record<string, string>, token: string, fetchFn: typeof fetch): Promise<SlackJson> {
  const res = await fetchFn(`https://slack.com/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
  const j = (await res.json()) as SlackJson;
  if (j.ok !== true) throw new Error(String(j.error ?? "Slack said no").slice(0, 120));
  return j;
}

/** Sends one message, returning the sending user's `ok`. */
export async function sendSlack(token: string, channelId: string, text: string, threadTs: string | undefined, fetchFn: typeof fetch = fetch): Promise<void> {
  await post("chat.postMessage", { channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, token, fetchFn);
}
