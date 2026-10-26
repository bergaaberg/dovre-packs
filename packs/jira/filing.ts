/**
 * Jira Pack (`jira`): filing tickets, behind the pages (index.ts) and Bino's card.
 *
 * A project's create screen (its work types and their fields) is read once and kept in memory;
 * a page draws what's kept and reads it again in the background when it's older than half an
 * hour, so a form never waits on Jira when there's something to draw. Through the MCP a read is
 * an agent job (~15 s, a little money).
 *
 * Every create re-checks first: the project's work types are read again, fresh, and the type must
 * still be one it creates. Then one write, logged to the actions table (`ticket.create`) with the
 * type and summary, never the description.
 */
import { logAction } from "dovre/actions/deploys.ts";
import type { PackContext } from "dovre/packs/types.ts";
import { addTodo } from "dovre/todo/store.ts";
import { authOf, createRest, loadScreenRest, siteOf, viaOf } from "./data.ts";
import { type Agent, createInput, createViaMcp, loadScreenViaMcp } from "./mcp.ts";
import { type CreateType, first, readTicket, type Screen, summaryOf, type Ticket, type TicketField, ticketFields, ticketPayload, ticketProjectsOf, ticketValid, validateTicket } from "./tickets.ts";

/** How long a create screen is drawn without reading it again. */
export const SCREEN_MS = 30 * 60_000;

export type Kept = { at: number; screen?: Screen; error?: string };
export type Got = { problem: string; status: 400 | 404 | 502 } | { project: string; type: CreateType; types: CreateType[]; fields: TicketField[]; ticket: Ticket };
export type Filed = { ok: true; key: string; url: string; warning?: string } | { ok: false; problem: string };

const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export function createFiling(o: { agent: () => Promise<Agent>; fetchFn?: typeof fetch; now?: () => number }) {
  const now = o.now ?? Date.now;
  const kept = new Map<string, Kept>();
  const reading = new Map<string, Promise<Screen>>();

  /** Reads a project's create screen from Jira now (a fresh read never shares one already running). */
  async function read(ctx: PackContext, project: string): Promise<Screen> {
    const site = siteOf(ctx.env);
    if (viaOf(ctx.env) === "mcp") {
      const r = await loadScreenViaMcp(await o.agent(), site, project);
      ctx.log(`via mcp: ${project}'s create screen, $${r.cost.toFixed(4)}`);
      return { types: r.types, fields: r.fields };
    }
    return loadScreenRest({ site, auth: authOf(ctx.env), fetchFn: o.fetchFn ?? fetch }, project);
  }

  /** The kept screen, or one read now; a read that lands is kept, and open pages hear of it. */
  function screen(ctx: PackContext, project: string): Promise<Screen> {
    const k = kept.get(project);
    if (k?.screen && now() - k.at < SCREEN_MS) return Promise.resolve(k.screen);
    const running = reading.get(project);
    if (running) return running;
    const p = read(ctx, project)
      .then(
        (s) => {
          kept.set(project, { at: now(), screen: s });
          return s;
        },
        (e) => {
          // A failed read keeps the last good screen: the page still draws it.
          kept.set(project, { ...kept.get(project), at: kept.get(project)?.screen ? kept.get(project)!.at : now(), error: msg(e) });
          throw e;
        },
      )
      .finally(() => {
        reading.delete(project);
        ctx.publish(["jira"]);
      });
    reading.set(project, p);
    return p;
  }

  /** Starts a read in the background when there's none kept, or what's kept is old. */
  const kick = (ctx: PackContext, project: string) => void screen(ctx, project).catch(() => {});

  /** The ticket a form (or Bino's card) describes, checked against the kept screen and TICKET_PROJECTS. */
  async function fromForm(ctx: PackContext, form: Record<string, unknown>): Promise<Got> {
    const project = first(form.project).trim().toUpperCase();
    const projects = ticketProjectsOf(ctx.env);
    if (!projects.includes(project)) return { problem: `Tickets go to ${projects.join(", ") || "no project (set TICKET_PROJECTS)"}.`, status: 400 };
    let s: Screen;
    try {
      s = await screen(ctx, project);
    } catch (e) {
      return { problem: `Jira's work types for ${project} didn't load: ${msg(e)}`, status: 502 };
    }
    // By id from the form; by name from Bino's card, else the project's first.
    const id = first(form.type);
    const named = first(form.type_name).trim().toLowerCase();
    const type = id ? s.types.find((t) => t.id === id) : (s.types.find((t) => t.name.toLowerCase() === named) ?? s.types[0]);
    if (!type) return { problem: `${project} offers no such work type (any more).`, status: 400 };
    const raw = s.fields[type.id];
    if (!raw) return { problem: `The ${type.name} fields didn't come back from Jira.`, status: 502 };
    const f = ticketFields(raw);
    if (f.blocked.length) return { problem: `Jira requires ${f.blocked.join(", ")} for a ${type.name}, which this form can't fill.`, status: 400 };
    return { project, type, types: s.types, fields: f.fields, ticket: readTicket(project, type, f.fields, form) };
  }

  /** Files one ticket: re-check, one write, logged; on My list too when asked. */
  async function file(ctx: PackContext, got: Extract<Got, { ticket: Ticket }>, opts: { myList?: boolean } = {}): Promise<Filed> {
    const errors = validateTicket(got.ticket, got.fields);
    if (!ticketValid(errors)) return { ok: false, problem: `${Object.keys(errors).filter((k) => errors[k]).map((k) => got.fields.find((f) => f.id === k)?.name ?? k).join(", ")} needs filling in: nothing was created.` };
    const summary = summaryOf(got.ticket, got.fields);
    // Re-check against Jira itself, not what's kept: the type must still be one the project creates.
    let fresh: Screen;
    try {
      fresh = await read(ctx, got.project);
      kept.set(got.project, { at: now(), screen: fresh });
    } catch (e) {
      return { ok: false, problem: `Couldn't check ${got.project} in Jira (${msg(e)}): nothing was created.` };
    }
    if (!fresh.types.some((t) => t.id === got.type.id)) return { ok: false, problem: `${got.project} no longer creates a ${got.type.name}: nothing was created.` };
    const site = siteOf(ctx.env);
    const detail = `${got.type.name} · ${summary}`.slice(0, 300);
    try {
      const payload = ticketPayload(got.ticket, got.fields);
      const r = viaOf(ctx.env) === "mcp" ? await createViaMcp(await o.agent(), site, createInput(site, payload, got.type.name)) : await createRest({ site, auth: authOf(ctx.env), fetchFn: o.fetchFn ?? fetch }, payload);
      await logAction(ctx.db, { kind: "ticket.create", target: r.key, detail, ok: true });
      if ("cost" in r) ctx.log(`via mcp: created ${r.key}, $${(r.cost as number).toFixed(4)}`);
      if (opts.myList && summary)
        // It's made already, so a miss here is only logged.
        await addTodo(ctx.db, { title: summary, notes: `${r.key} in Jira: ${r.url}` }).catch((e) => ctx.log(`my list: ${msg(e)}`));
      return { ok: true, key: r.key, url: r.url, warning: "warning" in r ? (r.warning as string | undefined) : undefined };
    } catch (e) {
      await logAction(ctx.db, { kind: "ticket.create", target: got.project, detail, ok: false, error: msg(e) });
      return { ok: false, problem: `Couldn't create the ticket in ${got.project}: ${msg(e)}` };
    }
  }

  return {
    kept: (project: string) => kept.get(project),
    reading: (project: string) => reading.has(project),
    screen,
    kick,
    fromForm,
    file,
    /** Forget a failed read, so the next page asks again. */
    retry: (project: string) => {
      const k = kept.get(project);
      if (k && !k.screen) kept.delete(project);
    },
  };
}

export type Filing = ReturnType<typeof createFiling>;
