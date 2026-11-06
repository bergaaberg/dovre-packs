/**
 * Which list a task is on, and the filters over them. Pure: tasks and today's date in, lists out.
 *
 * Now: doing, due today or before, or set to be done today or before (not while waiting).
 * Waiting, Next and Inbox: by status. Later: set for a day still to come.
 */
import { addDays, daysBetween } from "./parse.ts";
import { isMine, label, shortName, type Task, visibleTo } from "./store.ts";

export type Bucket = "now" | "next" | "waiting" | "inbox" | "later" | "closed";

export const isOpen = (t: Task) => t.status !== "done" && t.status !== "dropped";
export const overdue = (t: Task, today: string) => isOpen(t) && !!t.due && t.due < today;

export function bucketOf(t: Task, today: string): Bucket {
  if (!isOpen(t)) return "closed";
  if (t.status === "doing" || (t.due && t.due <= today)) return "now";
  if (t.status !== "waiting" && t.scheduled && t.scheduled <= today) return "now";
  if (t.status === "waiting") return "waiting";
  if (t.scheduled && t.scheduled > today) return "later";
  return t.status === "next" ? "next" : "inbox";
}

const PRIO = { high: 0, normal: 1, low: 2 } as const;

/** High first, then the soonest due, the soonest to do, the order they were put in. */
export function byUrgency(a: Task, b: Task): number {
  return (
    (a.status === "doing" ? 0 : 1) - (b.status === "doing" ? 0 : 1) ||
    PRIO[a.priority] - PRIO[b.priority] ||
    (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
    (a.scheduled ?? "9999").localeCompare(b.scheduled ?? "9999") ||
    a.position - b.position ||
    a.id - b.id
  );
}

export type Filter = { area?: string; /** "" everyone, "mine", or a person. */ who?: string };

/** Who's named on the tasks a viewer sees (makers and assignees), so the page can offer each. */
export function peopleOf(tasks: Task[], viewer: string): string[] {
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!visibleTo(t, viewer)) continue;
    if (t.createdBy) seen.add(t.createdBy);
    if (t.assignee) seen.add(t.assignee.toLowerCase());
  }
  return [...seen].sort();
}

export const areasOf = (tasks: Task[]) => [...new Set(tasks.filter(isOpen).map((t) => t.area).filter(Boolean))].sort();

/** What a viewer sees under a filter: private tasks only for their maker. */
export function filtered(tasks: Task[], viewer: string, f: Filter): Task[] {
  return tasks.filter((t) => {
    if (!visibleTo(t, viewer)) return false;
    if (f.area && t.area !== f.area) return false;
    if (f.who === "mine") return isMine(t, viewer);
    if (f.who) {
      const w = f.who.toLowerCase();
      return t.assignee.toLowerCase() === w || shortName(t.assignee.toLowerCase()) === w || (!t.assignee && t.createdBy === w);
    }
    return true;
  });
}

export type Lists = Record<Exclude<Bucket, "closed">, Task[]> & { done: Task[] };

export function listsOf(tasks: Task[], today: string, now: number): Lists {
  const out: Lists = { now: [], next: [], waiting: [], inbox: [], later: [], done: [] };
  for (const t of tasks) {
    const b = bucketOf(t, today);
    if (b === "closed") {
      if (t.status === "done" && t.doneAt && now - t.doneAt < 7 * 86400_000) out.done.push(t);
    } else out[b].push(t);
  }
  for (const k of ["now", "next", "waiting", "inbox"] as const) out[k].sort(byUrgency);
  out.later.sort((a, b) => (a.scheduled ?? "").localeCompare(b.scheduled ?? "") || byUrgency(a, b));
  out.done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return out;
}

/** The weekly review: the inbox to triage, waiting a week or more, overdue, done this week. */
export function reviewOf(tasks: Task[], today: string, now: number) {
  const open = tasks.filter(isOpen);
  return {
    inbox: open.filter((t) => t.status === "inbox").sort(byUrgency),
    stale: open.filter((t) => t.status === "waiting" && now - t.statusAt >= 7 * 86400_000).sort((a, b) => a.statusAt - b.statusAt),
    overdue: open.filter((t) => overdue(t, today)).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "")),
    done: tasks.filter((t) => t.status === "done" && t.doneAt && now - t.doneAt < 7 * 86400_000).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
  };
}

/** "today", "tomorrow", "Fri 7 Nov", "3 days ago". */
export function whenOf(day: string, today: string): string {
  const n = daysBetween(today, day);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  if (n < 0 && n > -14) return `${-n} days ago`;
  const d = new Date(`${day}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-GB", { weekday: n > 0 && n < 7 ? "short" : undefined, day: "numeric", month: "short", year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric", timeZone: "UTC" });
  return fmt.format(d);
}

/** Next Monday, for "next week". */
export const nextWeek = (today: string) => {
  const wd = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, ((1 - wd + 7) % 7) || 7);
};

/** One line about a task for Bino and the lookups: id, state, area, dates, title. Never the notes. */
export function lineOf(t: Task, today: string): string {
  const bits: string[] = [t.status];
  if (t.priority !== "normal") bits.push(t.priority);
  if (t.area) bits.push(`#${t.area}`);
  if (t.assignee) bits.push(`@${shortName(t.assignee)}`);
  if (t.due) bits.push(`due ${t.due}${overdue(t, today) ? " (overdue)" : ""}`);
  if (t.scheduled) bits.push(`do on ${t.scheduled}`);
  if (t.status === "waiting" && t.waitingOn) bits.push(`waiting on ${shortName(t.waitingOn)}`);
  return `${label(t.id)} [${bits.join(", ")}]: ${t.title}`;
}
