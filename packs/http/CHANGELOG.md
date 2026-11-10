# http

## 1.2.0 — 2026-11-10

- "Open in HTTP client" on a trace's span fills otel-sink's own place (`"otel-sink/span.actions"`, with `uses: ["otel-sink"]`), and what it's handed there is checked before it's read. Needs core API 1.39. It still fills core's `span.actions` slot as well, so an older otel-sink keeps its button; update otel-sink to 1.2.0 with it.

## 1.1.5 — 2026-11-10

- `HTTP_SECRETS` is marked as naming the settings it reads (`namesKeys`), so the secrets it fills in count as its own and the Packs page lists them. Nothing changes in what it sends. Needs core API 1.36.

## 1.1.4 — 2026-11-09

- Takes `strictOrigin` and core's types from the SDK (`dovre/pack.ts`), not core's internals. Nothing changes in what it does. Needs core API 1.27.

## 1.1.3 — 2026-11-09

- Logs its writes with `ctx.logged`, not core's `logAction`. Same names in the actions log. Needs core API 1.25.

## 1.1.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 1.1.1 — 2026-11-09

- The old `…Crate` export alias is gone: import the `…Pack` name.

## 1.1.0 — 2026-11-02

- Checkouts come from core (`ctx.checkouts()` / `ctx.checkout()`, API 1.7): in a pack session (`node src/run.ts http <checkout>`) only that one is offered (dovre#368).

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
