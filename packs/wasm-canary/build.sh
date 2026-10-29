#!/bin/sh
# Rebuilds diff.wasm and diff.wasm.ts from rust/. Needs Rust with the wasm32-unknown-unknown target
# and the wasm-bindgen CLI at the version rust/Cargo.toml pins (brew install rustup wasm-bindgen).
# The module stays a file beside the pack, out of the Worker bundle (core's WasmFile): diff.wasm.ts
# holds its SHA-256 and wasm-bindgen's glue as a string. Both are committed: nothing else needs Rust.
set -eu
cd "$(dirname "$0")"
cargo build --manifest-path rust/Cargo.toml --release --target wasm32-unknown-unknown
out=rust/target/bindgen
wasm-bindgen --target no-modules --no-typescript --out-dir "$out" rust/target/wasm32-unknown-unknown/release/wasm_canary.wasm
cp "$out/wasm_canary_bg.wasm" diff.wasm
node -e '
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const [wasm, glue] = [fs.readFileSync("diff.wasm"), fs.readFileSync(process.argv[1], "utf8")];
const sha = createHash("sha256").update(wasm).digest("hex").slice(0, 16);
fs.writeFileSync("diff.wasm.ts", `// Built by build.sh from rust/ (diff.wasm: ${wasm.length} bytes). Don'"'"'t edit.
/** The first 16 hex digits of diff.wasm'"'"'s SHA-256. */
export const DIFF_SHA256 = ${JSON.stringify(sha)};
/** wasm-bindgen'"'"'s glue (--target no-modules): defines \`wasm_bindgen\`, a classic script, no eval. */
export const DIFF_GLUE = ${JSON.stringify(glue)};
`);
console.log(`diff.wasm: ${wasm.length} bytes (sha256 ${sha}); glue ${glue.length}`);
' "$out/wasm_canary.js"
