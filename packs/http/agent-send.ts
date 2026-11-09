/**
 * HTTP client (`http`): the `send` tool on Dovre's MCP server. A running agent turn's GET or HEAD,
 * only to this machine or HTTP_AGENT_HOSTS, secrets bound as for any send, the answer masked and
 * cut short, in history, logged as `http.send` by an agent.
 */
import type { PackContext, PackTool, ToolCall, ToolResult } from "dovre/pack.ts";
import { AGENT_BODY, AGENT_METHODS, agentMayReach, forAgent } from "./agent.ts";
import { blankReq, headerLines, masker, MAX_URL, type Req } from "./model.ts";
import { type Sending, str } from "./sending.ts";
import { noWhere, type Where } from "./view.ts";

/** An agent's GET or HEAD, to this machine or a host I listed; what came back, masked. */
async function agentSend(d: Sending, ctx: PackContext, a: Record<string, unknown>, call: ToolCall, listed: string[]): Promise<ToolResult> {
  const method = typeof a.method === "string" ? a.method.toUpperCase() : "GET";
  if (!(AGENT_METHODS as readonly string[]).includes(method)) return { text: `Only ${AGENT_METHODS.join(" and ")} requests: an agent can read, not change things. Nothing was sent.`, error: true };
  const url = str(a.url, MAX_URL).replace(/[\r\n]/g, "").trim();
  if (!url) return { text: "A url is needed.", error: true };
  const headers: [string, string][] = a.headers && typeof a.headers === "object" && !Array.isArray(a.headers) ? Object.entries(a.headers as Record<string, unknown>).slice(0, 50).flatMap(([k, v]) => (typeof v === "string" ? headerLines(`${k}: ${v.slice(0, 4000)}`) : [])) : [];
  const r: Req = { ...blankReq(), method: method as Req["method"], url, headers };
  const w: Where = { ...noWhere(), env: str(a.env, 64), repo: call.repo };
  const p = d.prepare(ctx, r, w);
  if (!p.ok) return { text: p.error, error: true };
  if (!agentMayReach(p.url, listed)) {
    const host = masker(d.secretsOf(ctx))(new URL(p.url).host);
    return { text: `An agent may only send to this machine (localhost) or the hosts in HTTP_AGENT_HOSTS; ${host} isn't one. Nothing was sent.`, error: true };
  }
  const { s, settled } = d.start(ctx, r, w, p, "agent");
  await settled;
  return { text: forAgent(s), error: s.state !== "done" };
}

/** The tool, for the hosts listed in HTTP_AGENT_HOSTS. */
export function sendTool(d: Sending, listed: string[]): PackTool {
  const where = ["this machine (localhost)", ...listed].join(", ");
  return {
    name: "send",
    description: `Send a GET or HEAD request through Dovre's HTTP client and get the response back (status, a few headers, the body cut at ${AGENT_BODY} characters). Only to ${where}; anything else is refused. {{name}} fills in from the environment (env) and the repo's .http/http-client.env.json; a secret {{NAME}} fills in only for the hosts it's bound to, and its value never comes back (shown as ••••). No redirects are followed; 30 s at most. Each send shows in the HTTP client's history.`,
    input: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...AGENT_METHODS], description: "GET (default) or HEAD." },
        url: { type: "string", description: "http:// or https:// URL; may use {{baseUrl}} and other variables." },
        headers: { type: "object", additionalProperties: { type: "string" }, description: 'Request headers, e.g. {"Accept": "application/json", "Authorization": "Bearer {{API_TOKEN}}"}.' },
        env: { type: "string", description: "An environment's name, for its variables." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    run: (a, c, call) => agentSend(d, c, a, call, listed),
  };
}
