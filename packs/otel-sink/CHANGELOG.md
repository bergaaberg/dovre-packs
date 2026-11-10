# otel-sink

## 1.2.1 — 2026-11-10

- Moved to Pack API 2.0 (dovre#484): needs Dovre with pack contract 2. Nothing changes in what it does. Its manifest now says `db: "raw"`, shown on its card: it keeps its own tables in Dovre's database.

## 1.2.0 — 2026-11-10

- The buttons beside an HTTP span are this pack's own place now (`hosts`: `span.actions`, filled by other packs as `"otel-sink/span.actions"`), not core's `span.actions` slot. Needs core API 1.39. Update `http` with it (1.2.0): an older `http` only fills core's slot, so its "Open in HTTP client" button is gone from a trace until it's updated too.

## 1.1.4 — 2026-11-10

- Needs core API 1.28 (it declared 1.24): It uses the `D1` types (1.27) and its tests `openDb`, `createWorker` and `ingestToken` (1.27, 1.28), so it says so. Nothing changes in what it does.

## 1.1.3 — 2026-11-09

- Takes core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does.

## 1.1.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.1 — 2026-11-09

- Its pulse is `pulse` (`PulseFeed`), core's name for it; `avatar` was the old one.

## 1.1.0 — 2026-11-02

- A service's page says which repo and version it runs, linked on the forge (`OTEL_SINK_SERVICES`).
- Investigate on an erroring service and on a failing trace: hands Bino or an agent the service, span names, error types and counts, with the repo (never an error's message).
- Metrics show their week: hourly means over 7 days as a sparkline, with the range.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
