/**
 * DuckDB Agent: SQL guard (sqlOk), AI query builder, manual/agentic execution,
 * result reviewer, and multi-source routing.
 */
import { randomUUID } from "node:crypto";
import { MAX_SQL, type DuckDbData, type Rows } from "./data.ts";
import { type DuckDbSchemas, type Schema, schemaPart } from "./schema.ts";

export const MAX_QUESTION = 2000;
export const MAX_EXPLORATORY = 3;
export const MAX_PICKS = 4;
export const REVIEW_ROWS = 100;
export const REVIEW_CHARS = 30_000;
const KEEP = 30;

export type Asker = {
  why(): string | undefined;
  ask(prompt: string): Promise<string>;
  model: string;
};

export type Proposal = {
  sql: string;
  says: string;
};

export type Exploration = {
  query: string;
  why?: string;
  rowCount: number;
};

export type Review = {
  state: "thinking" | "ready" | "failed";
  text?: string;
  proposal?: Proposal;
  error?: string;
};

export type Job = {
  id: string;
  t: string;
  question: string;
  mode: "manual" | "agentic";
  at: number;
  state: "thinking" | "ready" | "asks" | "failed";
  proposal?: Proposal;
  back?: string;
  error?: string;
  explorations?: Exploration[];
  review?: Review;
  parent?: string;
};

export type AcrossPick = {
  t: string;
  why: string;
  job: string;
};

export type Across = {
  id: string;
  question: string;
  mode: "manual" | "agentic";
  at: number;
  state: "picking" | "ready" | "asks" | "failed";
  picks: AcrossPick[];
  back?: string;
  error?: string;
  unread?: string[];
};

const FORBIDDEN =
  /\b(copy|attach|install|load|export|pragma|call|insert|update|delete|merge|drop|alter|create|truncate|replace|grant|revoke|into|checkpoint|vacuum|duckdb_secrets|which_secret)\b/i;

/**
 * Validates that an SQL query is strictly read-only for DuckDB.
 * Allows single SELECT or WITH … SELECT queries only.
 * Rejects semicolons (multi-statement), COPY, ATTACH, INSTALL, LOAD, EXPORT, PRAGMA,
 * CALL, and all DDL/DML writes.
 */
export function sqlOk(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const sql = v.replace(/\r\n?/g, "\n").trim().replace(/;\s*$/, "");
  if (!sql || sql.length > MAX_SQL) return undefined;

  // Mask string literals to prevent keywords or semicolons inside literals from tripping checks
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''");

  // Must begin with SELECT or WITH
  if (!/^(select|with)\b/i.test(bare)) return undefined;

  // Reject semicolons (multi-statement queries)
  if (bare.includes(";")) return undefined;

  // Reject forbidden execution, management, or write keywords
  if (FORBIDDEN.test(bare)) return undefined;

  return sql;
}

/** Parses the innermost JSON object in a text response. */
export function jsonIn(text: string): Record<string, unknown> | undefined {
  const t = text.slice(-40_000);
  const opens = [...t.matchAll(/\{/g)].map((m) => m.index!).reverse();
  const closes = [...t.matchAll(/\}/g)].map((m) => m.index!).reverse();

  for (const a of opens.slice(0, 50)) {
    for (const b of closes) {
      if (b < a) break;
      try {
        const j = JSON.parse(t.slice(a, b + 1));
        if (j && typeof j === "object" && !Array.isArray(j)) {
          return j as Record<string, unknown>;
        }
      } catch {}
    }
  }
  return undefined;
}

/** Parses the outermost JSON object in a text response (e.g. for across picks containing arrays). */
export function outerJsonIn(text: string): Record<string, unknown> | undefined {
  const t = text.slice(-40_000);
  const opens = [...t.matchAll(/\{/g)].map((m) => m.index!).slice(0, 50);
  const closes = [...t.matchAll(/\}/g)].map((m) => m.index!).reverse().slice(0, 50);

  for (const a of opens) {
    for (const b of closes) {
      if (b < a) break;
      try {
        const j = JSON.parse(t.slice(a, b + 1));
        if (j && typeof j === "object" && !Array.isArray(j)) {
          return j as Record<string, unknown>;
        }
      } catch {}
    }
  }
  return undefined;
}

const line = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

export type ParsedProposal = {
  proposal?: Proposal;
  back?: string;
  explore?: { query: string; why: string };
};

/** Extracts proposal, clarifying question, or exploratory query from model text. */
export function proposalOf(text: string): ParsedProposal | null {
  const j = jsonIn(text);
  if (!j) return null;

  if (typeof j.explore === "string") {
    const q = sqlOk(j.explore);
    if (q) return { explore: { query: q, why: line(j.why, 300) } };
  }

  const sql = sqlOk(j.sql);
  if (sql) {
    return { proposal: { sql, says: line(j.says, 300) } };
  }

  const back = line(j.ask, 500);
  return back ? { back } : null;
}

export function queryPrompt(question: string, targetId: string, s: Schema): string {
  return `You write SQL queries for a person querying DuckDB database (${targetId}; DuckDB SQL), read-only.

Their question:
<question>
${question}
</question>

The database's tables and columns (names only, no row data):
<schema>
${schemaPart(question, s)}
</schema>

Write ONE read-only query (SELECT, or WITH … SELECT) that answers the question. Use only tables and columns from the schema. DuckDB SQL syntax.

Answer with JSON only, one of:
{"sql": "the query", "says": "one short line, in the person's language, on what it returns"}
{"ask": "one short question back, when the question can't be answered without knowing more (which table, which period)"}`;
}

export function agenticPrompt(question: string, targetId: string, s: Schema): string {
  return `You are an expert DuckDB agent querying database (${targetId}; DuckDB SQL).
You can run up to ${MAX_EXPLORATORY} bounded read-only exploratory queries (e.g. inspecting distinct column values, counts, or min/max timestamps) before returning your final query and summary.

Their question:
<question>
${question}
</question>

The database's tables and columns:
<schema>
${schemaPart(question, s)}
</schema>

Answer with JSON only, one of:
{"explore": "a read-only SELECT query to inspect distinct values, counts, or timestamps", "why": "one short line on what you are checking"}
{"sql": "the final query", "says": "one short line, in the person's language, on what it returns"}
{"ask": "one short question back, when you cannot answer without knowing more"}`;
}

export function reviewPrompt(question: string, sql: string, rows: Rows): string {
  const cols = rows.columns.slice(0, 60);
  const lines = [
    cols.join("\t"),
    ...rows.rows
      .slice(0, REVIEW_ROWS)
      .map((r) =>
        cols
          .map((c) => String(r[c] ?? "NULL").replace(/\s+/g, " ").slice(0, 200))
          .join("\t")
      ),
  ];
  let table = lines.join("\n");
  if (table.length > REVIEW_CHARS) table = `${table.slice(0, REVIEW_CHARS)}\n…`;

  return `A person asked a question about a DuckDB database and ran this query for it.
Say briefly, in their language, what the result tells them, and whether it looks right for the question: check for empty results, unexpected nulls, row fan-out, or filter anomalies.
Plain text, a few sentences. If a better query would answer it, end with JSON on its own line: {"sql": "the query", "says": "one short line on what it returns"}.

Their question:
<question>
${question}
</question>

The query:
<sql>
${sql}
</sql>

The result: ${rows.rows.length}${rows.capped ? "+" : ""} rows${rows.rows.length > REVIEW_ROWS ? `, the first ${REVIEW_ROWS} shown` : ""}, tab-separated:
<rows>
${table}
</rows>`;
}

export function pickPrompt(question: string, sources: { id: string; tables: string[] }[]): string {
  const list = sources
    .map((s) => `${s.id}: ${s.tables.slice(0, 80).join(", ") || "(no tables)"}`)
    .join("\n");

  return `A person asks a question across multiple DuckDB databases.
Below are each source's table names:

<sources>
${list}
</sources>

Their question:
<question>
${question}
</question>

Pick the sources that can best answer it, best first, at most ${MAX_PICKS}.
Answer with JSON only, one of:
{"picks": [{"source": "the source id as listed", "why": "one short line, in the person's language, on why this source"}]}
{"ask": "one short question back, when you can't tell which sources without knowing more"}`;
}

export function picksOf(
  text: string,
  validSources: string[]
): { picks?: { t: string; why: string }[]; back?: string } | null {
  const j = outerJsonIn(text);
  if (!j) return null;

  const seen = new Set<string>();
  const picks = (Array.isArray(j.picks) ? j.picks : []).flatMap((p) => {
    const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    const src = typeof o.source === "string" ? o.source.trim().toLowerCase() : "";
    if (!validSources.includes(src) || seen.has(src)) return [];
    seen.add(src);
    return [{ t: src, why: line(o.why, 300) }];
  });

  if (picks.length) return { picks: picks.slice(0, MAX_PICKS) };
  const back = line(j.ask, 500);
  return back ? { back } : null;
}

export type DuckDbAgent = {
  why(): string | undefined;
  model: string;
  start(t: string, question: string, mode?: "manual" | "agentic", parent?: string): Job;
  get(id: string): Job | undefined;
  across(question: string, mode?: "manual" | "agentic"): Across;
  getAcross(id: string): Across | undefined;
  review(id: string, sql: string, rows: Rows): void;
};

export function createDuckDbAgent(o: {
  asker?: Asker;
  schemas: DuckDbSchemas;
  data: DuckDbData;
  defaultMode?: "manual" | "agentic";
  onChange?: (id: string) => void;
  now?: () => number;
}): DuckDbAgent {
  const now = o.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const acrosses = new Map<string, Across>();

  const changed = (j: Job) => {
    o.onChange?.(j.id);
    if (j.parent) o.onChange?.(j.parent);
  };

  const why = () => (!o.asker ? "The query agent is off (no asker configured)." : o.asker.why());

  const trim = () => {
    const keepAcross = new Set(
      [...acrosses.values()].sort((a, b) => b.at - a.at).slice(0, KEEP).map((a) => a.id)
    );
    for (const a of acrosses.values()) if (!keepAcross.has(a.id)) acrosses.delete(a.id);

    const own = [...jobs.values()].filter((j) => !j.parent || !acrosses.has(j.parent));
    for (const j of own.sort((a, b) => b.at - a.at).slice(KEEP)) jobs.delete(j.id);
  };

  const clean = (q: string) => q.replace(/\r\n?/g, "\n").trim().slice(0, MAX_QUESTION);

  const api: DuckDbAgent = {
    why,
    model: o.asker?.model ?? "",
    get: (id) => jobs.get(id),
    getAcross: (id) => acrosses.get(id),

    across(question, mode) {
      const q = clean(question);
      const chosenMode = mode ?? o.defaultMode ?? "manual";
      const a: Across = {
        id: randomUUID(),
        question: q,
        mode: chosenMode,
        at: now(),
        state: "picking",
        picks: [],
      };
      acrosses.set(a.id, a);
      trim();

      const sources = o.data.sources();
      const no = why() ?? (!q ? "Ask something first." : !sources.length ? "No sources configured." : undefined);
      if (no) {
        Object.assign(a, { state: "failed", error: no });
        return a;
      }

      const done = () => o.onChange?.(a.id);
      void (async () => {
        try {
          const sourceTables: { id: string; tables: string[] }[] = [];
          for (const s of sources) {
            try {
              const sc = await o.schemas.get(s.id);
              sourceTables.push({ id: s.id, tables: sc.tables.map((x) => x.name) });
            } catch {
              sourceTables.push({ id: s.id, tables: [] });
            }
          }

          const answerText = await o.asker!.ask(pickPrompt(q, sourceTables));
          const got = picksOf(answerText, sources.map((s) => s.id));

          if (!got) {
            Object.assign(a, {
              state: "failed",
              error: "The agent didn't pick any source. Ask again, or name what you're looking for.",
            });
          } else if (got.back) {
            Object.assign(a, { state: "asks", back: got.back });
          } else {
            a.picks = got.picks!.map((p) => ({
              ...p,
              job: api.start(p.t, q, chosenMode, a.id).id,
            }));
            a.state = "ready";
          }
        } catch (e) {
          Object.assign(a, {
            state: "failed",
            error: String((e as Error)?.message ?? e).slice(0, 300),
          });
        }
        done();
      })();

      return a;
    },

    start(t, question, mode, parent) {
      const q = clean(question);
      const chosenMode = mode ?? o.defaultMode ?? "manual";
      const j: Job = {
        id: randomUUID(),
        t,
        question: q,
        mode: chosenMode,
        at: now(),
        state: "thinking",
        explorations: [],
        ...(parent ? { parent } : {}),
      };
      jobs.set(j.id, j);
      trim();

      const no =
        why() ??
        (!q ? "Ask something first." : !o.data.source(t) ? `Unknown source: ${t}` : undefined);
      if (no) {
        Object.assign(j, { state: "failed", error: no });
        return j;
      }

      void (async () => {
        try {
          const schema = await o.schemas.get(t);

          if (chosenMode === "agentic") {
            // Agentic mode: allow up to MAX_EXPLORATORY bounded read-only queries
            let prompt = agenticPrompt(q, t, schema);
            let turns = 0;

            while (turns < MAX_EXPLORATORY) {
              const reply = await o.asker!.ask(prompt);
              const got = proposalOf(reply);

              if (!got) {
                Object.assign(j, {
                  state: "failed",
                  error: "The agent did not return a valid proposal. Ask again, or be more specific.",
                });
                break;
              }

              if (got.back) {
                Object.assign(j, { state: "asks", back: got.back });
                break;
              }

              if (got.proposal) {
                Object.assign(j, { state: "ready", proposal: got.proposal });
                break;
              }

              if (got.explore) {
                turns++;
                let exploreRows: Rows;
                try {
                  exploreRows = await o.data.query(t, got.explore.query, 20);
                } catch (err) {
                  exploreRows = { rows: [], columns: [], capped: false, ms: 0 };
                }

                j.explorations = j.explorations ?? [];
                j.explorations.push({
                  query: got.explore.query,
                  why: got.explore.why,
                  rowCount: exploreRows.rows.length,
                });
                changed(j);

                const sampleText = exploreRows.rows
                  .slice(0, 10)
                  .map((r) =>
                    exploreRows.columns.map((c) => String(r[c] ?? "NULL").slice(0, 100)).join("\t")
                  )
                  .join("\n");

                prompt = `Exploratory query ${turns} returned ${exploreRows.rows.length} rows (${exploreRows.columns.join(", ")}):
<result>
${sampleText || "(no rows)"}
</result>

${
  turns >= MAX_EXPLORATORY
    ? `You have reached the maximum of ${MAX_EXPLORATORY} exploratory queries. You must now output your final query:`
    : `You may run up to ${MAX_EXPLORATORY - turns} more exploratory query, or return your final query now:`
}
Answer with JSON only, one of:
${turns < MAX_EXPLORATORY ? `{"explore": "query", "why": "reason"}\n` : ""}{"sql": "final query", "says": "short summary"}
{"ask": "clarification question"}`;
              }
            }

            // If we finished iterations without proposal or error
            if (j.state === "thinking") {
              const finalReply = await o.asker!.ask(
                `${prompt}\nPlease output your final proposal now: {"sql": "query", "says": "summary"}`
              );
              const got = proposalOf(finalReply);
              if (got?.proposal) {
                Object.assign(j, { state: "ready", proposal: got.proposal });
              } else if (got?.back) {
                Object.assign(j, { state: "asks", back: got.back });
              } else {
                Object.assign(j, {
                  state: "failed",
                  error: "The agent did not output a final query after exploratory checks.",
                });
              }
            }
          } else {
            // Manual mode: single question-to-proposal turn
            const answer = await o.asker!.ask(queryPrompt(q, t, schema));
            const got = proposalOf(answer);
            if (!got) {
              Object.assign(j, {
                state: "failed",
                error: "The agent didn't return a query this pack would run. Ask again, or more precisely.",
              });
            } else if (got.proposal) {
              Object.assign(j, { state: "ready", proposal: got.proposal });
            } else {
              Object.assign(j, { state: "asks", back: got.back });
            }
          }
        } catch (e) {
          Object.assign(j, {
            state: "failed",
            error: String((e as Error)?.message ?? e).slice(0, 300),
          });
        }
        changed(j);
      })();

      return j;
    },

    review(id, sql, rows) {
      const j = jobs.get(id);
      if (!j || j.review?.state === "thinking") return;

      const no = why();
      if (no) {
        j.review = { state: "failed", error: no };
        changed(j);
        return;
      }

      j.review = { state: "thinking" };
      changed(j);

      void (async () => {
        try {
          const text = await o.asker!.ask(reviewPrompt(j.question, sql, rows));
          const got = proposalOf(text);
          const plain = text
            .replace(/\{[\s\S]*"sql"[\s\S]*\}\s*$/, "")
            .replace(/```(json)?\s*```/g, "")
            .trim()
            .slice(0, 4000);

          j.review = {
            state: "ready",
            text: plain || "(result reviewed, see proposed query below)",
            proposal: got?.proposal,
          };
        } catch (e) {
          j.review = {
            state: "failed",
            error: String((e as Error)?.message ?? e).slice(0, 300),
          };
        }
        changed(j);
      })();
    },
  };

  return api;
}
