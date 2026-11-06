/**
 * The quick-add line and the dates in it. Pure: it takes the line and today's date (YYYY-MM-DD in
 * the instance's timezone) and gives back what it read. Nothing here touches the database.
 *
 *   fix skribb mail retries tomorrow !high #skribb @maria due fri
 *
 * `#area`, `!high` / `!low` (`!h`, `!l`, `!1`, `!3`), `@someone` (`@me`), a date alone (when to do
 * it), `due <date>` (when it must be done), and `waiting:` at the start (`waiting:maria` names who).
 * Dates: today, tomorrow, a weekday (the next one, today counts), next week (next Monday),
 * `in 3d` / `in 2w` / `in 1m`, an ISO date, `30.10` (the next 30 October). Core's My list (/todo)
 * reads the same words, Norwegian too (`i dag`, `i morgen`, `fre`, a lone `!` for today), so one
 * habit works in both. As there, a date alone counts only at the end of the line (only #area,
 * !priority, @person and dates after it), so "fix man page" keeps its "man"; `due <date>` counts
 * anywhere. Whatever isn't read stays in the title.
 */

export const STATUSES = ["inbox", "next", "doing", "waiting", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const isStatus = (s: unknown): s is Status => typeof s === "string" && (STATUSES as readonly string[]).includes(s);
export const isPriority = (s: unknown): s is Priority => typeof s === "string" && (PRIORITIES as readonly string[]).includes(s);

/** What a quick-add line said. `title` is what's left once the rest is read. */
export type Parsed = {
  title: string;
  status: Status;
  priority: Priority;
  area?: string;
  /** "me", a name or an email. */
  assignee?: string;
  due?: string;
  scheduled?: string;
  waitingOn?: string;
};

export const MAX_LINE = 500;
export const MAX_TITLE = 200;

// ── Dates (YYYY-MM-DD strings, worked out in UTC so no timezone moves them) ──

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date as YYYY-MM-DD, or undefined. */
export function isoDate(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const m = ISO.exec(s.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s.trim()) return undefined;
  const y = +m[1]!;
  return y >= 2000 && y <= 2200 ? s.trim() : undefined;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 Sunday … 6 Saturday. */
export const weekday = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** Days from `a` to `b` (negative when b is earlier). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

/** Today in a timezone (the instance's TZ_NAME), as YYYY-MM-DD; UTC when the name is unknown. */
export function dayOf(at: number, tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

// English, and Norwegian as My list reads it.
const DAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  søn: 0, son: 0, man: 1, tir: 2, ons: 3, tor: 4, fre: 5, lør: 6, lor: 6,
};
const dayNo = (w: string) => (Object.hasOwn(DAYS, w) ? DAYS[w] : undefined);

/**
 * One date phrase from the start of `words`: how many words it took and the date. Undefined when
 * the words don't start with one.
 */
export function readDate(words: string[], today: string): { take: number; day: string } | undefined {
  const raw = (words[0] ?? "").toLowerCase();
  // 30.10 or 30.10. : the next 30 October (today counts), as My list reads it.
  const dm = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(raw);
  if (dm) {
    const year = Number(today.slice(0, 4));
    const at = (y: number) => isoDate(`${y}-${dm[2]!.padStart(2, "0")}-${dm[1]!.padStart(2, "0")}`);
    const day = at(year) && at(year)! >= today ? at(year) : at(year + 1);
    return day ? { take: 1, day } : undefined;
  }
  const w = raw.replace(/[,.;]$/, "");
  if (!w) return undefined;
  const next = (words[1] ?? "").toLowerCase().replace(/[,.;]$/, "");
  if (w === "today" || w === "tod" || w === "idag" || w === "!") return { take: 1, day: today };
  if (w === "tomorrow" || w === "tmr" || w === "tom" || w === "tmrw" || w === "imorgen") return { take: 1, day: addDays(today, 1) };
  if (w === "i" && next === "dag") return { take: 2, day: today };
  if (w === "i" && next === "morgen") return { take: 2, day: addDays(today, 1) };
  const wd = dayNo(w);
  if (wd !== undefined) return { take: 1, day: addDays(today, (wd - weekday(today) + 7) % 7) };
  const iso = isoDate(w);
  if (iso) return { take: 1, day: iso };
  if (w === "next" && next === "week") return { take: 2, day: addDays(today, ((1 - weekday(today) + 7) % 7) || 7) };
  const nd = dayNo(next);
  if (w === "next" && nd !== undefined) return { take: 2, day: addDays(today, (nd - weekday(today) + 7) % 7 || 7) };
  if (w === "in") {
    // in 3d, in 2w, in 1m, in 3 days, in 2 weeks
    const glued = /^(\d{1,3})([dwm])$/.exec(next);
    const n = glued ? +glued[1]! : /^\d{1,3}$/.test(next) ? +next : NaN;
    const unitWord = glued ? glued[2]! : (words[2] ?? "").toLowerCase().replace(/[,.;]$/, "");
    const unit = /^(d|day|days)$/.test(unitWord) ? "d" : /^(w|wk|wks|week|weeks)$/.test(unitWord) ? "w" : /^(m|mo|month|months)$/.test(unitWord) ? "m" : "";
    if (!Number.isFinite(n) || !unit || n > 400) return undefined;
    const take = glued ? 2 : 3;
    if (unit === "d") return { take, day: addDays(today, n) };
    if (unit === "w") return { take, day: addDays(today, n * 7) };
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const end = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    return { take, day: new Date(Date.UTC(y, m - 1 + n, Math.min(d, end))).toISOString().slice(0, 10) };
  }
  return undefined;
}

/** One date phrase on its own ("fri", "in 3d", "2026-12-01"), for a field; undefined when it isn't one. */
export function dateFrom(text: string, today: string): string | undefined {
  const words = clean(text).split(" ").filter(Boolean);
  const r = readDate(words, today);
  return r && r.take === words.length ? r.day : undefined;
}

// ── The line ──

/** Control characters and runs of space out, cut to `max`. */
export function clean(s: unknown, max = MAX_LINE): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

const AREA = /^#([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})$/u;
const PERSON = /^@([\p{L}\p{N}][\p{L}\p{N}._+-]{0,63}(?:@[\p{L}\p{N}][\p{L}\p{N}.-]{0,99})?)$/u;
const PRIO: Record<string, Priority> = { "!high": "high", "!h": "high", "!1": "high", "!!": "high", "!normal": "normal", "!n": "normal", "!2": "normal", "!low": "low", "!l": "low", "!3": "low" };
const WAITING = /^(?:waiting|wait|w):(\S*)$/i;
const prioOf = (w: string) => (Object.hasOwn(PRIO, w) ? PRIO[w] : undefined);

/** Whether only #areas, !priorities, @people and dates are left from `j` on: a date alone counts only there. */
function tailOnly(words: string[], j: number, today: string): boolean {
  while (j < words.length) {
    const w = words[j]!;
    if (AREA.test(w) || prioOf(w.toLowerCase()) || PERSON.test(w.replace(/[,;]$/, ""))) {
      j++;
      continue;
    }
    const due = w.toLowerCase() === "due" ? readDate(words.slice(j + 1), today) : undefined;
    if (due) {
      j += 1 + due.take;
      continue;
    }
    const d = readDate(words.slice(j), today);
    if (!d) return false;
    j += d.take;
  }
  return true;
}

/**
 * Reads a quick-add line. The first of each kind counts; a second stays in the title. A line with
 * nothing but a title goes to the inbox; one that says more (an area, a date, a priority, a person)
 * has been thought about, and goes to next.
 */
export function parseQuick(line: unknown, today: string): Parsed {
  const words = clean(line).split(" ").filter(Boolean);
  const out: Parsed = { title: "", status: "inbox", priority: "normal" };
  const kept: string[] = [];
  let saidPriority = false;
  let waiting = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const lower = w.toLowerCase();
    if (i === 0) {
      const wm = WAITING.exec(w);
      if (wm) {
        waiting = true;
        const who = wm[1]!.replace(/^@/, "").slice(0, 80);
        if (who) out.waitingOn = who;
        continue;
      }
    }
    const area = AREA.exec(w);
    if (area && out.area === undefined) {
      out.area = area[1]!.toLowerCase();
      continue;
    }
    const prio = prioOf(lower);
    if (prio && !saidPriority) {
      out.priority = prio;
      saidPriority = true;
      continue;
    }
    const person = PERSON.exec(w.replace(/[,;]$/, ""));
    if (person && out.assignee === undefined) {
      out.assignee = person[1]!.toLowerCase() === "me" ? "me" : person[1]!;
      continue;
    }
    if (lower === "due" && out.due === undefined) {
      const d = readDate(words.slice(i + 1), today);
      if (d) {
        out.due = d.day;
        i += d.take;
        continue;
      }
    }
    if (out.scheduled === undefined) {
      const d = readDate(words.slice(i), today);
      if (d && tailOnly(words, i + d.take, today)) {
        out.scheduled = d.day;
        i += d.take - 1;
        continue;
      }
    }
    kept.push(w);
  }
  out.title = kept.join(" ").slice(0, MAX_TITLE).trim();
  if (waiting) out.status = "waiting";
  else if (out.area !== undefined || out.assignee !== undefined || out.due || out.scheduled || saidPriority) out.status = "next";
  return out;
}
