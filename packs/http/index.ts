/**
 * HTTP client Pack (`http`): a request editor inside Dovre, so there's no switching to Postman.
 *
 * Local only: requests go out from this machine (localhost and VPN-only services included). That
 * makes every route here something another site must never drive, so all of /http sits behind
 * core's strictOrigin (exact Origin on every POST, a 404 for anything another site started), and:
 *  - Nothing is sent on a GET or in the background: a send is one click on POST /http/send. It's
 *    declared one click on purpose (sending is the point), and logged to the actions table
 *    (`http.send`: method, host and path, the status; never the query, headers or body).
 *  - Secrets come from this instance's settings (HTTP_SECRETS names them, each bound to the hosts
 *    it may go to); they're never written to a repo file, a log or a page (masked as ••••).
 *  - Responses stay in memory (MAX_HISTORY sends, MAX_RESPONSE bytes each), never stored.
 *  - Saving writes `.http/<name>.http` in a checkout directly under CODE_DIR (`http.save`, logged):
 *    a new file or a request added to the end is one click (nothing that was there changes);
 *    replacing a request in a file is a two-click Confirm (`http.replace`, one click if I set it so on
 *    Settings → Writes). Both re-check the file first.
 *  - Agents (agent.ts): drafted prompts on core's /agents/new, and the `send` tool (agent-send.ts) on
 *    Dovre's MCP server (Pack.tools): a running agent turn's GET or HEAD, only to this machine or HTTP_AGENT_HOSTS,
 *    secrets bound as for any send, the answer masked and cut short, in history, logged. Its
 *    `catalog` and `run` tools (agent-tools.ts) run a committed story, writes only where the env
 *    file allows agents to, logged as `http.agentRun`.
 *  - Chaining (chain.ts): `{{login.response.body.token}}` takes a value from the newest send in
 *    history of the request named login (a story carries values with take: instead). Masked
 *    values aren't reused, and the value meets the same host check and secret binding as typed text.
 *  - Running an endpoint's cases (quick-routes.ts, checks.ts): each held to its `# @expect` checks,
 *    re-checked against the file as it was shown. Logged as `http.run`.
 *  - Running a story (story.ts, runner.ts, stories-routes.ts): GET /http/story shows its steps,
 *    sending nothing; one click runs them with their setups, re-checked against every file as shown.
 *    Logged as `http.run`; the newest runs of each story are kept without values or responses.
 *  - A span on otel-sink's trace page (its place "otel-sink/span.actions", trace.ts) opens in the editor
 *    from what the trace kept (method, route, a query-less URL): nothing is sent.
 *  - Importing curl, an OpenAPI spec or a Postman / Bruno collection (import-routes.ts) only reads
 *    the text: nothing is fetched or sent. Saving the requests adds them to a new file or the end of one (`http.save`, one click).
 *
 * Routes live by view: the Quick view (quick-routes.ts), sending and the response page
 * (send-routes.ts), saving (save-routes.ts), importing (import-routes.ts), stories
 * (stories-routes.ts). What they all send through is sending.ts.
 */
import { html } from "hono/html";
import { type Pack, strictOrigin } from "dovre/pack.ts";
import { styles as jsonStyles } from "../json/view.ts";
import { agentHosts } from "./agent.ts";
import { sendTool } from "./agent-send.ts";
import { createAgentTools } from "./agent-tools.ts";
import { createResults, type Results } from "./cases.ts";
import { mountImport } from "./import-routes.ts";
import { createQuick } from "./quick-routes.ts";
import { quickStyles } from "./quick-view.ts";
import { mountSave } from "./save-routes.ts";
import { createHistory, type History } from "./send.ts";
import { mountSend } from "./send-routes.ts";
import { createSending, type Draw } from "./sending.ts";
import { createStories } from "./stories-routes.ts";
import { storiesStyles } from "./stories-view.ts";
import { spanActions } from "./trace.ts";
import { importPage } from "./view.ts";

export type CreateHttpPackOpts = { fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number; /** How a story's until: waits between tries (tests pass a quick one). */ wait?: (ms: number) => Promise<void> };

export function createHttpPack(opts: CreateHttpPackOpts = {}): Pack & { history(): History; results(): Results } {
  const history = createHistory();
  const results = createResults();
  const sending = createSending({ history, now: opts.now ?? Date.now, fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs });
  const { secretsOf, varsFor } = sending;

  const quick = createQuick({ ...sending, results });
  const stories = createStories({ ...sending, wait: opts.wait });
  const agentTools = createAgentTools({ stories, secretsOf, varsFor });

  const draw: Draw = (ctx, c, r, w, extra = {}, status = 200) => {
    if (extra.curl !== undefined || extra.spec !== undefined) {
      const body = importPage({ flash: extra.flash, curl: extra.curl, spec: extra.spec });
      return ctx.page(c, { title: "Import requests", body, current: "/http" }).then((res) => (status === 200 ? res : new Response(res.body, { status, headers: res.headers })));
    }
    return quick.render(ctx, c, { where: w, ep: extra.ep, req: r.url ? r : undefined, blanks: extra.blanks, flash: extra.flash, curlOut: extra.curlOut, status });
  };

  return {
    history: () => history,
    results: () => results,
    // The JSON tools' tree and diff classes, for a response body shown as a tree or compared.
    styles: jsonStyles + quickStyles + storiesStyles,
    manifest: {
      api: "2.0",
      db: "raw",
      version: "1.2.1",
      id: "http",
      name: "HTTP client",
      description: "Send HTTP requests from this machine; saved per repo as .http files, with environments and secrets bound to hosts.",
      domain: "general",
      execution: "local-only",
      private: true,
      uses: ["otel-sink"],
      settings: [
        { key: "HTTP_SECRETS", label: "Secrets and their hosts", namesKeys: true, help: "NAME@host entries, comma separated (API_TOKEN@api.example.com, LOCAL_KEY@localhost:3000). {{NAME}} is filled from this machine's setting NAME, and only in a request to one of its hosts." },
        { key: "HTTP_AGENT_HOSTS", label: "Hosts an agent may send to", help: "Agents Dovre starts can send GET and HEAD requests through this client (its send tool), to this machine (localhost) and the hosts listed here (api.staging.example.com, host:port), comma separated. off: agents can't send." },
        { key: "HTTP_ENVS", label: "Environments", help: 'Your own environments, as JSON: {"local": {"baseUrl": "http://localhost:3000"}}. Public values only; a repo adds its own in .http/http-client.env.json.' },
      ],
    },

    writes: [{ kind: "replace", label: "Replace a saved request in a .http file" }],

    available: (ctx) => !ctx.hosted,

    tools: (ctx) => {
      const listed = agentHosts(ctx.env.HTTP_AGENT_HOSTS);
      return listed ? [sendTool(sending, listed), ...agentTools.tools(listed)] : [];
    },

    nav: () => [{ href: "/http", title: "HTTP", icon: "arrow", group: "Code" }],

    pages: () => [{ title: "HTTP client", href: "/http", icon: "↗", about: "Send HTTP requests, saved as .http files", also: ["http", "rest", "api", "curl", "postman", "request"] }],

    about: (_ctx, path) => (path.startsWith("/http") ? "The HTTP client (requests and responses aren't shared)." : undefined),

    slots: () => ({
      "actions.what": ({ kind }) => (kind === "http.send" ? "Sent an HTTP request" : kind === "http.run" ? "Ran HTTP requests as a test (cases or a story)" : kind === "http.agentRun" ? "An agent ran an HTTP story" : kind === "http.save" ? "Saved an HTTP request to a repo" : undefined),
      // otel-sink's own place (API 1.39), and core's old name for it until Pack API 2.0, for an otel-sink copy that still fills that one.
      "otel-sink/span.actions": spanActions,
    }),

    settings: (ctx) => {
      const s = secretsOf(ctx);
      return s.length
        ? html`<p class="notes">Secrets: ${s.map((x, i) => html`${i ? ", " : ""}<code>${x.name}</code> to ${x.hosts.join(", ")}${x.value ? "" : " (not set on this machine)"}`)}.</p>`
        : html`<p class="notes">No secrets yet: name them in HTTP_SECRETS, each with the hosts it may go to.</p>`;
    },

    routes(app, ctx) {
      app.use("/http", strictOrigin);
      app.use("/http/*", strictOrigin);

      quick.mount(app, ctx);
      stories.mount(app, ctx);
      mountSend(app, ctx, { sending, quick, draw });
      mountSave(app, ctx, { sending, draw });
      mountImport(app, ctx, { sending, draw });
    },
  };
}

export const httpPack: Pack = createHttpPack();
