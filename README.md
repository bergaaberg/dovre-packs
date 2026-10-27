# Dovre Packs (`bergaaberg/dovre-packs`)

Official pre-built **Pluggable Packs** for [Dovre](https://dovre.dev) (`bergaaberg/dovre`).

Core (`bergaaberg/dovre`) ships with the built-in cockpit packs (`agents`, `assistant` / `topo` + `bino`, `terminal`). Optional operations, infrastructure, and app packs live here so you can cherry-pick only what your instance uses.

## Available Pre-Built Packs

| Pack ID | Name | Execution | Description | Required Settings |
|---|---|---|---|---|
| `cf-health` | **Cloudflare Health** | `any` (Local & Hosted) | 24h Cloudflare Workers GraphQL telemetry (`workersInvocationsAdaptive` requests, 5xx errors, status). | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_WORKERS` |
| `http-otel` | **HTTP & OpenTelemetry** | `any` (Local & Hosted) | Polls `/healthz` JSON/HTTP endpoints and optional OpenTelemetry collector metrics. | `HTTP_HEALTH_URLS` |
| `otel` | **OpenTelemetry & Prometheus** | `any` (Local & Hosted) | RED metrics (rate, 5xx %, p95/p99) per service from a Prometheus-compatible API (Prometheus, Mimir, VictoriaMetrics, Grafana Cloud), firing alerts, a 24h error/alert lane on Today's horizon, avatar storm/fire, and the running prod version beside mapped repos on /deploys. | `OTEL_PROMETHEUS_URL`, `OTEL_SERVICES` (`OTEL_BEARER_TOKEN` optional) |
| `otel-sink` | **OTel sink** | `any` (Local & Hosted) | Receives OTLP/HTTP straight from your apps (`POST /otel-sink/ingest/v1/traces`, `/v1/metrics`, `/v1/logs`; JSON or protobuf, gzip or not) with an ingest token made on Settings. RED per service (rate, error %, p50/p95), latest errors with their trace, a trace waterfall, a log tail by service/level/trace; errors on Today's horizon, avatar storm/fire, a need that rings once when a service starts erroring, and the version it reports beside mapped repos on /deploys. Kept in its own `otel_sink_*` tables: spans and logs 24 h, metric rollups 7 days, hard row caps. Attributes are allowlisted on arrival (service, version, environment, HTTP method/route/status, exception type/message); bodies, headers and user ids are dropped, URLs lose their query, e-mail addresses are masked. Hosted: add a Cloudflare Access **Bypass** policy for `/otel-sink/ingest/` (the token is the check there). | *(none)*; optional `OTEL_SINK_SERVICES` (`name=owner/repo`), `OTEL_SINK_ATTRIBUTES` (extra keys to keep), `OTEL_SINK_LOG_BODIES=off` |
| `docker` | **Docker Containers** | `local-only` | Inspects local Docker containers (`docker ps --format json`), status, ports, and health. | `docker` CLI on `PATH` |
| `jira` | **Jira Issues** | `any` (Local & Hosted; `JIRA_VIA=mcp` local only) | Assigned open issues and what moved in your projects (`JIRA_PROJECTS`), a Today card, Jira in search, `PROJ-123` keys as links, and filing tickets in `TICKET_PROJECTS` (the project's live create screen, a preview, two clicks; from New work, search and Bino), logged as `ticket.create`. Reads through the REST API with a token, or through Claude Code's Atlassian MCP where tokens are locked down (`JIRA_VIA=mcp`). | `JIRA_SITE`, then `JIRA_EMAIL` + `JIRA_TOKEN` or `JIRA_VIA=mcp` |
| `kafka` | **Kafka / Redpanda** | `any` (Local & Hosted) | Consumer group lag, dead-letter topics and partition health from a lag endpoint (Redpanda Admin API, Confluent REST Proxy v3, or a lag exporter). Metadata only; rings a need when lag grows. | `KAFKA_ADMIN_URL` |
| `slack` | **Slack** | `any` (Local & Hosted) | Direct mentions in watched channels and saved items, a dock beside Bino's, saved-message proposals for My list, and a Bino send act. Metadata only; message bodies never reach Bino or the actions log. Saved items read `stars.list`, which Slack stopped updating when it moved saved items to "Later" (2023): expect few or none. | `SLACK_TOKEN`, `SLACK_CHANNELS` |
| `gitlab` | **GitLab forge** | `any` (Local & Hosted) | GitLab as the forge (`FORGE=gitlab`): merge requests with reviews, pipelines and threads, todos, group activity and blocked deployments. `REPO_OWNERS` lists the top-level groups. Read-only. | `GITLAB_HOST`, `GITLAB_TOKEN` (`read_api`) |
| `service-bus` | **Azure Service Bus** | `any` (Local & Hosted) | Active, scheduled and dead-lettered counts per queue and topic subscription, with a DLQ radar: a non-empty dead-letter queue is a need, a ring and avatar trouble. Counts and names only, never message bodies. | `SERVICEBUS_ENDPOINT`, `SERVICEBUS_TOKEN` |
| `linear` | **Linear** | `any` (Local & Hosted) | Assigned open Linear issues, active cycle progress, un-triaged team issues, `TEAM-123` linking and Bino acts (create an issue, comment). | `LINEAR_API_KEY` |
| `pubsub` | **Google Cloud Pub/Sub** | `any` (Local & Hosted) | Pub/Sub subscription backlog, oldest unacked message age, and dead-letter radar. | `PUBSUB_PROJECT`, `PUBSUB_TOKEN` |
| `duckdb` | **DuckDB** | `local-only` | Agentic analytics on local DuckDB databases, Parquet, CSV, and JSON lines files (zero-row schema discovery, AI query builder, manual/agentic execution, AI result review), and a file viewer (`/duckdb/files`): open a Parquet, CSV or JSON lines file, or a folder of Parquet files, in a folder source to see its schema (nested types, nullability), row groups, compression and size, column stats (from the metadata, or computed over the first 100,000 rows), a paged preview with a column picker, and hand it to a query. | `DUCKDB_SOURCES`, `duckdb` CLI (1.3+) on `PATH`. Queries run shut in: no file access outside the source, no environment, no extensions loaded. |
| `json` | **JSON tools** | `any` (Local & Hosted) | Format, minify and validate JSON (error at line and column), a tree with each node's JSONPath and copy buttons, a JSONPath query (subset: keys, indexes, slices, wildcards, `..`, simple filters), a structural diff (key order ignored), conversion (JSON ↔ YAML; TypeScript types and a JSON Schema inferred from a sample), and decoders: JWT (header, payload, expiry; never verified), base64/base64url, URL-encoding, Unix time ↔ date. Pasted text is handled in the request and never logged, stored or sent anywhere; `private` to Bino. | *(None)* |
| `http` | **HTTP client** | `local-only` | A request editor (method, URL, headers, query, raw/JSON/form body) with environments (`{{baseUrl}}`), send and response view (status, time, size, headers, pretty JSON), history in memory, requests saved per repo as `.http` files (REST Client / JetBrains format) in checkouts under `CODE_DIR`, import from curl and copy as curl. Behind core's strict Origin guard; a send is one click, never a GET or in the background, no redirects followed, 30 s and 1 MB at most; logged as `http.send` / `http.save`. Secrets fill in only for the hosts they're bound to, and are never saved, logged or shown. | *(Optional)* `HTTP_SECRETS` (`NAME@host`, values from the instance's settings), `HTTP_ENVS` |
| `avatar` | **Avatar** (fun) | `any` (Local & Hosted) | Me in Dovre: a creature I pick, shaped by what I do on the forge (PRs merged and reviewed, streak, late commits, languages) and set in a scene by how things are (the packs' pulse: agents working and waiting, storms and fires, on duty). Fills Today's header and Bino's button, says what happened in a speech line, has its own page (`/avatar`) to pick a creature and colours, and gives the starting page its picture. For fun: nothing needs it; hide it on Settings → Layout. | *(None)* |
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
