/**
 * Custom App Pack (`custom-app`) views: `/custom-app` page and Today card.
 * All dynamic strings go through `html` tagged templates and all links through `safeUrl()`.
 */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, PageHeader, Panel } from "dovre/ui/kit.ts";
import type { Kept } from "./data.ts";

const items = (k: Kept) =>
  List(
    k.items.map((i) =>
      Item({
        href: i.href ? safeUrl(i.href) : undefined,
        title: i.title,
        line: i.sub,
      }),
    ),
  );

export function customAppPage(k: Kept | undefined) {
  return html`${PageHeader({ title: "Custom App", sub: k?.summary })}
<div data-live id="custom-app">
${Panel({
  title: "Activity",
  flush: true,
  children: k?.items.length ? items(k) : Empty({ title: k ? "Nothing yet" : "Not read yet" }),
})}
</div>`;
}

export const customAppCard = (k: Kept) =>
  Card({
    id: "custom-app-now",
    title: "Custom App",
    meta: html`<a href="/custom-app">Open</a>`,
    children: k.items.length ? items(k) : html`<p class="t2">${k.summary}</p>`,
  });
