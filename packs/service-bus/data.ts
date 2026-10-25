/**
 * Azure Service Bus Pack (`service-bus`): reads message counts per queue and topic subscription
 * (active, dead-lettered, scheduled, transfer dead-lettered). Counts and entity names only: it
 * never peeks, receives or stores a message.
 *
 * Two kinds of endpoint, told apart by SERVICEBUS_ENDPOINT:
 * - Azure Resource Manager: `https://management.azure.com/subscriptions/…/providers/Microsoft.ServiceBus/namespaces/<ns>`,
 *   JSON, with an Entra ID bearer token.
 * - The namespace itself: `https://<ns>.servicebus.windows.net`, its Atom management feed, with a
 *   SAS token (`SharedAccessSignature sr=…`) or an Entra ID bearer token.
 */

export type EntityKind = "queue" | "subscription";

/** One queue or subscription's counts. A subscription's name is `topic/subscription`. */
export type Entity = {
  name: string;
  kind: EntityKind;
  active: number;
  deadLetter: number;
  scheduled: number;
  transferDeadLetter: number;
};

export type Target = {
  mode: "arm" | "data";
  /** The namespace's base URL, without a trailing slash or query. */
  base: string;
  /** The namespace's name, for headings. */
  namespace: string;
  /** The namespace in the Azure portal (ARM only). */
  portal?: string;
};

/** A queue (`queue`) or a subscription (`topic` + `sub`) named in SERVICEBUS_ENTITIES. */
export type Wanted = { name: string; queue: string } | { name: string; topic: string; sub: string };

export type ServiceBusRead = { ok: true; entities: Entity[]; errors: string[] } | { ok: false; error: string };

const ARM_API = "2021-11-01";
const DATA_API = "2021-05";
/** The most entities one refresh reads (and the page size of each list). */
export const MAX_ENTITIES = 100;
/** The most topics whose subscriptions one refresh lists. */
const MAX_TOPICS = 25;
/** The whole refresh's time box. */
const TIMEOUT_MS = 10_000;

const ARM_PATH = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ServiceBus\/namespaces\/([^/]+)$/i;

/** Which kind of endpoint SERVICEBUS_ENDPOINT is; undefined when it's neither (or not https). */
export function parseEndpoint(raw: string | undefined): Target | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password) return undefined;
  const path = u.pathname.replace(/\/+$/, "");
  const arm = ARM_PATH.exec(path);
  if (arm) {
    return {
      mode: "arm",
      base: `${u.origin}${path}`,
      namespace: decodeURIComponent(arm[1]!),
      portal: u.hostname === "management.azure.com" ? `https://portal.azure.com/#resource${path}/overview` : undefined,
    };
  }
  if (path) return undefined;
  return { mode: "data", base: u.origin, namespace: u.hostname.split(".")[0]! };
}

/** SERVICEBUS_ENTITIES: comma-separated `queue` or `topic/subscription`. */
export function parseEntities(raw: string | undefined): Wanted[] {
  const out: Wanted[] = [];
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().replace(/^\/+|\/+$/g, "");
    if (!name || out.some((w) => w.name === name)) continue;
    const slash = name.indexOf("/");
    if (slash < 0) out.push({ name, queue: name });
    else out.push({ name, topic: name.slice(0, slash), sub: name.slice(slash + 1) });
    if (out.length >= MAX_ENTITIES) break;
  }
  return out;
}

/** The Authorization header for a token: a SAS or "Bearer …" as it is, anything else as a bearer token. */
export function authHeader(token: string): string {
  const t = token.trim();
  return /^(SharedAccessSignature|Bearer)\s/i.test(t) ? t : `Bearer ${t}`;
}

const count = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const cutName = (s: string) => s.slice(0, 260);

type ArmEntity = {
  name?: unknown;
  properties?: {
    countDetails?: Record<string, unknown>;
    messageCountDetails?: Record<string, unknown>;
  };
};

/** An ARM response (a list's `value`, or one entity) as entities; `topic` names a subscription's topic. */
export function parseArm(json: unknown, kind: EntityKind, topic?: string): Entity[] {
  const j = json as { value?: unknown } | null;
  const rows = (Array.isArray(j?.value) ? j.value : j && typeof j === "object" && "name" in j ? [j] : []) as ArmEntity[];
  const out: Entity[] = [];
  for (const r of rows) {
    if (typeof r?.name !== "string" || !r.name) continue;
    const c = r.properties?.countDetails ?? r.properties?.messageCountDetails ?? {};
    out.push({
      name: cutName(topic ? `${topic}/${r.name}` : r.name),
      kind,
      active: count(c.activeMessageCount),
      deadLetter: count(c.deadLetterMessageCount),
      scheduled: count(c.scheduledMessageCount),
      transferDeadLetter: count(c.transferDeadLetterMessageCount),
    });
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]!);
const xmlNumber = (chunk: string, tag: string) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}>\\s*(\\d+)\\s*<`).exec(chunk);
  return count(m?.[1]);
};

/** The namespace's Atom feed (a list, or one `<entry>`) as entities; `topic` names a subscription's topic. */
export function parseAtom(xml: string, kind: EntityKind, topic?: string): Entity[] {
  const out: Entity[] = [];
  for (const chunk of xml.split(/<entry[\s>]/).slice(1)) {
    const name = unxml(/<title[^>]*>([^<]*)<\/title>/.exec(chunk)?.[1] ?? "").trim();
    if (!name) continue;
    out.push({
      name: cutName(topic ? `${topic}/${name}` : name),
      kind,
      active: xmlNumber(chunk, "ActiveMessageCount"),
      deadLetter: xmlNumber(chunk, "DeadLetterMessageCount"),
      scheduled: xmlNumber(chunk, "ScheduledMessageCount"),
      transferDeadLetter: xmlNumber(chunk, "TransferDeadLetterMessageCount"),
    });
  }
  return out;
}

/** The names of the topics in a list response (only their names are needed). */
function topicNames(t: Target, body: string): string[] {
  if (t.mode === "arm") {
    const v = (JSON.parse(body) as { value?: { name?: unknown }[] }).value;
    return Array.isArray(v) ? v.map((x) => x?.name).filter((n): n is string => typeof n === "string" && !!n) : [];
  }
  return parseAtom(body, "queue").map((e) => e.name);
}

const seg = (s: string) => encodeURIComponent(s);

function url(t: Target, path: string, list: boolean): string {
  const api = t.mode === "arm" ? ARM_API : DATA_API;
  return `${t.base}/${path}?api-version=${api}${list ? `&$top=${MAX_ENTITIES}` : ""}`;
}

const paths = {
  queues: (t: Target) => (t.mode === "arm" ? "queues" : "$Resources/Queues"),
  topics: (t: Target) => (t.mode === "arm" ? "topics" : "$Resources/Topics"),
  subs: (t: Target, topic: string) => (t.mode === "arm" ? `topics/${seg(topic)}/subscriptions` : `${seg(topic)}/Subscriptions`),
  queue: (t: Target, q: string) => (t.mode === "arm" ? `queues/${seg(q)}` : seg(q)),
  sub: (t: Target, topic: string, s: string) => (t.mode === "arm" ? `topics/${seg(topic)}/subscriptions/${seg(s)}` : `${seg(topic)}/Subscriptions/${seg(s)}`),
};

/**
 * Reads the counts: the entities SERVICEBUS_ENTITIES names, or else every queue and every
 * subscription of the first topics. One failing entity is an error beside the others' counts;
 * nothing read at all is `ok: false`. Never throws.
 */
export async function readServiceBus(env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<ServiceBusRead> {
  const target = parseEndpoint(env.SERVICEBUS_ENDPOINT);
  const token = (env.SERVICEBUS_TOKEN ?? "").trim();
  if (!target) {
    return { ok: false, error: "Set SERVICEBUS_ENDPOINT to an https Service Bus namespace (https://<ns>.servicebus.windows.net) or its Azure Resource Manager URL." };
  }
  if (!token) return { ok: false, error: "Set SERVICEBUS_TOKEN to a SAS or Entra ID bearer token." };

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const headers = {
    authorization: authHeader(token),
    accept: target.mode === "arm" ? "application/json" : "application/atom+xml",
  };
  const get = async (path: string, list: boolean): Promise<string> => {
    const res = await fetchFn(url(target, path, list), { headers, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  const parse = (body: string, kind: EntityKind, topic?: string) =>
    target.mode === "arm" ? parseArm(JSON.parse(body), kind, topic) : parseAtom(body, kind, topic);
  const why = (what: string, e: unknown) => `${what}: ${String((e as Error)?.message ?? e).slice(0, 120)}`;

  const entities: Entity[] = [];
  const errors: string[] = [];
  const wanted = parseEntities(env.SERVICEBUS_ENTITIES);

  if (wanted.length) {
    await Promise.all(
      wanted.map(async (w) => {
        try {
          const kind: EntityKind = "queue" in w ? "queue" : "subscription";
          const body = await get("queue" in w ? paths.queue(target, w.queue) : paths.sub(target, w.topic, w.sub), false);
          const got = parse(body, kind, "queue" in w ? undefined : w.topic);
          if (!got.length) errors.push(`${w.name}: not found`);
          else entities.push({ ...got[0]!, name: cutName(w.name) });
        } catch (e) {
          errors.push(why(w.name, e));
        }
      }),
    );
  } else {
    const [queues, topics] = await Promise.allSettled([get(paths.queues(target), true), get(paths.topics(target), true)]);
    if (queues.status === "fulfilled") {
      try {
        entities.push(...parse(queues.value, "queue"));
      } catch (e) {
        errors.push(why("queues", e));
      }
    } else errors.push(why("queues", queues.reason));
    if (topics.status === "fulfilled") {
      let names: string[] = [];
      try {
        names = topicNames(target, topics.value).slice(0, MAX_TOPICS);
      } catch (e) {
        errors.push(why("topics", e));
      }
      await Promise.all(
        names.map(async (topic) => {
          try {
            entities.push(...parse(await get(paths.subs(target, topic), true), "subscription", topic));
          } catch (e) {
            errors.push(why(`${topic} subscriptions`, e));
          }
        }),
      );
    } else errors.push(why("topics", topics.reason));
  }

  if (!entities.length && errors.length) return { ok: false, error: errors[0]! };
  entities.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, entities: entities.slice(0, MAX_ENTITIES), errors };
}
