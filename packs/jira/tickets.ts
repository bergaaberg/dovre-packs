/**
 * A Jira ticket being written: the fields a project's create screen asks for (read live from
 * createmeta, never hardcoded), what the form posted, and the create payload. Pure; the pages
 * render it, data.ts (REST) or mcp.ts (the Atlassian MCP) sends it.
 *
 * Which fields show is a rule, not a list: the summary, the description, the priority, and any
 * single-select a team added (Område, Estimat). Free-text custom fields are left out, because
 * those are where syncs keep their state; so are dates, users, links and attachments. A required
 * field the form can't fill, with no default, blocks the form and says so: Jira would refuse the
 * ticket anyway.
 */

/** A work type a project can create (sub-tasks left out: they need a parent ticket). */
export type CreateType = { id: string; name: string; description: string };
/** One field on a work type's create screen, as Jira's createmeta describes it. */
export type RawCreateField = {
  fieldId: string;
  key?: string;
  name: string;
  required: boolean;
  schema: { type: string; items?: string; system?: string; custom?: string };
  allowedValues?: { id: string; value?: string; name?: string }[];
  defaultValue?: { id?: string; value?: string; name?: string };
  hasDefaultValue?: boolean;
};
/** A project's whole create screen: its work types, and each one's fields (missing: they didn't load). */
export type Screen = { types: CreateType[]; fields: Record<string, RawCreateField[]> };

export type TicketField = {
  id: string;
  name: string;
  kind: "line" | "paragraph" | "select";
  required: boolean;
  options: { id: string; label: string }[];
  /** A select's starting option id (Jira's default). */
  default?: string;
};

export type TicketForm = { fields: TicketField[]; blocked: string[] };

/** What we set ourselves (the reporter fills itself in: whoever Jira is asked as). */
const OURS = new Set(["project", "issuetype"]);
export const MAX_SUMMARY = 255;
export const MAX_DESCRIPTION = 30000;
export const TICKET_KEY = /^[A-Z][A-Z0-9_]{0,20}-\d{1,9}$/;

const optionLabel = (o: { value?: string; name?: string; id: string }) => String(o.value ?? o.name ?? o.id).trim();

function fieldOf(f: RawCreateField): TicketField | null {
  const id = f.fieldId ?? f.key ?? "";
  if (!/^\w{1,64}$/.test(id)) return null;
  const name = String(f.name ?? id).slice(0, 80);
  const sys = f.schema?.system;
  if (sys === "summary") return { id, name, kind: "line", required: true, options: [] };
  if (sys === "description") return { id, name, kind: "paragraph", required: !!f.required, options: [] };
  const select = sys === "priority" || (f.schema?.type === "option" && !!f.schema.custom);
  if (!select || !f.allowedValues?.length) return null;
  const options = f.allowedValues.map((o) => ({ id: String(o.id), label: optionLabel(o).slice(0, 120) }));
  const d = f.defaultValue?.id && options.some((o) => o.id === String(f.defaultValue!.id)) ? String(f.defaultValue.id) : undefined;
  return { id, name, kind: "select", required: !!f.required, options, default: d };
}

/** The fields to show, in a steady order (summary, description, priority, then the project's own), and what blocks the form. */
export function ticketFields(raw: RawCreateField[]): TicketForm {
  const fields: TicketField[] = [];
  const blocked: string[] = [];
  for (const f of raw) {
    const id = f.fieldId ?? f.key ?? "";
    if (OURS.has(id)) continue;
    const field = fieldOf(f);
    if (field) fields.push(field);
    else if (f.required && !f.hasDefaultValue) blocked.push(String(f.name ?? id).slice(0, 80));
  }
  const rank = (f: TicketField) => (f.kind === "line" ? 0 : f.kind === "paragraph" ? 1 : f.id === "priority" ? 2 : 3);
  return { fields: fields.map((f, i) => [f, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([f]) => f), blocked };
}

export type Ticket = { project: string; type: CreateType; values: Record<string, string> };
export type TicketErrors = Record<string, string | undefined>;

type Form = Record<string, unknown>;
export const first = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? (v.find((x) => typeof x === "string") ?? "") : "");
/** Form names: `j_` and the field id (Jira ids are letters, digits and underscores). */
export const nameOf = (f: TicketField) => `j_${f.id}`;

export function emptyTicket(project: string, type: CreateType, fields: TicketField[]): Ticket {
  return { project, type, values: Object.fromEntries(fields.map((f) => [f.id, f.default ?? ""])) };
}

/** A ticket from a posted form. An option the field doesn't offer is dropped, not trusted. */
export function readTicket(project: string, type: CreateType, fields: TicketField[], form: Form): Ticket {
  const values: Record<string, string> = {};
  for (const f of fields) {
    // A field the form didn't post at all (Bino's card) takes Jira's default.
    const v = form[nameOf(f)] === undefined ? (f.default ?? "") : first(form[nameOf(f)]);
    values[f.id] = f.kind === "select" ? (f.options.some((o) => o.id === v) ? v : "") : f.kind === "line" ? v.replace(/[\r\n]+/g, " ") : v.replace(/\r\n?/g, "\n");
  }
  return { project, type, values };
}

export function validateTicket(t: Ticket, fields: TicketField[]): TicketErrors {
  const e: TicketErrors = {};
  for (const f of fields) {
    const v = (t.values[f.id] ?? "").trim();
    if (f.required && !v) e[f.id] = f.kind === "select" ? "Pick one." : "Required.";
    else if (f.kind === "line" && v.length > MAX_SUMMARY) e[f.id] = `At most ${MAX_SUMMARY} characters (${v.length} now).`;
    else if (f.kind === "paragraph" && v.length > MAX_DESCRIPTION) e[f.id] = `At most ${MAX_DESCRIPTION} characters.`;
  }
  return e;
}

export const ticketValid = (e: TicketErrors) => Object.values(e).every((x) => !x);

/** The ticket as form fields again: what the preview carries to create. */
export function ticketPairs(t: Ticket, fields: TicketField[]): [string, string][] {
  return [["project", t.project], ["type", t.type.id], ...fields.map((f): [string, string] => [nameOf(f), t.values[f.id] ?? ""])];
}

/** The ticket's summary, trimmed: what the actions log and My list call it. */
export const summaryOf = (t: Ticket, fields: TicketField[]) => (t.values[fields.find((f) => f.kind === "line")?.id ?? "summary"] ?? "").trim();

/** Plain text as Atlassian Document Format: a paragraph per blank-line block, line breaks kept. */
export function adf(text: string): { type: "doc"; version: 1; content: unknown[] } {
  const blocks = text.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: blocks.map((b) => ({
      type: "paragraph",
      content: b.split("\n").flatMap((line, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
    })),
  };
}

/** What POST /rest/api/3/issue gets: empty optional fields left out, so Jira's defaults apply. */
export function ticketPayload(t: Ticket, fields: TicketField[]): { fields: Record<string, unknown> } {
  const out: Record<string, unknown> = { project: { key: t.project }, issuetype: { id: t.type.id } };
  for (const f of fields) {
    const v = (t.values[f.id] ?? "").trim();
    if (!v) continue;
    out[f.id] = f.kind === "select" ? { id: v } : f.kind === "paragraph" ? adf(v) : v;
  }
  return { fields: out };
}

/** The option a select holds, by its label, for the preview. */
export const shown = (f: TicketField, t: Ticket) => (f.kind === "select" ? (f.options.find((o) => o.id === t.values[f.id])?.label ?? "") : (t.values[f.id] ?? ""));

/** Where tickets may be filed (TICKET_PROJECTS): project keys only. */
export const ticketProjectsOf = (env: Record<string, string | undefined>) =>
  [...new Set((env.TICKET_PROJECTS ?? "").split(",").map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,19}$/.test(k)))];

/** The work type a card names, by name (any case), else the project's first. */
/** What an agent gets to file a ticket from a rough note; it's shown before the agent starts. */
export const draftPrompt = (site: string, project: string, note: string) =>
  `Create a Jira ticket in project ${project} on ${site} with the Atlassian MCP, from my note below. Pick the work type the project offers (a story, a bug, an improvement) and fill the fields it asks for. Ask me what's missing, show me the draft, and wait for my go before you create anything.

Note: ${note.trim()}`;
