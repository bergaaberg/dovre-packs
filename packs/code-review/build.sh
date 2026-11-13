#!/bin/sh
# Rebuilds vendor/ and gen.ts. Needs Node and npm (nothing else).
# - vendor/: web-tree-sitter (its runtime .wasm and ES module) and one grammar .wasm plus its
#   highlight queries per language (and its definition queries, tags.scm, where it has them, with
#   ours from tags/ added), from the npm packages pinned below (npm checks each tarball
#   against the registry's integrity hash); dprint's host (bundled by esbuild) and one formatter
#   plugin .wasm per language. All MIT; their licences are copied beside them.
# - gen.ts: the first 16 hex digits of each .wasm's and of each script's SHA-256 (core's
#   WasmFile and Pack.files), and the queries and engine.js as strings (the Worker can't read files).
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
# Without its source map comment: the map isn't shipped.
sed '/^\/\/# sourceMappingURL=/d' "$work/runtime/package/web-tree-sitter.js" > vendor/web-tree-sitter.js
fetch tree-sitter-javascript@0.25.0 javascript
cp "$work/javascript/package/tree-sitter-javascript.wasm" vendor/javascript.wasm
cat "$work/javascript/package/queries/highlights.scm" > vendor/javascript.scm
cat "$work/javascript/package/queries/highlights-jsx.scm" >> vendor/javascript.scm 2>/dev/null || true
cat "$work/javascript/package/queries/tags.scm" tags/javascript.scm > vendor/javascript.tags.scm
fetch tree-sitter-typescript@0.23.2 typescript
cp "$work/typescript/package/tree-sitter-typescript.wasm" vendor/typescript.wasm
cp "$work/typescript/package/tree-sitter-tsx.wasm" vendor/tsx.wasm
cat "$work/javascript/package/queries/highlights.scm" "$work/typescript/package/queries/highlights.scm" > vendor/typescript.scm
cat vendor/javascript.scm "$work/typescript/package/queries/highlights.scm" > vendor/tsx.scm
cat vendor/javascript.tags.scm "$work/typescript/package/queries/tags.scm" tags/typescript.scm > vendor/typescript.tags.scm
cp vendor/typescript.tags.scm vendor/tsx.tags.scm
fetch tree-sitter-go@0.25.0 go
cp "$work/go/package/tree-sitter-go.wasm" vendor/go.wasm
cp "$work/go/package/queries/highlights.scm" vendor/go.scm
cp "$work/go/package/queries/tags.scm" vendor/go.tags.scm
fetch tree-sitter-rust@0.24.0 rust
cp "$work/rust/package/tree-sitter-rust.wasm" vendor/rust.wasm
cp "$work/rust/package/queries/highlights.scm" vendor/rust.scm
cp "$work/rust/package/queries/tags.scm" vendor/rust.tags.scm
fetch tree-sitter-python@0.25.0 python
cp "$work/python/package/tree-sitter-python.wasm" vendor/python.wasm
cp "$work/python/package/queries/highlights.scm" vendor/python.scm
cp "$work/python/package/queries/tags.scm" vendor/python.tags.scm
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
cp "$work/csharp/package/queries/tags.scm" vendor/csharp.tags.scm
# Formatters (dovre#301): dprint's host bundled into one ES module (core serves each pack file on
# its own, so its imports have to be inside it), and one plugin .wasm per language. A plugin whose
# package has no LICENSE file says its licence in package.json: that and its source are written down.
fetch @dprint/formatter@0.6.0 dprint
out="$PWD/vendor/dprint.js"
(cd "$work" && npx --yes esbuild@0.28.2 dprint/package/esm/mod.js --bundle --format=esm --log-level=warning --outfile="$out")
plugin() { # <package@version> <name> <source repo>
  fetch "$1" "fmt-$2"
  cp "$work/fmt-$2/package/plugin.wasm" "vendor/fmt-$2.wasm"
  if [ ! -f "vendor/licenses/fmt-$2.txt" ]; then
    lic=$(node -p 'require(process.argv[1]).license' "$work/fmt-$2/package/package.json")
    echo "$1: $lic (its package.json). Source: $3" > "vendor/licenses/fmt-$2.txt"
  fi
}
plugin @dprint/typescript@0.96.1 typescript https://github.com/dprint/dprint-plugin-typescript
plugin @dprint/json@0.25.2 json https://github.com/dprint/dprint-plugin-json
plugin @dprint/toml@0.9.0 toml https://github.com/dprint/dprint-plugin-toml
plugin @dprint/markdown@0.28.2 markdown https://github.com/dprint/dprint-plugin-markdown
plugin dprint-plugin-malva@0.16.0 css https://github.com/g-plane/malva
# Python: Ruff's formatter (wasm-bindgen, its own glue and module, not a dprint plugin).
fetch @astral-sh/ruff-wasm-web@0.17.2 fmt-python
cp "$work/fmt-python/package/ruff_wasm_bg.wasm" vendor/fmt-python.wasm
sed '/^\/\/# sourceMappingURL=/d' "$work/fmt-python/package/ruff_wasm.js" > vendor/ruff.js
node gen.mjs
