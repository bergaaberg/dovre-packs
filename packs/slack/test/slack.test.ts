/** Slack Pack (`slack`) tests: a fake Slack Web API answers; no real Slack is touched. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { D1 } from "dovre/db.ts";
import { testContext } from "dovre/packs/testing.ts";
import { snippet, wantedChannels } from "../data.ts";
import { createSlackPack } from "../index.ts";
import { slackCard, slackDock, slackPage } from "../view.ts";

const ME = "U123";
const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;

/** The fake Slack: mentions in #general (one hostile), a saved item, and the send endpoint. */
const API = {
  "auth.test": { ok: true, user_id: ME },
  "conversations.list": { ok: true, channels: [{ id: "C1", name: "general" }, { id: "C2", name: "random" }] },
  "conversations.history:C1": {
    ok: true,
    messages: [
      { ts: "1770000000.000100", user: "U9", text: `hey <@${ME}> can you look at <https://x.example|this>` },
      { ts: "1770000000.000200", user: "U8", text: `${H} <@${ME}>` },
      { ts: "1770000000.000300", user: "U7", text: "no mention of me here" },
    ],
  },
  "conversations.history:C2": { ok: true, messages: [] },
  "stars.list": { ok: true, items: [{ channel: "C1", message: { ts: "1770000000.000400", user: "U6", text: "the deploy runbook" } }] },
  "conversations.info": { ok: true, channel: { id: "C1", name: "general" } },
};

/** Answers Slack API calls from the table above; records chat.postMessage calls. */
function fakeSlack() {
  const sent: { url: string; body: Record<string, string>; auth?: string }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/chat.postMessage")) {
      sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, string>, auth: new Headers(init?.headers).get("authorization") ?? undefined });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    const path = url.replace("https://slack.com/api/", "").split("?")[0]!;
    const chan = /channel=([^&]+)/.exec(url)?.[1];
    const body = API[`${path}:${chan}` as keyof typeof API] ?? (API as Record<string, unknown>)[path];
    if (!body) return new Response(JSON.stringify({ ok: false, error: "unknown_method" }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, sent };
}

/** A fake D1 that answers addTodo's reads and records every insert. */
function fakeDb() {
  const inserts: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => ({
          first: async () => ({ pos: 0 }),
          run: async () => {
            inserts.push({ sql, binds });
            return { results: [{ id: 1, parent: null, title: binds[1], notes: binds[2], state: "next", due: null, pos: 1, created_at: 0, updated_at: 0 }] };
          },
          all: async () => ({ results: [] }),
        }),
        all: async () => ({ results: [] }),
      };
    },
  } as unknown as D1;
  return { db, inserts };
}

const ENV = { SLACK_TOKEN: "xoxp-fake", SLACK_CHANNELS: "general" };

test("slack: snippet turns Slack markup into plain inert text", () => {
  assert.equal(snippet(`hey <@${ME}|Andreas> see <#C1|general> and <https://x.example|this>`), "hey Andreas see general and this");
  assert.equal(snippet(H).includes("<"), false);
  assert.equal(snippet(42), "");
  assert.deepEqual(wantedChannels("#General, C2,, random"), ["General", "C2", "random"]);
});

test("slack: reads mentions and saved items, rings needs once per message", async () => {
  const { fetchFn } = fakeSlack();
  const pack = createSlackPack({ fetchFn });
  await pack.refresh!(testContext({ env: ENV }));
  const kept = pack.kept()!;
  assert.ok(kept.ok);
  assert.equal(kept.me, ME);
  assert.equal(kept.mentions.length, 2); // the plain line and the hostile one; the quiet one is not kept
  assert.equal(kept.saved.length, 1);
  const needs = pack.needs!(testContext({ env: ENV }));
  assert.deepEqual(
    needs.map((n) => n.key),
    kept.mentions.map((m) => m.key),
  );
  assert.ok(needs.every((n) => n.ring === "slack" && n.href === "/slack"));
  // The dock counts mentions and runs hot; the avatar asks once each.
  const dock = pack.dock!(testContext({ env: ENV }))!;
  assert.equal(dock.count, 2);
  assert.equal(dock.hot, true);
  assert.deepEqual(pack.avatar!(testContext({ env: ENV })), { asking: 2 });
});

test("slack: bino sees counts and channel names, never a message body", async () => {
  const { fetchFn } = fakeSlack();
  const pack = createSlackPack({ fetchFn });
  await pack.refresh!(testContext({ env: ENV }));
  const bino = pack.bino!(testContext({ env: ENV }));
  assert.match(bino, /2 direct mentions today in #general/);
  for (const m of pack.kept()!.mentions) assert.ok(!bino.includes(m.text), `bino leaks "${m.text.slice(0, 20)}"`);
});

test("slack: hostile input comes out inert on the page, dock and card", async () => {
  const { fetchFn } = fakeSlack();
  const pack = createSlackPack({ fetchFn });
  await pack.refresh!(testContext({ env: ENV }));
  const kept = pack.kept()!;
  for (const out of [String(await slackPage(kept)), String(slackDock(kept)), String(slackCard(kept))]) {
    assert.ok(!out.includes("<script>"), "script escaped");
    assert.ok(!out.includes("<img"), "img escaped");
    assert.ok(!out.includes('href="javascript:'), "javascript: inert");
  }
});

test("slack: proposals come from saved items only, and only until handled", async () => {
  const { fetchFn } = fakeSlack();
  const pack = createSlackPack({ fetchFn });
  await pack.refresh!(testContext({ env: ENV }));
  const ctx = testContext({ env: ENV, db: fakeDb().db });
  const slots = pack.slots!(ctx);
  const proposals = String(slots["todo.proposals"]!({}));
  assert.ok(proposals.includes("From Slack"));
  assert.ok(proposals.includes("the deploy runbook"));
  assert.ok(proposals.includes('action="/slack/proposal/star%3AC1%3A1770000000.000400/add"'), "the key is URL-encoded, not a bare text echo");
  assert.ok(!proposals.includes("<script>"));
});

test("slack: a missing or bad token says so; channels must be configured", async () => {
  const pack = createSlackPack({ fetchFn: fakeSlack().fetchFn });
  await pack.refresh!(testContext({ env: {} }));
  assert.match(pack.kept()!.error!, /SLACK_TOKEN/);
  assert.equal(pack.dock!(testContext({ env: {} })), undefined);
  assert.equal(pack.needs!(testContext({ env: {} })).length, 0);
  await pack.refresh!(testContext({ env: { SLACK_TOKEN: "xoxp-fake" } }));
  assert.match(pack.kept()!.error!, /SLACK_CHANNELS/);
  const dying = createSlackPack({ fetchFn: (async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { headers: { "content-type": "application/json" } })) as typeof fetch });
  await dying.refresh!(testContext({ env: ENV }));
  assert.match(dying.kept()!.error!, /invalid_auth/);
});

test("slack: the send act re-checks the channel, posts, and logs without the body", async () => {
  const { fetchFn, sent } = fakeSlack();
  const { db, inserts } = fakeDb();
  const pack = createSlackPack({ fetchFn });
  const ctx = testContext({ env: ENV, db });
  await pack.refresh!(ctx);
  const act = pack.acts!(ctx)[0]!;
  // Not a watched channel: refused before anything is sent.
  const refused = await act.run({ channel: "secret-side-channel", text: "hi" }, {}, ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /not a watched channel/);
  assert.equal(sent.length, 0);
  // A watched one: sent with the token in the header, logged with only the channel.
  const done = await act.run({ channel: "#general", text: "deploying now", thread: "1770000000.000100" }, {}, ctx);
  assert.equal(done.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.auth, "Bearer xoxp-fake");
  assert.equal(sent[0]!.body.channel, "C1");
  assert.equal(sent[0]!.body.thread_ts, "1770000000.000100");
  const logged = inserts.find((i) => i.sql.includes("actions"));
  assert.ok(logged, "the send is logged");
  assert.ok(!JSON.stringify(logged!.binds).includes("deploying now"), "the body is never logged");
  // A channel Slack no longer knows: refused and logged as failed.
  const failing = fakeSlack();
  const { db: db3, inserts: inserts3 } = fakeDb();
  const gone = createSlackPack({
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/conversations.info?")
        ? new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { headers: { "content-type": "application/json" } })
        : failing.fetchFn(input, init)) as typeof fetch,
  });
  const ctx3 = testContext({ env: ENV, db: db3 });
  await gone.refresh!(ctx3);
  const failed = await gone.acts!(ctx3)[0]!.run({ channel: "general", text: "hi" }, {}, ctx3);
  assert.equal(failed.ok, false);
  assert.ok(inserts3.some((i) => i.sql.includes("actions") && i.binds[4] === 0));
});
