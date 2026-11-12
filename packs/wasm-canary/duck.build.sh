#!/bin/sh
# Rebuilds duckdb.js (DuckDB's browser API with Apache Arrow, one ES module, minified) and duck.ts
# (its SHA-256, and the pinned worker's and module's) for the canary's DuckDB check (dovre#304: a
# module over 25 MB). The worker and the 36 MB module aren't committed: the pack's `load` fetches
# them from jsDelivr at the pinned version, and core checks their SHA-256 before serving them.
set -eu
cd "$(dirname "$0")"
DUCKDB=1.33.1-dev57.0
ARROW=17.0.0
CDN="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@$DUCKDB/dist"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm init -y >/dev/null && npm install --no-audit --no-fund --silent "@duckdb/duckdb-wasm@$DUCKDB" "apache-arrow@$ARROW" "esbuild@0.25.12")
"$tmp/node_modules/.bin/esbuild" "$tmp/node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs" --bundle --format=esm --minify --legal-comments=none "--banner:js=/* @duckdb/duckdb-wasm $DUCKDB (MIT) with apache-arrow $ARROW (Apache-2.0), flatbuffers (Apache-2.0) and tslib (0BSD), bundled by duck.build.sh. */" --log-level=warning --outfile=duckdb.js
curl -fsSL "$CDN/duckdb-browser-eh.worker.js" -o "$tmp/worker.js"
curl -fsSL "$CDN/duckdb-eh.wasm" -o "$tmp/duckdb.wasm"
cmp -s "$tmp/worker.js" "$tmp/node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js"
cmp -s "$tmp/duckdb.wasm" "$tmp/node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"
sha() { shasum -a 256 "$1" | cut -c1-16; }
cat > duck.ts <<EOF
// Built by duck.build.sh. Don't edit.
/** duckdb.js: @duckdb/duckdb-wasm $DUCKDB's browser API with apache-arrow $ARROW, bundled ($(wc -c < duckdb.js | tr -d ' ') bytes). */
export const DUCK_JS_SHA256 = "$(sha duckdb.js)";
/** The worker and the module, fetched at the pinned version (npm's bytes, checked by this script). */
export const DUCK_WORKER_URL = "$CDN/duckdb-browser-eh.worker.js";
export const DUCK_WORKER_SHA256 = "$(sha "$tmp/worker.js")";
export const DUCK_WASM_URL = "$CDN/duckdb-eh.wasm";
/** $(wc -c < "$tmp/duckdb.wasm" | tr -d ' ') bytes: over the static assets' 25 MB, so R2's hosted. */
export const DUCK_WASM_SHA256 = "$(sha "$tmp/duckdb.wasm")";
EOF
cat duck.ts
