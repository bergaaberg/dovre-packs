/** Docker Containers Pack (`docker`) views. */
import { html } from "hono/html";
import { Card, Empty, Item, List, Notice, PageHeader, Panel, Pill } from "dovre/ui/kit.ts";
import type { DockerKept } from "./data.ts";

function renderContainers(k: DockerKept) {
  return List(
    k.containers.map((c) => {
      const tone = c.state === "running" ? "ok" : c.state === "exited" ? "neutral" : "warn";
      return Item({
        lead: html`<span class="dot ${tone}" role="img" aria-label="${c.state}"></span>`,
        title: html`<strong>${c.name}</strong> ${Pill({ tone: tone === "neutral" ? undefined : tone, children: c.state })}`,
        line: `${c.image}${c.ports ? ` · ${c.ports}` : ""} · ${c.status}`,
      });
    }),
  );
}

export function dockerPage(k: DockerKept | undefined) {
  return html`${PageHeader({ title: "Docker Containers", sub: "Local containers on this machine" })}
<div data-live id="docker">
${k && !k.ok ? Notice({ tone: "bad", children: k.error ?? "Docker daemon unreachable" }) : ""}
${Panel({
  title: "Containers",
  meta: k ? `${k.containers.filter((c) => c.state === "running").length} running` : "loading",
  flush: true,
  children: k?.containers.length ? renderContainers(k) : Empty({ title: k ? "No containers" : "Not read yet" }),
})}
</div>`;
}

export function dockerCard(k: DockerKept) {
  return Card({
    id: "docker-now",
    title: "Docker",
    meta: html`<a href="/docker">Open</a>`,
    children: k.containers.length ? renderContainers(k) : html`<p class="t2">${k.ok ? "No containers running" : k.error ?? "Docker unavailable"}</p>`,
  });
}
