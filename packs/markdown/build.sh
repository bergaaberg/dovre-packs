#!/bin/sh
# Rebuilds vendor/ and gen.ts. Needs Node and npm (nothing else).
# - vendor/mermaid.js, vendor/katex.js and vendor/graphviz.js: their single-file browser builds,
#   from the npm packages pinned below (npm checks each tarball against the registry's integrity
#   hash). Mermaid and KaTeX are MIT, @hpcc-js/wasm-graphviz Apache-2.0 (Graphviz itself EPL); their
#   licences are copied beside them. KaTeX draws MathML only, so neither its CSS nor fonts are
#   needed. graphviz.js is an ES module carrying its WebAssembly inside (hence `wasm` in index.ts).
# - gen.ts: the first 16 hex digits of each one's SHA-256 (core's Pack.files), so a stale copy fails.
# Everything it writes is committed: installing or testing the pack needs neither npm nor network.
set -eu
cd "$(dirname "$0")"
MERMAID=mermaid@12.2.0
KATEX=katex@0.18.11
GRAPHVIZ=@hpcc-js/wasm-graphviz@1.29.2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rm -rf vendor && mkdir -p vendor/licenses
fetch() { # <package@version> <name> <file in the package>
  mkdir -p "$work/$2"
  (cd "$work/$2" && npm pack "$1" --silent >/dev/null && tar xzf ./*.tgz)
  # Without a source map comment: no map is shipped.
  sed '/^\/\/# sourceMappingURL=/d' "$work/$2/package/$3" > "vendor/$2.js"
  cp "$work/$2/package/LICENSE" "vendor/licenses/$2.txt"
}
sha() { node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex").slice(0,16))' "$1"; }
fetch "$MERMAID" mermaid dist/mermaid.min.js
fetch "$KATEX" katex dist/katex.min.js
fetch "$GRAPHVIZ" graphviz dist/index.js
cat > gen.ts <<GEN
// Written by build.sh: don't edit.
/** The first 16 hex digits of vendor/mermaid.js's SHA-256 ($MERMAID). */
export const MERMAID_SHA = "$(sha vendor/mermaid.js)";
/** The first 16 hex digits of vendor/katex.js's SHA-256 ($KATEX). */
export const KATEX_SHA = "$(sha vendor/katex.js)";
/** The first 16 hex digits of vendor/graphviz.js's SHA-256 ($GRAPHVIZ). */
export const GRAPHVIZ_SHA = "$(sha vendor/graphviz.js)";
GEN
cat gen.ts
