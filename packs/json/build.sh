#!/bin/sh
# Rebuilds vendor/ and gen.ts. Needs Node and npm (nothing else).
# - vendor/jq.wasm: jq compiled to WebAssembly, and vendor/jq.js: its Emscripten runtime as an ES
#   module with loadJq({ wasmURL }) added, from the npm package pinned below (npm checks the tarball
#   against the registry's integrity hash). jq-wasm is MIT, jq is MIT; their licence is copied beside.
# - gen.ts: the first 16 hex digits of each file's SHA-256 (core's WasmFile and Pack.files).
# Everything it writes is committed: installing or testing the pack needs neither npm nor network.
set -eu
cd "$(dirname "$0")"
JQ=jq-wasm@3.0.0-jq-1.8.2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rm -rf vendor && mkdir -p vendor/licenses
(cd "$work" && npm pack "$JQ" --silent >/dev/null && tar xzf ./*.tgz)
cp "$work/package/dist/build/jq.wasm" vendor/jq.wasm
chunk=$(ls "$work"/package/dist/chunk-*.mjs)
[ "$(echo "$chunk" | wc -l)" -eq 1 ] || { echo "expected one chunk in $JQ" >&2; exit 1; }
{
  echo "// $JQ: its browser runtime (dist/$(basename "$chunk")), with loadJq added below by build.sh."
  cat "$chunk"
  echo 'export const loadJq = makeLoadJq({ defaultBuilder: () => { throw new Error("jq: no wasmURL"); }, fromURL: (url) => (reject) => ({ instantiateWasm: streamingHook(url, reject) }) });'
} > vendor/jq.js
cp "$work/package/LICENSE" vendor/licenses/jq-wasm.txt
sha() { node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex").slice(0,16))' "$1"; }
cat > gen.ts <<GEN
// Written by build.sh: don't edit.
/** The first 16 hex digits of vendor/jq.wasm's and vendor/jq.js's SHA-256 ($JQ). */
export const JQ_WASM_SHA = "$(sha vendor/jq.wasm)";
export const JQ_JS_SHA = "$(sha vendor/jq.js)";
GEN
cat gen.ts
