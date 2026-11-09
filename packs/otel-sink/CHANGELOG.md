# otel-sink

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
