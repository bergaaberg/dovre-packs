#!/bin/sh
# Rebuilds vendor/ and gen.ts. Needs Node and npm (nothing else).
# - vendor/mermaid.js: mermaid's single-file browser build, from the npm package pinned below (npm
#   checks the tarball against the registry's integrity hash). MIT; its licence is copied beside it.
# - gen.ts: the first 16 hex digits of its SHA-256 (core's Pack.files), so a stale copy fails.
# Everything it writes is committed: installing or testing the pack needs neither npm nor network.
set -eu
cd "$(dirname "$0")"
MERMAID=mermaid@12.2.0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rm -rf vendor && mkdir -p vendor/licenses
(cd "$work" && npm pack "$MERMAID" --silent >/dev/null && tar xzf ./*.tgz)
cp "$work/package/dist/mermaid.min.js" vendor/mermaid.js
cp "$work/package/LICENSE" vendor/licenses/mermaid.txt
sha=$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(require("node:fs").readFileSync("vendor/mermaid.js")).digest("hex").slice(0,16))')
cat > gen.ts <<GEN
// Written by build.sh: don't edit.
/** The first 16 hex digits of vendor/mermaid.js's SHA-256 ($MERMAID). */
export const MERMAID_SHA = "$sha";
GEN
echo "vendor/mermaid.js ($MERMAID) $sha"
