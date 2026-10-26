/**
 * Jira through Claude Code and its Atlassian MCP (JIRA_VIA=mcp), for where API tokens are locked
 * down: a headless `claude -p` that may call only the Atlassian tools a job needs, nothing built in
 * (no Bash, no files), no settings, no other MCP servers, no session kept. It runs off the main
 * thread (core's `runOff`): starting claude.exe stalls whoever starts it for about a second.
 *
 * The model only makes the calls; what the pack keeps comes from the tools' own results, read out
 * of the stream (`--output-format stream-json`) and parsed strictly. Each result is matched to a
 * call with exactly the arguments asked for, so the model can't change what's read.
 *
 * Results over ~45k characters don't come back whole (Claude Code saves them to a file and shows
 * a preview), so searches ask for few fields: the moving list goes without type and assignee.
 */
import type { Ran } from "dovre/spawn.ts";
import { type JiraIssue, safeProjects, typesOf } from "./data.ts";
import { type RawCreateField, type Screen, TICKET_KEY } from "./tickets.ts";

export type RunOff = (bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number }) => Promise<Ran>;

export const ATLASSIAN_MCP = { mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } } };
const tool = (name: string) => `mcp__atlassian__${name}`;
export const SEARCH = tool("searchJiraIssuesUsingJql");
export const TYPES = tool("getJiraProjectIssueTypesMetadata");
export const FIELDS = tool("getJiraIssueTypeMetaWithFields");
export const CREATE = tool("createJiraIssue");
/** Everything in the Atlassian MCP that changes something: denied outright unless a job is allowed it. */
export const WRITES = [
  "createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addCommentToJiraIssue", "addWorklogToJiraIssue", "createIssueLink",
  "createConfluencePage", "updateConfluencePage", "createConfluenceFooterComment", "createConfluenceInlineComment",
].map(tool);

const SYSTEM = "You are a transport between a program and Jira. Make exactly the tool calls the user lists, with exactly the arguments given, nothing else. Then answer with the single word: done.";

/** The arguments for one job: only `allowed` may be called; built-in tools are off; only the Atlassian MCP loads. */
export function agentArgs(allowed: string[], model = "haiku"): string[] {
  const denied = WRITES.filter((t) => !allowed.includes(t));
  return [
    "-p",
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify(ATLASSIAN_MCP),
    "--allowedTools", allowed.join(","),
    ...(denied.length ? ["--disallowedTools", denied.join(",")] : []),
    "--disable-slash-commands",
    "--system-prompt", SYSTEM,
  ];
}

export type Call = { name: string; input: Record<string, unknown>; result?: string; error: boolean };
export type Stream = { mcp?: string; calls: Call[]; cost: number; isError: boolean; final?: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The stream's lines, as calls and their results. A line that isn't JSON is skipped. */
export function readStream(stdout: string): Stream {
  const out: Stream = { calls: [], cost: 0, isError: false };
  const byId = new Map<string, Call>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let m: Record<string, unknown>;
    try {
      m = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (m.type === "system" && m.subtype === "init" && Array.isArray(m.mcp_servers)) out.mcp = str(obj(m.mcp_servers.find((s) => obj(s).name === "atlassian")).status);
    const content = Array.isArray(obj(m.message).content) ? (obj(m.message).content as unknown[]) : [];
    if (m.type === "assistant")
      for (const c of content.map(obj))
        if (c.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string") {
          const call: Call = { name: c.name, input: obj(c.input), error: false };
          byId.set(c.id, call);
          out.calls.push(call);
        }
    if (m.type === "user")
      for (const c of content.map(obj)) {
        const call = typeof c.tool_use_id === "string" ? byId.get(c.tool_use_id) : undefined;
        if (!call || c.type !== "tool_result") continue;
        call.result = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => str(obj(x).text) ?? "").join("") : "";
        call.error = c.is_error === true;
      }
    if (m.type === "result") {
      out.cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0;
      out.isError = m.is_error === true;
      out.final = str(m.result);
    }
  }
  return out;
}

/** Claude Code isn't there, or its Atlassian MCP isn't signed in: the page says how, instead of failing. */
export class JiraSetupError extends Error {
  readonly setup: "no-claude" | "sign-in";
  constructor(setup: "no-claude" | "sign-in", message: string) {
    super(message);
    this.setup = setup;
  }
}

export type Agent = { run: RunOff; cwd: string; bin?: string; timeoutMs?: number };

/** Runs one job and reads its stream; a Jira that can't be reached says why. */
export async function runJob(a: Agent, prompt: string, allowed: string[]): Promise<Stream> {
  let r: Ran;
  try {
    r = await a.run(a.bin ?? "claude", agentArgs(allowed), { cwd: a.cwd, input: prompt, timeoutMs: a.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/ENOENT/.test(m)) throw new JiraSetupError("no-claude", "Claude Code isn't installed here (no `claude` on the PATH).");
    throw new Error(`Jira via Claude Code: ${m.slice(0, 200)}`);
  }
  const s = readStream(r.stdout);
  if (s.mcp && s.mcp !== "connected") throw new JiraSetupError("sign-in", `Claude Code's Atlassian MCP is ${s.mcp}.`);
  if (!s.mcp) throw new Error(`Jira via Claude Code: no answer (exit ${r.code}) ${r.stderr.slice(0, 160)}`);
  return s;
}

/** The result of the call to `name` made with exactly these arguments; throws when there's none or it failed. */
export function resultOf(s: Stream, name: string, input: Record<string, unknown>): string {
  const want = JSON.stringify(input, Object.keys(input).sort());
  const call = s.calls.find((c) => c.name === name && JSON.stringify(c.input, Object.keys(c.input).sort()) === want);
  const short = name.replace("mcp__atlassian__", "");
  if (!call) throw new Error(`the agent didn't make the ${short} call`);
  if (call.result === undefined) throw new Error(`${short} gave no result`);
  if (call.error || !/^\s*[{[]/.test(call.result)) throw new Error(`${short}: ${call.result.split("\n")[0]!.slice(0, 160)}`);
  return call.result;
}

export const KEY = /^[A-Z][A-Z0-9_]{0,20}-\d{1,9}$/;
const CATEGORIES = new Set(["new", "indeterminate", "done"]);

/** A search result as issues: only what has a ticket key and a summary; every other value checked or dropped. */
export function issuesOf(site: string, text: string): JiraIssue[] {
  const j = obj(JSON.parse(text));
  const nodes = Array.isArray(obj(j.issues).nodes) ? (obj(j.issues).nodes as unknown[]) : Array.isArray(j.issues) ? (j.issues as unknown[]) : null;
  if (!nodes) throw new Error("the search result has no issues");
  const out: JiraIssue[] = [];
  for (const n of nodes.map(obj)) {
    const key = str(n.key);
    const f = obj(n.fields);
    const summary = str(f.summary);
    if (!key || !KEY.test(key) || summary === undefined) continue;
    const status = obj(f.status);
    const cat = str(obj(status.statusCategory).key) ?? "";
    const updated = str(f.updated) ?? "";
    out.push({
      key,
      summary: summary.slice(0, 500),
      status: (str(status.name) ?? "").slice(0, 80),
      category: CATEGORIES.has(cat) ? cat : "new",
      project: key.slice(0, key.lastIndexOf("-")),
      type: (str(obj(f.issuetype).name) ?? "").slice(0, 80),
      assignee: str(obj(f.assignee).displayName)?.slice(0, 120) ?? null,
      updated: Number.isFinite(Date.parse(updated)) ? updated : "",
      url: `https://${site}/browse/${encodeURIComponent(key)}`,
    });
  }
  return out;
}

/** The two searches the page shows, in one job: what's mine and not done; what moved in my projects in 3 days. */
export function searches(site: string, projects: string[], jql?: string) {
  const ps = safeProjects(projects);
  const mine = { cloudId: site, jql: jql || "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", maxResults: 50, fields: ["summary", "status", "issuetype", "updated"] };
  const moving = ps.length ? { cloudId: site, jql: `project in (${ps.join(",")}) AND updated >= -3d ORDER BY updated DESC`, maxResults: 50, fields: ["summary", "status", "updated"] } : null;
  return { mine, moving };
}

export const callLine = (n: number, name: string, input: Record<string, unknown>) => `${n}) ${name.replace("mcp__atlassian__", "")} ${JSON.stringify(input)}`;

export async function loadViaMcp(a: Agent, site: string, projects: string[], jql?: string): Promise<{ mine: JiraIssue[]; moving: JiraIssue[]; cost: number }> {
  const q = searches(site, projects, jql);
  const lines = [callLine(1, SEARCH, q.mine), ...(q.moving ? [callLine(2, SEARCH, q.moving)] : [])];
  const s = await runJob(a, `Make these calls now, in parallel:\n${lines.join("\n")}`, [SEARCH]);
  const mine = issuesOf(site, resultOf(s, SEARCH, q.mine));
  const moving = q.moving ? issuesOf(site, resultOf(s, SEARCH, q.moving)) : [];
  return { mine, moving, cost: s.cost };
}

// ── Filing a ticket through the MCP ──

const bare = (name: string) => name.replace("mcp__atlassian__", "");

/** A project's create screen, in one job: its work types, and the fields of each one. */
export async function loadScreenViaMcp(a: Agent, site: string, project: string): Promise<Screen & { cost: number }> {
  const [p] = safeProjects([project]);
  if (!p) throw new Error(`«${project}» isn't a Jira project key`);
  const typesIn = { cloudId: site, projectIdOrKey: p };
  const prompt = `First call ${bare(TYPES)} ${JSON.stringify(typesIn)}. Then, for every issue type in its answer that isn't a subtask, call ${bare(FIELDS)} with {"cloudId":${JSON.stringify(site)},"projectIdOrKey":${JSON.stringify(p)},"issueTypeId":"<its id>","requiredFieldsOnly":false}, all in parallel.`;
  const s = await runJob(a, prompt, [TYPES, FIELDS]);
  const raw = obj(JSON.parse(resultOf(s, TYPES, typesIn)));
  const types = typesOf((Array.isArray(raw.issueTypes) ? raw.issueTypes : Array.isArray(raw.values) ? raw.values : []).map(obj));
  const fields: Record<string, RawCreateField[]> = {};
  for (const t of types) {
    try {
      const r = obj(JSON.parse(resultOf(s, FIELDS, { cloudId: site, projectIdOrKey: p, issueTypeId: t.id, requiredFieldsOnly: false })));
      fields[t.id] = (Array.isArray(r.fields) ? r.fields : Array.isArray(r.values) ? r.values : []) as RawCreateField[];
    } catch {
      // A type whose fields didn't come: its form says so when it's picked.
    }
  }
  return { types, fields, cost: s.cost };
}

/** What createJiraIssue gets, from the create payload the pack builds (tickets.ts). */
export function createInput(site: string, payload: { fields: Record<string, unknown> }, typeName: string): Record<string, unknown> {
  const { project, issuetype: _type, summary, description, ...rest } = payload.fields;
  const input: Record<string, unknown> = { cloudId: site, projectKey: str(obj(project).key) ?? "", issueTypeName: typeName, summary: str(summary) ?? "" };
  if (description) Object.assign(input, { description, contentFormat: "adf" });
  if (Object.keys(rest).length) input.additional_fields = rest;
  return input;
}

/** Files one ticket: a job that may call createJiraIssue only, with exactly these arguments. The key comes from Jira's answer. */
export async function createViaMcp(a: Agent, site: string, input: Record<string, unknown>): Promise<{ key: string; url: string; cost: number; warning?: string }> {
  const s = await runJob(a, `Make this one call now:\n${callLine(1, CREATE, input)}`, [CREATE]);
  const creates = s.calls.filter((x) => x.name === CREATE);
  const key = str(obj(JSON.parse(resultOf(s, CREATE, input))).key);
  if (!key || !TICKET_KEY.test(key)) throw new Error("Jira's answer has no ticket key: check Jira before trying again");
  return { key, url: `https://${site}/browse/${encodeURIComponent(key)}`, cost: s.cost, warning: creates.length > 1 ? `The agent called createJiraIssue ${creates.length} times: check ${site} for duplicates.` : undefined };
}
