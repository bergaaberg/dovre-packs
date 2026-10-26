/**
 * DuckDB Pack views: home, sources, table inspection, query results,
 * AI query builder cards, opt-in review, and across-source panels.
 */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Notice, PageHeader, Panel, Pill, type Child } from "dovre/ui/kit.ts";
import { MAX_ROWS, MAX_SQL, type Column, type DuckDbTarget, type Found, type Rows, type TableInfo } from "./data.ts";
import { type Across, type AcrossPick, type Job, MAX_PICKS, MAX_QUESTION, type Proposal } from "./agent.ts";

export const dbHref = (t: string, find?: string) =>
  safeUrl(`/duckdb/db?t=${encodeURIComponent(t)}${find ? `&find=${encodeURIComponent(find)}` : ""}`);

export const tableHref = (t: string, table: string) =>
  safeUrl(`/duckdb/table?t=${encodeURIComponent(t)}&n=${encodeURIComponent(table)}`);

export const askHref = (id: string) =>
  safeUrl(`/duckdb/ask/${encodeURIComponent(id)}`);

export const acrossHref = (id: string) =>
  safeUrl(`/duckdb/across/${encodeURIComponent(id)}`);

const crumbs = (t?: string, table?: string) => [
  { href: "/duckdb", label: "DuckDB" },
  ...(t ? [{ href: dbHref(t), label: t }] : []),
  ...(table ? [{ href: tableHref(t!, table), label: table }] : []),
];

/** Many short links in columns: databases, tables, names found. */
const tgrid = (items: { href: string; name: Child; n?: string }[]) =>
  html`<ul class="tgrid">${items.map(
    (i) =>
      html`<li><a href="${i.href}"><span>${i.name}</span>${i.n ? html`<span class="n">${i.n}</span>` : ""}</a></li>`
  )}</ul>`;

/** Formats a single cell value safely. */
export function cell(v: unknown): Child {
  if (v === null || v === undefined) return html`<span class="t3">NULL</span>`;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 300
    ? html`<span title="${s.slice(0, 4000)}">${s.slice(0, 300)}…</span>`
    : s;
}

/** Rows as a table that scrolls horizontally and vertically. */
export function rowsTable(r: Rows): Child {
  if (!r.rows.length) return Empty({ title: "No rows returned" });
  return html`<div class="sheet"><table class="data cells"><thead><tr>${r.columns.map(
    (c) => html`<th scope="col">${c}</th>`
  )}</tr></thead><tbody>${r.rows.map(
    (row) => html`<tr>${r.columns.map((c) => html`<td>${cell(row[c])}</td>`)}</tr>`
  )}</tbody></table></div>`;
}

export const rowsMeta = (r: Rows) =>
  `${r.rows.length}${r.capped ? `+ (the first ${MAX_ROWS})` : ""} ${
    r.rows.length === 1 ? "row" : "rows"
  } · ${(r.ms / 1000).toFixed(2)} s`;

/** Query input form with table and column autocomplete. */
export function queryForm(t: string, sql = "", ask?: string): Child {
  const isMulti = sql.split("\n").length;
  return html`<form method="post" action="/duckdb/q" class="query" data-ctrl-enter><input type="hidden" name="t" value="${t}">${
    ask ? html`<input type="hidden" name="ask" value="${ask}">` : ""
  }<label class="field"><span class="label">Query (DuckDB SQL)</span><textarea name="sql" rows="${Math.min(
    18,
    Math.max(5, isMulti + 1)
  )}" maxlength="${MAX_SQL}" required spellcheck="false" autocomplete="off" class="mono" data-schema="/duckdb/schema?t=${encodeURIComponent(
    t
  )}" placeholder="SELECT * FROM table LIMIT 100;">${sql}</textarea><span class="hint">DuckDB SQL, read-only. First ${MAX_ROWS} rows render on this response. Ctrl+Enter runs it. Tables and columns complete as you type.</span></label><div class="buttons"><button type="submit" class="primary" data-busy="Running">Run</button></div></form>`;
}

/** Ask box for plain-language questions. */
export function askBox(t: string, defaultMode = "manual", why?: string): Child {
  return Panel({
    title: "Ask in plain words",
    children: why
      ? html`<p class="notes">${why}</p>`
      : html`<form method="post" action="/duckdb/ask" class="query" data-ctrl-enter><input type="hidden" name="t" value="${t}"><label class="field"><span class="label">Question</span><textarea name="question" rows="2" maxlength="${MAX_QUESTION}" required placeholder="Which product categories had the highest sales growth?"></textarea><span class="hint">The query agent builds a read-only query from table and column names without seeing row data.</span></label><div class="field"><label class="check"><input type="checkbox" name="agentic" value="1"${
          defaultMode === "agentic" ? " checked" : ""
        }> <strong>Agentic mode</strong> (allows the agent up to 3 bounded exploratory SELECT queries to check distinct values or ranges before returning)</label></div><div class="buttons"><button type="submit" class="primary" data-busy="Writing">Write query</button></div></form>`,
  });
}

/** Ask across all sources box. */
export function askAcrossBox(defaultMode = "manual", why?: string): Child {
  return Panel({
    title: "Ask across sources",
    children: why
      ? html`<p class="notes">${why}</p>`
      : html`<form method="post" action="/duckdb/across" class="query" data-ctrl-enter><label class="field"><span class="label">Question</span><textarea name="question" rows="2" maxlength="${MAX_QUESTION}" required placeholder="Where do we store customer profiles, and how many are active?"></textarea><span class="hint">The agent inspects table names across all sources, picks up to ${MAX_PICKS} relevant sources, and writes a query for each.</span></label><div class="field"><label class="check"><input type="checkbox" name="agentic" value="1"${
          defaultMode === "agentic" ? " checked" : ""
        }> <strong>Agentic mode</strong> (explore values before final proposals)</label></div><div class="buttons"><button type="submit" class="primary" data-busy="Routing">Find sources & write queries</button></div></form>`,
  });
}

export function duckdbHome(o: {
  sources: DuckDbTarget[];
  defaultMode: string;
  whyAgent?: string;
}) {
  return html`${PageHeader({
    title: "DuckDB",
    sub: "Agentic analytics on local DuckDB databases, Parquet, CSV, and JSON lines files.",
  })}
<div data-live id="duckdb">
${
  !o.sources.length
    ? Notice({
        tone: "warn",
        children: html`No DuckDB sources configured. Set <code>DUCKDB_SOURCES</code> in settings (e.g. <code>analytics=/path/to/data.duckdb,logs=/path/to/parquet_dir</code>).`,
      })
    : ""
}
${o.sources.length > 1 ? askAcrossBox(o.defaultMode, o.whyAgent) : ""}
${
  o.sources.length === 1
    ? askBox(o.sources[0]!.id, o.defaultMode, o.whyAgent)
    : ""
}
${Panel({
  title: "Configured Sources",
  meta: String(o.sources.length),
  actions: o.sources.some((s) => s.isDir) ? html`<a href="/duckdb/files">Open a file</a>` : undefined,
  flush: true,
  children: o.sources.length
    ? tgrid(
        o.sources.map((s) => ({
          href: dbHref(s.id),
          name: s.label,
          n: s.path === ":memory:" ? ":memory:" : s.isDir ? "directory" : "duckdb",
        }))
      )
    : Empty({ title: "No sources configured" }),
})}
</div>`;
}

export function duckdbSourcePage(o: {
  target: DuckDbTarget;
  tables: TableInfo[];
  find?: string;
  found?: Found[];
  defaultMode: string;
  whyAgent?: string;
  error?: string;
}) {
  const bySchema = new Map<string, TableInfo[]>();
  for (const t of o.tables) {
    const list = bySchema.get(t.schema) ?? [];
    list.push(t);
    bySchema.set(t.schema, list);
  }

  const foundPanel = o.found
    ? Panel({
        title: html`Names matching “${o.find}”`,
        meta: String(o.found.length),
        flush: true,
        children: o.found.length
          ? tgrid(
              o.found.slice(0, 300).map((f) => ({
                href: tableHref(o.target.id, `${f.schema}.${f.table}`),
                name: html`${f.schema}.${f.table}${f.column ? html` <code>${f.column}</code>` : ""}`,
                n: f.type,
              }))
            )
          : Empty({ title: "Nothing matched that name" }),
      })
    : "";

  return html`${PageHeader({
    title: o.target.label,
    crumbs: crumbs(),
    sub: html`Source: <code>${o.target.path}</code> · Read-only.${
      o.target.isDir ? html` <a href="${safeUrl(`/duckdb/files?t=${encodeURIComponent(o.target.id)}`)}">Browse its files</a>` : ""
    }`,
  })}
<div data-live id="duckdb-${o.target.id}">
${o.error ? Notice({ tone: "bad", children: html`<strong>DuckDB error:</strong> ${o.error}` }) : ""}
${askBox(o.target.id, o.defaultMode, o.whyAgent)}
${Panel({ title: "Query", children: queryForm(o.target.id) })}
<form method="get" action="/duckdb/db" class="find"><input type="hidden" name="t" value="${
    o.target.id
  }"><label class="field"><span class="label">Find a table or column</span><input type="search" name="find" value="${
    o.find ?? ""
  }" maxlength="64" placeholder="Part of table or column name"></label><div class="buttons"><button type="submit">Find</button></div></form>
${foundPanel}
${[...bySchema].map(([schema, list]) =>
  Panel({
    title: schema,
    meta: String(list.length),
    flush: true,
    children: tgrid(
      list.map((x) => ({
        href: tableHref(o.target.id, `${x.schema}.${x.table}`),
        name: x.table,
        n: x.rows !== undefined ? x.rows.toLocaleString() : undefined,
      }))
    ),
  })
)}
${o.tables.length === 0 && !o.error ? Empty({ title: "No tables found in this source" }) : ""}
</div>`;
}

export function duckdbTablePage(o: {
  target: DuckDbTarget;
  table: string;
  cols: Column[];
  peek?: Rows;
  defaultMode: string;
  whyAgent?: string;
  error?: string;
}) {
  const colsRender = o.cols.length
    ? html`<div class="sheet"><table class="data"><thead><tr><th scope="col">#</th><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Nullable</th></tr></thead><tbody>${o.cols.map(
        (c) =>
          html`<tr><td class="t3">${c.pos ?? ""}</td><td><strong>${c.column}</strong></td><td><code>${
            c.type ?? ""
          }</code></td><td>${c.nullable}</td></tr>`
      )}</tbody></table></div>`
    : Empty({ title: "No columns" });

  return html`${PageHeader({
    title: o.table,
    crumbs: crumbs(o.target.id),
    sub: html`Source: ${o.target.label}`,
  })}
<div data-live id="duckdb-table">
${o.error ? Notice({ tone: "bad", children: html`<strong>DuckDB error:</strong> ${o.error}` }) : ""}
${Panel({ title: "Columns", meta: String(o.cols.length), flush: true, children: colsRender })}
${
  o.peek
    ? Panel({
        title: "Sample rows (LIMIT 50)",
        meta: rowsMeta(o.peek),
        flush: true,
        children: rowsTable(o.peek),
      })
    : ""
}
${askBox(o.target.id, o.defaultMode, o.whyAgent)}
${Panel({
  title: "Query",
  children: queryForm(o.target.id, `SELECT *\nFROM ${o.table}\nLIMIT 100;`),
})}
</div>`;
}

/** Form under a query result to opt-in to AI Result Review. */
function reviewForm(t: string, sql: string, askId: string): Child {
  return html`<form method="post" action="/duckdb/ask/${encodeURIComponent(
    askId
  )}/review" class="buttons"><input type="hidden" name="t" value="${t}"><input type="hidden" name="sql" value="${sql}"><button type="submit" data-busy="Reviewing">Review this result</button><span class="hint">Opt-in AI review: sends this single run's capped rows (≤ 100 rows) to the assistant model to explain anomalies or propose improvements. Never persisted.</span></form>`;
}

export function duckdbResultPage(o: {
  target: DuckDbTarget;
  sql: string;
  rows?: Rows;
  error?: string;
  askId?: string;
}) {
  return html`${PageHeader({
    title: "Query Result",
    crumbs: crumbs(o.target.id),
    sub: html`Source: ${o.target.label} · Read-only · Not persisted: run again to view.`,
  })}
<div data-live id="duckdb-result">
${Panel({ children: queryForm(o.target.id, o.sql, o.askId) })}
${o.error ? Notice({ tone: "bad", children: html`<strong>DuckDB said:</strong> ${o.error}` }) : ""}
${
  o.rows
    ? Panel({
        title: "Result",
        meta: rowsMeta(o.rows),
        flush: true,
        children: rowsTable(o.rows),
      })
    : ""
}
${o.askId && (o.rows || o.error) ? reviewForm(o.target.id, o.sql, o.askId) : ""}
</div>`;
}

export function duckdbAskPage(o: { job: Job; model?: string }) {
  const proposal = (p: Proposal, title: string) =>
    Panel({
      title,
      children: html`${p.says ? html`<p>${p.says}</p>` : ""}${queryForm(
        o.job.t,
        p.sql,
        o.job.id
      )}`,
    });

  const explorationsPanel =
    o.job.explorations && o.job.explorations.length
      ? Panel({
          title: "Agentic Exploratory Queries",
          meta: `${o.job.explorations.length} checks run`,
          children: html`<ul class="notes">${o.job.explorations.map(
            (e) =>
              html`<li><code>${e.query}</code> — ${e.why || "inspecting data"} (${e.rowCount} rows)</li>`
          )}</ul>`,
        })
      : "";

  const body =
    o.job.state === "thinking"
      ? html`<p class="notes" aria-live="polite"><span class="spinner" aria-hidden="true"></span> ${
          o.job.mode === "agentic"
            ? "Exploring schema and inspecting data ranges…"
            : "Writing query…"
        }</p>`
      : o.job.state === "failed"
        ? Notice({ tone: "bad", children: o.job.error ?? "The agent did not answer." })
        : o.job.state === "asks"
          ? html`${Notice({ children: html`<strong>The agent asks:</strong> ${o.job.back}` })}<form method="post" action="/duckdb/ask" class="query" data-ctrl-enter><input type="hidden" name="t" value="${
              o.job.t
            }"><input type="hidden" name="question" value="${
              o.job.question
            }"><label class="field"><span class="label">Your answer</span><textarea name="more" rows="2" maxlength="${MAX_QUESTION}" required></textarea></label><div class="buttons"><button type="submit" class="primary" data-busy="Asking">Ask again</button></div></form>`
          : proposal(o.job.proposal!, "Proposed Query");

  const reviewSection = o.job.review
    ? o.job.review.state === "thinking"
      ? html`<p class="notes" aria-live="polite" id="review"><span class="spinner" aria-hidden="true"></span> Reviewing result…</p>`
      : o.job.review.state === "failed"
        ? Notice({ tone: "bad", children: html`<strong>No review:</strong> ${o.job.review.error}` })
        : html`${Panel({
            title: "Result Review",
            children: html`<div id="review" class="ask-review">${o.job.review.text}</div>`,
          })}${o.job.review.proposal ? proposal(o.job.review.proposal, "A better query") : ""}`
    : "";

  return html`${PageHeader({
    title: o.job.question.split("\n")[0]!.slice(0, 120),
    crumbs: crumbs(o.job.t),
    sub: html`Source: ${o.job.t} · Mode: ${o.job.mode} · Model: ${o.model || "assistant model"}`,
  })}
<div data-live id="duckdb-ask-${o.job.id}">
${explorationsPanel}
${body}
${reviewSection}
</div>`;
}

function pickCard(p: AcrossPick, j: Job | undefined): Child {
  const body = !j
    ? Notice({ tone: "bad", children: "This card is no longer active." })
    : j.state === "thinking"
      ? html`<p class="notes"><span class="spinner" aria-hidden="true"></span> Writing query for ${p.t}…</p>`
      : j.state === "failed"
        ? Notice({ tone: "bad", children: j.error ?? "The agent did not answer." })
        : j.state === "asks"
          ? html`${Notice({ children: html`<strong>The agent asks:</strong> ${j.back}` })}<p><a href="${askHref(
              j.id
            )}">Answer</a></p>`
          : html`${j.proposal!.says ? html`<p>${j.proposal!.says}</p>` : ""}${queryForm(
              p.t,
              j.proposal!.sql,
              j.id
            )}`;

  return Panel({
    title: html`<a href="${dbHref(p.t)}">${p.t}</a>`,
    meta: j ? html`<a href="${askHref(j.id)}">Open card</a>` : undefined,
    children: html`${p.why ? html`<p class="t2">${p.why}</p>` : ""}${body}`,
  });
}

export function duckdbAcrossPage(o: {
  across: Across;
  jobs: (id: string) => Job | undefined;
  model?: string;
}) {
  const body =
    o.across.state === "picking"
      ? html`<p class="notes" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Reading table names and selecting sources…</p>`
      : o.across.state === "failed"
        ? Notice({ tone: "bad", children: o.across.error ?? "The agent did not answer." })
        : o.across.state === "asks"
          ? html`${Notice({ children: html`<strong>The agent asks:</strong> ${o.across.back}` })}<form method="post" action="/duckdb/across" class="query" data-ctrl-enter><input type="hidden" name="question" value="${
              o.across.question
            }"><label class="field"><span class="label">Your answer</span><textarea name="more" rows="2" maxlength="${MAX_QUESTION}" required></textarea></label><div class="buttons"><button type="submit" class="primary" data-busy="Asking">Ask again</button></div></form>`
          : o.across.picks.map((p) => pickCard(p, o.jobs(p.job)));

  return html`${PageHeader({
    title: o.across.question.split("\n")[0]!.slice(0, 120),
    crumbs: crumbs(),
    sub: html`Across sources · Model: ${o.model || "assistant model"}`,
  })}
<div data-live id="duckdb-across-${o.across.id}">
${body}
</div>`;
}

export function duckdbCard(sources: DuckDbTarget[], keptCount = 0) {
  return Card({
    id: "duckdb-now",
    title: "DuckDB",
    meta: html`<a href="/duckdb">Open</a>`,
    children: sources.length
      ? html`<p>${sources.length} ${sources.length === 1 ? "source" : "sources"} configured (${sources.map((s) => s.label).join(", ")}).</p>`
      : html`<p class="t2">No sources configured: set DUCKDB_SOURCES</p>`,
  });
}
