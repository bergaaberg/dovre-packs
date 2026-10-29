#!/bin/sh
# Rebuilds vendor/ and gen.ts. Needs Node and npm (nothing else).
# - vendor/: web-tree-sitter (its runtime .wasm and ES module) and one grammar .wasm plus its
#   highlight queries per language, from the npm packages pinned below (npm checks each tarball
#   against the registry's integrity hash). All MIT; their licences are copied beside them.
# - gen.ts: the first 16 hex digits of each .wasm's SHA-256 (core's WasmFile), the queries, the
#   runtime and engine.js as strings (the Worker can't read files), so served pages match the tests.
# Everything it writes is committed: installing or testing the pack needs neither npm nor network.
set -eu
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rm -rf vendor && mkdir -p vendor/licenses
fetch() { # <package@version> <dir name>
  (cd "$work" && npm pack "$1" --silent >/dev/null && mkdir -p "$2" && tar xzf ./*.tgz -C "$2" && rm ./*.tgz)
  cp "$work/$2/package/LICENSE" "vendor/licenses/$2.txt" 2>/dev/null || true
}
fetch web-tree-sitter@0.27.1 runtime
cp "$work/runtime/package/web-tree-sitter.wasm" vendor/runtime.wasm
cp "$work/runtime/package/web-tree-sitter.js" vendor/web-tree-sitter.js
fetch tree-sitter-javascript@0.25.0 javascript
cp "$work/javascript/package/tree-sitter-javascript.wasm" vendor/javascript.wasm
cat "$work/javascript/package/queries/highlights.scm" > vendor/javascript.scm
cat "$work/javascript/package/queries/highlights-jsx.scm" >> vendor/javascript.scm 2>/dev/null || true
fetch tree-sitter-typescript@0.23.2 typescript
cp "$work/typescript/package/tree-sitter-typescript.wasm" vendor/typescript.wasm
cp "$work/typescript/package/tree-sitter-tsx.wasm" vendor/tsx.wasm
cat "$work/javascript/package/queries/highlights.scm" "$work/typescript/package/queries/highlights.scm" > vendor/typescript.scm
cat vendor/javascript.scm "$work/typescript/package/queries/highlights.scm" > vendor/tsx.scm
fetch tree-sitter-go@0.25.0 go
cp "$work/go/package/tree-sitter-go.wasm" vendor/go.wasm
cp "$work/go/package/queries/highlights.scm" vendor/go.scm
fetch tree-sitter-rust@0.24.0 rust
cp "$work/rust/package/tree-sitter-rust.wasm" vendor/rust.wasm
cp "$work/rust/package/queries/highlights.scm" vendor/rust.scm
fetch tree-sitter-python@0.25.0 python
cp "$work/python/package/tree-sitter-python.wasm" vendor/python.wasm
cp "$work/python/package/queries/highlights.scm" vendor/python.scm
fetch tree-sitter-json@0.24.8 json
cp "$work/json/package/tree-sitter-json.wasm" vendor/json.wasm
cp "$work/json/package/queries/highlights.scm" vendor/json.scm
fetch @tree-sitter-grammars/tree-sitter-yaml@0.7.1 yaml
cp "$work/yaml/package/tree-sitter-yaml.wasm" vendor/yaml.wasm
cp "$work/yaml/package/queries/highlights.scm" vendor/yaml.scm
fetch @tree-sitter-grammars/tree-sitter-toml@0.7.0 toml
cp "$work/toml/package/tree-sitter-toml.wasm" vendor/toml.wasm
cp "$work/toml/package/queries/highlights.scm" vendor/toml.scm
fetch tree-sitter-css@0.25.0 css
cp "$work/css/package/tree-sitter-css.wasm" vendor/css.wasm
cp "$work/css/package/queries/highlights.scm" vendor/css.scm
fetch tree-sitter-c-sharp@0.23.5 csharp
cp "$work/csharp/package/tree-sitter-c_sharp.wasm" vendor/csharp.wasm
cp "$work/csharp/package/queries/highlights.scm" vendor/csharp.scm
node gen.mjs
