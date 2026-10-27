/**
 * An HTTP span from a trace (otel-sink's waterfall, through core's "span.actions" slot) as a
 * request in the editor, so a failing call can be tried again by hand. Only what the trace kept:
 * the method, the route, and a full URL if `url.full` / `http.url` was allowlisted (already
 * without its query). No headers or body were kept, so none come back. Nothing is sent: the
 * button posts to /http/open, which only fills the editor.
 */
import { html } from "hono/html";
import type { Html } from "dovre/ui/kit.ts";
import type { SpanSlotArg } from "dovre/packs/types.ts";
import { blankReq, MAX_URL, METHODS, type Req } from "./model.ts";
import { varName } from "./openapi.ts";
import { formFields, noWhere } from "./view.ts";

const URL_KEYS = ["url.full", "http.url"];
const PATH_KEYS = ["url.path", "http.target"];

/** A route's parameters as variables: `/users/:id`, `/users/{id}`, `/users/<int:id>` → `/users/{{id}}`. */
export function routeVars(route: string): string {
  return route
    .replace(/\{([^}/]{1,100})\}/g, (_, n: string) => `{{${varName(n.replace(/[:=].*$/, ""))}}}`)
    .replace(/<(?:[^:>/]{1,40}:)?([^>/]{1,100})>/g, (_, n: string) => `{{${varName(n)}}}`)
    .replace(/(^|\/):([A-Za-z_][\w-]{0,63})\??/g, (_, s: string, n: string) => `${s}{{${varName(n)}}}`)
    .replace(/(^|\/)\*{1,2}(?=\/|$)/g, "$1{{path}}");
}

/** The request a span stands for, or undefined when it kept too little to say (no method, or no path). */
export function reqOfSpan(s: SpanSlotArg): Req | undefined {
  const method = s.method.toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) return undefined;
  const text = (k: string) => (typeof s.attrs[k] === "string" ? (s.attrs[k] as string).trim() : "");
  const full = URL_KEYS.map(text).find((u) => /^https?:\/\/[^\s/]+/i.test(u));
  const path = s.route.trim() || PATH_KEYS.map(text).find((p) => p.startsWith("/")) || "";
  const url = full ?? (path.startsWith("/") ? `{{baseUrl}}${routeVars(path)}` : "");
  if (!url || url.length > MAX_URL || /[\r\n]/.test(url)) return undefined;
  return { ...blankReq(), name: `${s.service} ${method} ${s.route.trim() || path}`.slice(0, 120), method: method as Req["method"], url: url.replace(/\s/g, "%20") };
}

/** The slot's button: the span's request into the editor, with a note that it came from a trace. */
export function spanActions(s: SpanSlotArg): Html | "" {
  const r = reqOfSpan(s);
  if (!r) return "";
  return html`<form method="post" action="/http/open" class="inline">${Object.entries(formFields(r, noWhere())).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="from" value="trace"><button type="submit">Open in HTTP client</button></form>`;
}
