/**
 * The file viewer's pages (`/duckdb/files`): pick a directory source, walk its folders, and open a
 * file: what it is, its schema, its columns' storage and stats, and a page of rows. Everything a
 * file says (names, types, values) is escaped by `html`; every link is built here and goes
 * through safeUrl.
 */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Empty, KeyValues, Notice, PageHeader, Panel, Pill, type Child, type Crumb, type Html } from "dovre/ui/kit.ts";
import { fileViewName, MAX_SQL, type DuckDbTarget, type FileKind, type Row } from "./data.ts";
import { DEFAULT_COLS, EXPORT_ROWS, FILTER_LABELS, FILTER_OPS, type Filter, handoffSql, type Look, MAX_ENTRIES, type Opened, PAGE_SIZES, type Slice, type Sort, STATS_ROWS } from "./files.ts";
import { dbHref, queryForm } from "./view.ts";
import { KEEP_MS, MAX_UPLOAD, UPLOAD_KINDS } from "./uploads.ts";

export type FileQuery = { cols?: string[]; size: number; page: number; stats?: boolean } & Slice;

/** A remote file typed on the Files page (not a configured source): its URL, and the kind if picked. */
export type Remote = { u: string; k?: FileKind };

type HrefOpts = { t?: string; f?: string; u?: string; k?: FileKind; all?: boolean; cols?: string[]; size?: number; page?: number; stats?: boolean; filter?: Filter; sort?: Sort };

/** /duckdb/files with these parameters (columns repeat as `c`; the filter is fc/fo/fv, the sort s/sd). */
export function filesHref(o: HrefOpts): string {
  return safeUrl(`/duckdb/files${query(o)}`);
}

/** /duckdb/files/export: the same slice as a download. */
export const exportHref = (o: HrefOpts, as: "csv" | "json") => safeUrl(`/duckdb/files/export${query({ ...o, page: 0, stats: false }, as)}`);

/** Reads a filter and sort back from a request's parameters (checked against the columns later). */
export function sliceParams(get: (k: string) => string | undefined): Slice {
  const fc = get("fc") ?? "", fo = get("fo") ?? "", s = get("s") ?? "";
  const op = (FILTER_OPS as readonly string[]).includes(fo) ? (fo as Filter["op"]) : undefined;
  return {
    filter: fc && op ? { col: fc.slice(0, 1000), op, val: (get("fv") ?? "").slice(0, 1000) } : undefined,
    sort: s ? { col: s.slice(0, 1000), desc: get("sd") === "1" } : undefined,
  };
}

function query(o: HrefOpts, as?: string): string {
  const p = new URLSearchParams();
  if (o.t) p.set("t", o.t);
  if (o.f) p.set("f", o.f);
  if (o.u) p.set("u", o.u);
  if (o.k) p.set("k", o.k);
  if (o.all) p.set("all", "1");
  for (const c of o.cols ?? []) p.append("c", c);
  if (o.size && o.size !== 50) p.set("n", String(o.size));
  if (o.page) p.set("p", String(o.page));
  if (o.stats) p.set("stats", "1");
  if (o.filter) {
    p.set("fc", o.filter.col);
    p.set("fo", o.filter.op);
    if (o.filter.op !== "null" && o.filter.op !== "notnull") p.set("fv", o.filter.val);
  }
  if (o.sort) {
    p.set("s", o.sort.col);
    if (o.sort.desc) p.set("sd", "1");
  }
  if (as) p.set("as", as);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** A path's or URL's last part, without a query. */
const lastPart = (p: string) => {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return decodeURIComponent(new URL(p).pathname.split("/").pop() ?? "");
  } catch {}
  return p.split("/").pop() ?? "";
};
const fileViewNameOf = (abs: string) => fileViewName(lastPart(abs));

export const bytes = (n: number | undefined) => {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};

const count = (n: number | undefined) => (n === undefined ? "" : n.toLocaleString("en-GB"));

/** Source › folder › folder › file, each a link. */
function crumbs(t: DuckDbTarget, rel: string): Crumb[] {
  const parts = rel.split("/").filter(Boolean);
  return [
    { href: "/duckdb", label: "DuckDB" },
    { href: filesHref({}), label: "Files" },
    { href: filesHref({ t: t.id }), label: t.label },
    ...parts.slice(0, -1).map((p, i) => ({ href: filesHref({ t: t.id, f: parts.slice(0, i + 1).join("/") }), label: p })),
  ];
}

/** A cell: NULL, a value cut to a line, or a nested value (struct, list, map) that opens. */
export function fileCell(v: unknown): Child {
  if (v === null || v === undefined) return html`<span class="t3">NULL</span>`;
  if (typeof v === "object") {
    const flat = JSON.stringify(v);
    if (flat.length <= 80) return flat;
    return html`<details class="nest"><summary>${flat.slice(0, 80)}…</summary><pre>${JSON.stringify(v, null, 2).slice(0, 4000)}</pre></details>`;
  }
  const s = String(v);
  return s.length > 300 ? html`<span title="${s.slice(0, 4000)}">${s.slice(0, 300)}…</span>` : s;
}

/** A source the viewer opens: a folder, or a single data file. */
export const viewable = (s: DuckDbTarget) => !!(s.isDir || s.file);

const notice = (o: { sources: DuckDbTarget[] }) =>
  o.sources.some(viewable)
    ? ""
    : Notice({
        tone: "warn",
        children: html`No folder or file sources. Add a directory or a data file to <code>DUCKDB_SOURCES</code> (e.g. <code>lake=/path/to/parquet_dir</code> or <code>orders=/path/to/orders.parquet</code>) to open it here.`,
      });

/** A file from this computer: a plain file field (browsers take a dropped file on it too). */
const uploadForm = (up: DuckDbTarget) =>
  Panel({
    title: "Open a file from this computer",
    children: html`<form method="post" action="/duckdb/files/upload" enctype="multipart/form-data" class="query"><label class="field"><span class="label">Parquet, CSV/TSV or JSON lines file</span><input type="file" name="file" accept="${UPLOAD_KINDS}" required><span class="hint">Choose a file or drop it here. It is copied into <code>${up.path}</code> (the <strong>${up.label}</strong> source) and opens in the viewer. ${MAX_UPLOAD / 1024 / 1024} MB at most, removed after ${KEEP_MS / 3_600_000} hours; a file of the same name is replaced.</span></label><div class="buttons"><button type="submit" class="primary" data-busy="Adding">Open</button></div></form>`,
  });

/** A file on the web or in a bucket: a GET form, so the page it opens is a link like any other. */
const urlForm = (u = "") =>
  Panel({
    title: "Open a file by URL",
    children: html`<form method="get" action="/duckdb/files" class="query"><label class="field"><span class="label">URL</span><input type="text" name="u" value="${u}" maxlength="2048" required spellcheck="false" autocomplete="off" class="mono" placeholder="https://example.com/data/orders.parquet"><span class="hint">An <code>https://</code>, <code>s3://</code> or <code>gs://</code> Parquet, CSV or JSON lines file. A private bucket opens with the S3 or GCS keys set in Settings, sent only for that bucket; https files are read without any. DuckDB reads only that URL, through its httpfs extension (<code>duckdb -c 'INSTALL httpfs'</code> once).</span></label><label class="field"><span class="label">Kind</span><select name="k"><option value="">From the URL's ending</option><option value="parquet">Parquet</option><option value="csv">CSV</option><option value="json">JSON lines</option></select></label><div class="buttons"><button type="submit" class="primary" data-busy="Opening">Open</button></div></form>`,
  });

/** /duckdb/files: the folder and file sources to open, and a file to add. */
export function filesHome(o: { sources: DuckDbTarget[]; uploads?: DuckDbTarget; error?: Child; u?: string }): Html {
  const dirs = o.sources.filter(viewable);
  return html`${PageHeader({
    title: "Files",
    crumbs: [{ href: "/duckdb", label: "DuckDB" }],
    sub: "Open a Parquet, CSV or JSON lines file, in a folder source or listed on its own: its schema, stats and rows, without writing SQL.",
  })}
<div data-live id="duckdb-files">
${o.error ? Notice({ tone: "bad", children: o.error }) : ""}
${o.uploads ? uploadForm(o.uploads) : ""}
${urlForm(o.u)}
${notice({ sources: o.sources.filter((s) => s !== o.uploads) })}
${Panel({
  title: "Sources",
  meta: String(dirs.length),
  flush: true,
  children: dirs.length
    ? html`<ul class="tgrid">${dirs.map((s) => html`<li><a href="${filesHref({ t: s.id })}"><span>${s.label}</span><span class="n">${s.file ? s.file : "folder"} · ${s.path}</span></a></li>`)}</ul>`
    : Empty({ title: "No folder or file sources" }),
})}
</div>`;
}

/** A folder: its subfolders and data files, and its Parquet files as one dataset. */
export function folderPage(o: { target: DuckDbTarget; dir: Extract<Opened, { type: "dir" }> }): Html {
  const { target, dir } = o;
  const name = dir.rel ? dir.rel.split("/").pop()! : target.label;
  const all = dir.parquet.length > 1
    ? html`<p><a href="${filesHref({ t: target.id, f: dir.rel, all: true })}">Open the ${dir.parquet.length} Parquet files here as one</a></p>`
    : "";
  return html`${PageHeader({
    title: name,
    crumbs: crumbs(target, dir.rel ? `${dir.rel}/x` : ""),
    sub: html`<code>${dir.abs}</code> · Read-only. <a href="${dbHref(target.id)}">Query this source</a>`,
  })}
<div data-live id="duckdb-folder">
${all}
${Panel({
  title: "In this folder",
  meta: dir.capped ? `the first ${MAX_ENTRIES}` : String(dir.entries.length),
  flush: true,
  children: dir.entries.length
    ? html`<ul class="tgrid">${dir.entries.map(
        (e) =>
          html`<li><a href="${filesHref({ t: target.id, f: e.rel })}"><span>${e.name}${e.isDir ? "/" : ""}</span><span class="n">${e.isDir ? "folder" : `${e.kind} · ${bytes(e.size)}`}</span></a></li>`,
      )}</ul>`
    : Empty({ title: "No folders or Parquet, CSV or JSON lines files here" }),
})}
</div>`;
}

function picker(o: { target: DuckDbTarget; file: Extract<Opened, { type: "file" }>; look: Look; q: FileQuery; remote?: Remote }): Child {
  const picked = new Set(o.look.picked);
  const where = o.remote
    ? html`<input type="hidden" name="u" value="${o.remote.u}">${o.remote.k ? html`<input type="hidden" name="k" value="${o.remote.k}">` : ""}`
    : html`<input type="hidden" name="t" value="${o.target.id}"><input type="hidden" name="f" value="${o.file.rel}">`;
  return html`<form method="get" action="/duckdb/files" class="query">${where}${
    o.file.all ? html`<input type="hidden" name="all" value="1">` : ""
  }${o.q.stats ? html`<input type="hidden" name="stats" value="1">` : ""}<fieldset class="pq-cols"><legend class="label">Columns${
    o.look.columns.length > DEFAULT_COLS ? html` <span class="hint">(the first ${DEFAULT_COLS} unless you pick)</span>` : ""
  }</legend>${o.look.columns.slice(0, 1000).map(
    (c) => html`<label class="check"><input type="checkbox" name="c" value="${c.name}"${picked.has(c.name) ? html` checked` : ""}> ${c.name}</label>`,
  )}</fieldset><label class="field"><span class="label">Rows per page</span><select name="n">${PAGE_SIZES.map(
    (n) => html`<option value="${n}"${n === o.q.size ? html` selected` : ""}>${n}</option>`,
  )}</select></label>${sliceFields(o.look)}<div class="buttons"><button type="submit">Show</button></div></form>`;
}

/** Where (one column, an operator, a value) and order by. */
function sliceFields(look: Look): Child {
  const f = look.slice.filter, so = look.slice.sort;
  const cols = look.columns.slice(0, 1000);
  const opts = (sel: string | undefined) => cols.map((c) => html`<option value="${c.name}"${c.name === sel ? html` selected` : ""}>${c.name}</option>`);
  return html`<div class="fields pq-slice"><label class="field"><span class="label">Where</span><select name="fc"><option value="">(no filter)</option>${opts(f?.col)}</select></label>
<label class="field"><span class="label">Is</span><select name="fo">${FILTER_OPS.map((op) => html`<option value="${op}"${op === (f?.op ?? "eq") ? html` selected` : ""}>${FILTER_LABELS[op]}</option>`)}</select></label>
<label class="field"><span class="label">Value</span><input type="text" name="fv" value="${f?.val ?? ""}" spellcheck="false" autocomplete="off"></label>
<label class="field"><span class="label">Sort by</span><select name="s"><option value="">(file order)</option>${opts(so?.col)}</select></label>
<div class="field"><label class="check"><input type="checkbox" name="sd" value="1"${so?.desc ? html` checked` : ""}> Descending</label></div></div>`;
}

function rowsSheet(cols: string[], rows: Row[]): Child {
  if (!rows.length) return Empty({ title: "No rows here" });
  return html`<div class="sheet"><table class="data cells"><thead><tr>${cols.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead><tbody>${rows.map(
    (r) => html`<tr>${cols.map((c) => html`<td>${fileCell(r[c])}</td>`)}</tr>`,
  )}</tbody></table></div>`;
}

const nullCell = (v: string | number | undefined) => (v === undefined || v === "" ? html`<span class="t3">—</span>` : String(v));

/** A file (or a folder's Parquet files as one): facts, schema, column stats, rows, and DuckDB for real queries. */
export function filePage(o: { target: DuckDbTarget; file: Extract<Opened, { type: "file" }>; look: Look; q: FileQuery; remote?: Remote }): Html {
  const { target, file, look, q, remote } = o;
  const name = file.all ? `${file.rel ? file.rel.split("/").pop() : target.label}/*.parquet` : file.rel ? file.rel.split("/").pop()! : lastPart(file.abs) || target.label;
  const at = remote ? { u: remote.u, k: remote.k } : { t: target.id, f: file.rel, all: file.all };
  const here = { ...at, cols: q.cols, size: q.size, page: q.page, stats: q.stats, ...look.slice };
  const link = (over: Partial<FileQuery>) => filesHref({ ...here, ...over });

  const facts: [Child, Child][] = [
    ["Kind", file.kind === "parquet" ? "Parquet" : file.kind === "csv" ? "CSV" : "JSON lines"],
    ...(file.size !== undefined ? [["Size", bytes(file.size)] as [Child, Child]] : []),
    ...(file.all ? [["Files", String(file.files.length)] as [Child, Child]] : []),
    ...(look.facts?.rows !== undefined ? [["Rows", count(look.facts.rows)] as [Child, Child]] : []),
    ...(look.facts?.rowGroups !== undefined ? [["Row groups", count(look.facts.rowGroups)] as [Child, Child]] : []),
    ...(look.facts?.createdBy ? [["Written by", look.facts.createdBy] as [Child, Child]] : []),
    ["Columns", String(look.columns.length)],
  ];

  const schema = look.columns.length
    ? html`<div class="sheet"><table class="data"><thead><tr><th scope="col">#</th><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Nullable</th></tr></thead><tbody>${look.columns.map(
        (c, i) =>
          html`<tr><td class="t3">${i + 1}</td><td><strong>${c.name}</strong></td><td><code>${c.type}</code></td><td>${
            c.nullable === "no" ? "not null" : c.nullable === "yes" ? "null" : c.nullable === "list" ? "repeated" : html`<span class="t3">—</span>`
          }</td></tr>`,
      )}</tbody></table></div>`
    : Empty({ title: "No columns" });

  const leaves = look.leaves?.length
    ? Panel({
        title: "Columns in the file",
        meta: "from the row groups' metadata",
        flush: true,
        children: html`<div class="sheet"><table class="data"><thead><tr><th scope="col">Column</th><th scope="col">Stored as</th><th scope="col">Compression</th><th scope="col">Size</th><th scope="col">Nulls</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Distinct</th></tr></thead><tbody>${look.leaves.map(
          (l) =>
            html`<tr><td><strong>${l.col}</strong></td><td><code>${l.ty ?? ""}</code></td><td>${l.codec ?? ""}</td><td title="${bytes(l.unpacked)} uncompressed">${bytes(
              l.packed,
            )}</td><td>${nullCell(l.nulls === undefined ? undefined : count(l.nulls))}</td><td>${nullCell(l.lo?.slice(0, 120))}</td><td>${nullCell(
              l.hi?.slice(0, 120),
            )}</td><td>${nullCell(l.distinct === undefined ? undefined : count(l.distinct))}</td></tr>`,
        )}</tbody></table></div>`,
      })
    : "";

  const stats = look.stats
    ? Panel({
        title: "Computed stats",
        meta: `the picked columns, over the first ${count(STATS_ROWS)} rows`,
        flush: true,
        children: html`<div class="sheet"><table class="data"><thead><tr><th scope="col">Column</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Null %</th><th scope="col">Distinct (approx.)</th><th scope="col">Rows read</th></tr></thead><tbody>${look.stats.map(
          (s) =>
            html`<tr><td><strong>${s.col}</strong></td><td>${nullCell(s.lo?.slice(0, 120))}</td><td>${nullCell(s.hi?.slice(0, 120))}</td><td>${nullCell(
              s.nullPct,
            )}</td><td>${nullCell(s.distinct === undefined ? undefined : count(s.distinct))}</td><td>${nullCell(count(s.count))}</td></tr>`,
        )}</tbody></table></div>`,
      })
    : look.statsError
      ? Notice({ tone: "bad", children: html`<strong>No stats:</strong> ${look.statsError}` })
      : html`<p><a href="${link({ stats: true })}">Compute min, max, nulls and distinct over the first ${count(STATS_ROWS)} rows</a></p>`;

  const from = q.page * q.size;
  const paging = html`<span>${look.page.rows.length ? `Rows ${count(from + 1)}–${count(from + look.page.rows.length)}` : ""}${
    q.page > 0 ? html` · <a href="${link({ page: q.page - 1 })}">Previous</a>` : ""
  }${look.page.more ? html` · <a href="${link({ page: q.page + 1 })}">Next</a>` : ""}${
    look.slice.filter && look.matching !== undefined ? ` · ${count(look.matching)} match` : ""
  }</span>`;
  const exports = look.page.columns.length
    ? html`<p class="t2 sm">Download ${look.slice.filter || look.slice.sort ? "this filtered, sorted slice" : "these columns"} (the first ${count(EXPORT_ROWS)} rows at most): <a href="${exportHref(here, "csv")}" download>CSV</a> · <a href="${exportHref(here, "json")}" download>JSON</a></p>`
    : "";

  return html`${PageHeader({
    title: name,
    crumbs: remote ? [{ href: "/duckdb", label: "DuckDB" }, { href: filesHref({}), label: "Files" }] : crumbs(target, file.all && file.rel ? `${file.rel}/x` : file.rel),
    sub: target.url
      ? html`<code>${file.abs}</code> · Read-only, over the network through DuckDB shut in to this one URL. No credentials are sent.`
      : html`<code>${file.abs}</code> · Read-only, through DuckDB shut in to ${target.label}.`,
  })}
<div data-live id="duckdb-file">
${look.error ? Notice({ tone: "bad", children: html`<strong>DuckDB said:</strong> ${look.error}` }) : ""}
${Panel({ title: "File", meta: Pill({ children: target.label }), children: KeyValues(facts) })}
${Panel({ title: "Schema", meta: String(look.columns.length), flush: true, children: schema })}
${leaves}
${stats}
${look.columns.length ? Panel({ title: "Rows", meta: paging, children: html`${picker(o)}${rowsSheet(look.page.columns, look.page.rows)}${exports}` }) : ""}
${Panel({
  title: "Open in DuckDB",
  children: remote
    ? html`<p class="t2">To query it in SQL, add it to <code>DUCKDB_SOURCES</code> as a source of its own, e.g. <code>${fileViewNameOf(file.abs)}=${file.abs}</code>.</p>`
    : html`<p class="t2">For filters, joins and sums: the same file in a query on ${target.label}.</p>${queryForm(target.id, target.url ? `SELECT *\nFROM "${fileViewNameOf(file.abs)}"\nLIMIT 100;` : handoffSql(file, MAX_SQL))}`,
})}
</div>`;
}

/** A path that isn't one to open: outside the source, missing, or not a kind it reads. */
export function notOpenPage(o: { target?: DuckDbTarget; t: string; f: string; sources: DuckDbTarget[] }): Html {
  return filesHome({
    sources: o.sources,
    error: o.target
      ? html`Can't open <code>${o.f}</code> in ${o.target.label}: it isn't a folder or a Parquet, CSV or JSON lines file inside it.`
      : html`No folder or file source named <code>${o.t}</code>.`,
  });
}

/** The pack's own classes (the core's stylesheet doesn't know them). */
export const FILES_STYLES = `
.tgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 2px 1rem; list-style: none; margin: 0 0 8px; padding: 0; }
.tgrid a { display: flex; justify-content: space-between; align-items: baseline; gap: .6rem; padding: .4rem .5rem; border-radius: 6px; text-decoration: none; color: inherit; min-width: 0; }
.tgrid a > span:first-child { overflow-wrap: anywhere; min-width: 0; }
.tgrid a:hover { background: var(--hover); color: var(--accent); }
.tgrid .n { color: var(--ink-3); font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
fieldset.pq-cols { display: flex; flex-wrap: wrap; gap: .3rem 1rem; border: 0; margin: 0 0 .6rem; padding: 0; max-height: 12rem; overflow: auto; }
fieldset.pq-cols legend { padding: 0; margin-bottom: .3rem; }
fieldset.pq-cols .check { overflow-wrap: anywhere; }
.pq-slice select { max-width: 16rem; }
details.nest > summary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
details.nest > pre { white-space: pre-wrap; max-height: 20rem; overflow: auto; margin: .3rem 0 0; }
`;
