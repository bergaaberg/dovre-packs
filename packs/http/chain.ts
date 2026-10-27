/**
 * HTTP client (`http`): request chaining, REST Client's way. `{{login.response.body.token}}` is a
 * value from the response to the request named `login` (`# @name login` or `### login`):
 *
 *   {{login.response.body.*}}            the whole body
 *   {{login.response.body.token}}        a JSON field ($. is implied), or a JSONPath: body.$.items[0].id
 *   {{login.response.headers.Location}}  a response header (any case)
 *
 * In a run, it's the earlier request of that name in the same run; in the editor, the newest send of
 * that name in history. Responses are held with secrets already masked, so a masked value (••••) is
 * refused rather than sent, as is one holding `{{` (it would be filled in again) or a line break.
 */
import { parse, query } from "../json/tools.ts";
import type { Resp } from "./send.ts";

/** A response by request name: the response, "later" (it comes back earlier in a run not yet started), or nothing. */
export type Refs = (name: string) => Resp | "later" | undefined;

const REF = /^([A-Za-z_][\w-]{0,63})\.response\.(body|headers)(?:\.(.+))?$/s;

export type RefResult = { value: string } | { later: true } | { error: string };

/** A `{{…}}` inside as a response reference: its value, or why not; undefined when it isn't one. */
export function resolveRef(inner: string, refs: Refs | undefined): RefResult | undefined {
  const m = REF.exec(inner);
  if (!m) return undefined;
  const [, name, part, rest = ""] = m as unknown as [string, string, "body" | "headers", string | undefined];
  const got = refs?.(name);
  if (!got) return { error: `No response from ${name} yet: send it first, or run the file with it above this one` };
  if (got === "later") return { later: true };
  const v = part === "headers" ? header(got, rest, name) : body(got, rest, name);
  if ("error" in v) return v;
  if (v.value.includes("••••")) return { error: `${name}'s response has a secret there (masked), so it isn't reused` };
  if (v.value.includes("{{")) return { error: `${name}'s response has {{ there, so it isn't reused` };
  return v;
}

function header(r: Resp, h: string, name: string): { value: string } | { error: string } {
  if (!h) return { error: `${name}.response.headers needs a header name` };
  const found = r.headers.find(([k]) => k.toLowerCase() === h.toLowerCase());
  return found ? { value: found[1] } : { error: `${name}'s response has no ${h} header` };
}

function body(r: Resp, path: string, name: string): { value: string } | { error: string } {
  if (r.binary) return { error: `${name}'s response is binary` };
  if (!path || path === "*") return { value: r.body };
  if (r.truncated) return { error: `${name}'s response was cut off, so its JSON can't be read` };
  const p = parse(r.body);
  if (!p.ok) return { error: `${name}'s response isn't JSON` };
  let found;
  try {
    found = query(p.value, path.startsWith("$") ? path : `$.${path}`, 1).matches[0];
  } catch {
    return { error: `${path} isn't a path ${name}'s response can be read with` };
  }
  if (!found) return { error: `${name}'s response has nothing at ${path}` };
  const v = found.value;
  return { value: typeof v === "string" ? v : JSON.stringify(v) };
}
