# Dovre Packs (`bergaaberg/dovre-packs`)

Official pre-built **Pluggable Packs** for [Dovre](https://dovre.dev) (`bergaaberg/dovre`).

Core (`bergaaberg/dovre`) ships with the built-in cockpit packs (`agents`, `assistant` / `atlas` + `bino`, `avatar`, `terminal`). Optional operations, infrastructure, and app packs live here so you can cherry-pick only what your instance uses.

## Available Pre-Built Packs

| Pack ID | Name | Execution | Description | Required Settings |
|---|---|---|---|---|
| `cf-health` | **Cloudflare Health** | `any` (Local & Hosted) | 24h Cloudflare Workers GraphQL telemetry (`workersInvocationsAdaptive` requests, 5xx errors, status). | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_WORKERS` |
| `http-otel` | **HTTP & OpenTelemetry** | `any` (Local & Hosted) | Polls `/healthz` JSON/HTTP endpoints and optional OpenTelemetry collector metrics. | `HTTP_HEALTH_URLS` |
| `otel` | **OpenTelemetry & Prometheus** | `any` (Local & Hosted) | RED metrics (rate, 5xx %, p95/p99) per service from a Prometheus-compatible API (Prometheus, Mimir, VictoriaMetrics, Grafana Cloud), firing alerts, a 24h error/alert lane on Today's horizon, avatar storm/fire, and the running prod version beside mapped repos on /deploys. | `OTEL_PROMETHEUS_URL`, `OTEL_SERVICES` (`OTEL_BEARER_TOKEN` optional) |
| `docker` | **Docker Containers** | `local-only` | Inspects local Docker containers (`docker ps --format json`), status, ports, and health. | `docker` CLI on `PATH` |
| `jira` | **Jira Issues** | `any` (Local & Hosted) | Tracks assigned open Jira issues, links `PROJ-123` keys in PRs/My List, and renders a Today card. | `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| `kafka` | **Kafka / Redpanda** | `any` (Local & Hosted) | Consumer group lag, dead-letter topics and partition health from a lag endpoint (Redpanda Admin API, Confluent REST Proxy v3, or a lag exporter). Metadata only; rings a need when lag grows. | `KAFKA_ADMIN_URL` |
| `gitlab` | **GitLab forge** | `any` (Local & Hosted) | GitLab as the forge (`FORGE=gitlab`): merge requests with reviews, pipelines and threads, todos, group activity and blocked deployments. `REPO_OWNERS` lists the top-level groups. Read-only. | `GITLAB_HOST`, `GITLAB_TOKEN` (`read_api`) |
| `service-bus` | **Azure Service Bus** | `any` (Local & Hosted) | Active, scheduled and dead-lettered counts per queue and topic subscription, with a DLQ radar: a non-empty dead-letter queue is a need, a ring and avatar trouble. Counts and names only, never message bodies. | `SERVICEBUS_ENDPOINT`, `SERVICEBUS_TOKEN` |
| `linear` | **Linear** | `any` (Local & Hosted) | Assigned open Linear issues, active cycle progress, un-triaged team issues, `TEAM-123` linking and Bino acts (create an issue, comment). | `LINEAR_API_KEY` |
| `pubsub` | **Google Cloud Pub/Sub** | `any` (Local & Hosted) | Pub/Sub subscription backlog, oldest unacked message age, and dead-letter radar. | `PUBSUB_PROJECT`, `PUBSUB_TOKEN` |
| `custom-app` | **Custom App Starter** | `any` (Local & Hosted) | Clean 3-file starter pack (`index.ts`, `data.ts`, `view.ts`) + hostile-input test suite. | *(Optional)* `CUSTOM_APP_URL` |

## Installing a Pack in 1 Command

From your Dovre checkout (`../dovre`):

```bash
# Install into your instance repository (e.g. ../dovre-home) and wire into crates.ts / packs.ts:
pnpm --dir ../dovre packs add cf-health --into ../dovre-home
pnpm --dir ../dovre packs add http-otel --into ../dovre-home
pnpm --dir ../dovre packs add custom-app --into ../dovre-home
```

Or import directly from a sibling `dovre-packs` checkout in your instance's `crates.ts` / `packs.ts`.

## Pack Architecture & Security Contract

Every pack in this repository adheres to `PACK_API = 1` (`dovre/packs/types.ts`):
- **Synchronous reads:** `nav`, `today`, `brief`, `glance`, `bino`, and `routes` read strictly from in-memory state populated by `refresh()`.
- **Isolated & time-boxed:** A slow or failing upstream never blocks Dovre's Today view or crashes another pack.
- **Escaped markup & URLs:** All HTML is rendered with Hono's `html` tagged template and every external URL passes through `safeUrl()`. Every pack includes a hostile-input test (`<script>alert(1)</script>` and `javascript:alert(1)`).
