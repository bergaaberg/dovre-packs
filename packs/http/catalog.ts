/**
 * HTTP client (`http`): a repo's catalog, its endpoints from its OpenAPI spec and the requests saved
 * in `.http/` as one list (dovre-packs#65). A saved request is a case of the spec's endpoint its
 * method and path match: `{{baseUrl}}/orders/{{id}}` is a case of `GET /orders/{id}`. One that
 * matches none is an endpoint of its own. Pure: the caller reads the spec and the files.
 */
import type { CaseRef } from "./story.ts";
import type { Method, Req } from "./model.ts";
import { type SpecOp, specOps } from "./openapi.ts";

export type Endpoint = {
  method: Method;
  /** As the spec writes it (`/orders/{id}`), or a request's own path with its placeholders as `{name}`. */
  path: string;
  group: string;
  summary: string;
  fromSpec: boolean;
  cases: CaseRef[];
};
export type Catalog = { title: string; endpoints: Endpoint[]; notes: string[] };

const WILD = /^(?:\{\{[^{}]*\}\}|\$\{[^{}]*\}|\{[^{}/]*\})$/;

/** A request URL's path: without `{{baseUrl}}` or scheme and host, its query or its hash. */
export function pathOf(url: string): string | undefined {
  let u = url.trim();
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(u);
  if (abs) u = u.slice(abs[0].length);
  else if (/^\{\{[^{}]*\}\}/.test(u)) u = u.replace(/^\{\{[^{}]*\}\}/, "");
  else if (!u.startsWith("/")) return undefined;
  u = u.split(/[?#]/, 1)[0]!;
  return (u.startsWith("/") ? u : `/${u}`).replace(/\/+$/, "") || "/";
}

const segs = (p: string) => p.split("/").filter(Boolean);

/** Whether a request's path fits a spec path: same length, `{param}` and placeholders match any segment. */
function fits(template: string, path: string): boolean {
  const a = segs(template);
  const b = segs(path);
  return a.length === b.length && a.every((s, i) => s === b[i] || WILD.test(s) || WILD.test(b[i]!));
}

/** Placeholders as `{name}`, so two requests to the same endpoint read the same. */
const normal = (p: string) => p.replace(/\{\{\s*([^{}]*?)\s*\}\}|\$\{\s*([^{}]*?)\s*\}/g, (_, a: string | undefined, b: string | undefined) => `{${a ?? b}}`);

/** The group: the spec's first tag, else the path's first segment that isn't `api` or a version. */
export function groupOf(path: string, tag = ""): string {
  if (tag) return tag;
  return segs(path).find((s) => !/^(api|v\d+)$/i.test(s) && !WILD.test(s)) ?? "other";
}

export function buildCatalog(spec: string | undefined, files: { name: string; reqs: Req[] }[]): Catalog {
  const notes: string[] = [];
  let ops: SpecOp[] = [];
  let title = "";
  if (spec?.trim()) {
    const s = specOps(spec);
    if (s.ok) {
      ops = s.ops;
      title = s.title;
    } else notes.push(`The OpenAPI spec can't be read: ${s.error}`);
  }
  const endpoints: Endpoint[] = ops.map((o) => ({ method: o.method, path: o.path, group: groupOf(o.path, o.tag), summary: o.summary, fromSpec: true, cases: [] }));
  let unplaced = 0;
  for (const f of files) {
    for (const r of f.reqs) {
      const path = pathOf(r.url);
      if (!path) {
        unplaced++;
        continue;
      }
      const ref: CaseRef = { file: f.name, name: r.name };
      // An exact path first, then one a placeholder fits.
      const at =
        endpoints.find((e) => e.method === r.method && e.path === normal(path)) ??
        endpoints.find((e) => e.fromSpec && e.method === r.method && fits(e.path, path)) ??
        endpoints.find((e) => !e.fromSpec && e.method === r.method && fits(e.path, normal(path)));
      if (at) at.cases.push(ref);
      else endpoints.push({ method: r.method, path: normal(path), group: groupOf(path), summary: "", fromSpec: false, cases: [ref] });
    }
  }
  if (unplaced) notes.push(`${unplaced} saved request${unplaced === 1 ? "" : "s"} with a URL that isn't {{baseUrl}}/… or http(s)://… aren't listed.`);
  endpoints.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { title, endpoints, notes };
}
