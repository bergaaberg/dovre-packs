/**
 * The Docker page (the docker pack): the engine, then containers by compose project with start, stop
 * and restart one click each and Remove behind a Confirm; a container's page follows its logs.
 * Names, images and Docker's status words are the engine's data, escaped like any other.
 */
import { html } from "hono/html";
import { Confirm, Empty, type Html, Item, KeyValues, List, Notice, PageHeader, type PageOpts, Panel, Pill } from "dovre/pack.ts";
import type { DockerView } from "./docker.ts";
import type { Container, Group } from "./model.ts";
import { groupsOf } from "./model.ts";

const head = html`<meta name="u-topics" content="docker">`;

const tone = (c: Container) =>
  c.health === "unhealthy" || c.state === "dead" ? "bad" : c.state === "running" ? (c.health === "starting" ? "warn" : "ok") : c.state === "restarting" || c.state === "paused" ? "warn" : undefined;

const btn = (action: string, label: string, busy: string, cls = "sm") =>
  html`<form method="post" action="${action}"><button type="submit" class="${cls}" data-busy="${busy}">${label}</button></form>`;

function containerItem(c: Container, v: DockerView): Html {
  const busy = v.busy[c.id];
  const up = c.state === "running" || c.state === "restarting" || c.state === "paused";
  const base = `/docker/c/${c.id}`;
  const acts = busy
    ? html`<span class="t3">${busy === "stop" ? "Stopping" : busy === "remove" ? "Removing" : busy === "restart" ? "Restarting" : "Starting"}…</span>`
    : up
      ? html`${btn(`${base}/stop`, "Stop", "Stopping")}${btn(`${base}/restart`, "Restart", "Restarting", "sm ghost")}`
      : html`${btn(`${base}/start`, "Start", "Starting", "sm primary")}${Confirm({ kind: "docker.remove", action: `${base}/remove`, label: "Remove", danger: true, question: html`Remove the container <strong>${c.name}</strong>? Its volumes stay; what's only inside the container goes.` })}`;
  return Item({
    lead: html`<span class="dot${tone(c) ? ` ${tone(c)}` : ""}" aria-hidden="true"></span>`,
    title: html`<a class="name" href="${base}"><strong>${c.service ?? c.name}</strong></a>${c.health && c.health !== "healthy" ? html` ${Pill({ tone: c.health === "unhealthy" ? "bad" : "warn", children: c.health })}` : ""}`,
    line: html`${c.image}${c.ports.length ? html` · ${c.ports.join(", ")}` : ""}`,
    trail: html`<span class="t3">${c.status}</span>`,
    more: html`<span class="actions">${acts}</span>`,
    quiet: !up,
  });
}

function groupPanel(g: Group, v: DockerView): Html {
  const all = g.containers.length;
  const p = g.project;
  const acts = p
    ? html`${g.running < all ? btn(`/docker/p/${p}/start`, g.running ? "Start the rest" : "Start all", "Starting") : ""}${g.running ? btn(`/docker/p/${p}/stop`, "Stop all", "Stopping", "sm ghost") : ""}`
    : undefined;
  return Panel({ title: p ?? "Not in a compose project", meta: `${g.running} of ${all} running`, actions: acts, flush: true, children: List(g.containers.map((c) => containerItem(c, v))) });
}

const BERTH = "https://github.com/bergaaberg/berth";

/** Windows without an engine: berth runs one without Docker Desktop. */
const berthHint = html`<p>berth runs Docker Engine in a WSL distro of its own, without Docker Desktop (<a href="${BERTH}">github.com/bergaaberg/berth</a>). With its <code>berth.exe</code>:</p><pre class="code">berth setup</pre><p>Then restart Dovre (Settings → Restart), and this page switches it on and off.</p>`;

function engineNote(v: DockerView): Html {
  if (v.state === "none")
    return Notice({
      children: v.windows
        ? html`<p><strong>No Docker engine here yet.</strong></p>${berthHint}`
        : html`<p><strong>No Docker engine found.</strong> Start Docker Desktop, OrbStack, Colima, or native dockerd. On a Mac without one, Colima (from Homebrew) starts at login:</p><pre class="code">brew install colima docker
brew services start colima</pre>`,
    });
  if (v.state === "off") return Notice({ children: html`<p><strong>Docker is off.</strong> Its containers stopped with it; the ones with a restart policy come back when it starts.</p><div class="buttons">${btn("/docker/engine/on", "Start Docker", "Starting", "primary")}</div>` });
  if (v.state === "starting") return Notice({ children: html`<p><strong>Starting Docker…</strong> The distro and the engine take a few seconds; this fills in by itself.</p>` });
  if (v.state === "down")
    return Notice({
      tone: "bad",
      children: html`<p><strong>Docker isn't answering${v.pipe ? html` on <code>${v.pipe}</code>` : ""}.</strong> ${v.error ?? ""}</p>${
        v.ours ? html`<div class="buttons">${btn("/docker/engine/on", "Start Docker", "Starting", "primary")}</div>` : v.windows ? html`<p>Start Docker Desktop, or use berth instead.</p>${berthHint}` : ""
      }`,
    });
  return html``;
}

export function dockerPage(v: DockerView, flash?: DockerView["flash"]): PageOpts {
  const groups = groupsOf(v.containers);
  const running = v.containers.filter((c) => c.state === "running").length;
  const sub = v.state === "ok" ? `${running} running · ${v.containers.length} in all${v.version ? ` · Docker Engine ${v.version}` : ""}` : (v.ours ? "Containers on berth: Docker Engine without Docker Desktop." : "Containers on Docker Engine.");
  const actions = v.ours && v.state === "ok" ? Confirm({ kind: "docker.engine-off", action: "/docker/engine/off", label: "Stop Docker", question: `Stop the engine and every container (${running} running)? Volumes and images stay.` }) : undefined;
  const body = html`${PageHeader({ title: "Docker", sub, actions })}
<div data-live id="docker">
${flash ? Notice({ tone: flash.ok ? "ok" : "bad", children: flash.message }) : ""}
${engineNote(v)}
${v.state === "ok" ? (groups.length ? groups.map((g) => groupPanel(g, v)) : Panel({ children: Empty({ title: "No containers", children: html`<p class="t2">Start some with <code>docker compose up -d</code> in a checkout.</p>` }) })) : ""}
</div>`;
  return { title: "Docker · Dovre", current: "/docker", body, head };
}

/** One container: what it is, its actions, and its logs as they come. */
export function containerPage(v: DockerView, c: Container): PageOpts {
  const body = html`${PageHeader({ title: c.name, crumbs: [{ href: "/docker", label: "Docker" }], sub: c.image })}
<div data-live id="docker-c">
${Panel({
  children: html`${KeyValues([
    ["State", html`<span class="st ${tone(c) ?? "mute"}"><i></i>${c.status || c.state}</span>`],
    ...(c.project ? ([["Project", `${c.project}${c.service ? ` · ${c.service}` : ""}`]] as [string, string][]) : []),
    ...(c.ports.length ? ([["Ports", c.ports.join(", ")]] as [string, string][]) : []),
    ["Id", html`<code>${c.id.slice(0, 12)}</code>`],
  ])}<div class="buttons">${containerItemActions(c, v)}</div>`,
})}
</div>
${Panel({ title: "Logs", meta: "the last 300 lines, then as they come; kept nowhere", flush: true, children: html`<pre class="output docker-logs" id="docker-logs" data-src="/docker/c/${c.id}/logs" aria-live="off"></pre>` })}`;
  return { title: `${c.name} · Docker`, current: "/docker", body, head };
}

const containerItemActions = (c: Container, v: DockerView) => {
  const busy = v.busy[c.id];
  if (busy) return html`<span class="t3">Busy…</span>`;
  const base = `/docker/c/${c.id}`;
  return c.state === "running" || c.state === "restarting" || c.state === "paused"
    ? html`${btn(`${base}/stop`, "Stop", "Stopping")}${btn(`${base}/restart`, "Restart", "Restarting", "sm ghost")}`
    : html`${btn(`${base}/start`, "Start", "Starting", "sm primary")}`;
};

export function containerGonePage(): PageOpts {
  return { title: "Docker · Dovre", current: "/docker", body: html`${PageHeader({ title: "Not here", crumbs: [{ href: "/docker", label: "Docker" }] })}${Notice({ children: "That container isn't on the engine (any more)." })}`, head };
}
