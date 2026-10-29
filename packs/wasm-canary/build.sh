#!/bin/sh
# Rebuilds diff.wasm.ts from rust/. Needs Rust with the wasm32-unknown-unknown target and the
# wasm-bindgen CLI at the version rust/Cargo.toml pins (brew install rustup wasm-bindgen).
# The module goes in as base64 and the glue as a string, so the pack loads the same way under
# Node and in a Worker with no bundler rules. The built file is committed: nothing else needs Rust.
set -eu
cd "$(dirname "$0")"
cargo build --manifest-path rust/Cargo.toml --release --target wasm32-unknown-unknown
out=rust/target/bindgen
wasm-bindgen --target no-modules --no-typescript --out-dir "$out" rust/target/wasm32-unknown-unknown/release/wasm_canary.wasm
node -e '
const fs = require("node:fs");
const [wasm, glue] = [fs.readFileSync(process.argv[1]), fs.readFileSync(process.argv[2], "utf8")];
fs.writeFileSync("diff.wasm.ts", `// Built by build.sh from rust/ (${wasm.length} bytes of WebAssembly). Don'"'"'t edit.
/** The module, base64. */
export const DIFF_WASM = ${JSON.stringify(wasm.toString("base64"))};
/** wasm-bindgen'"'"'s glue (--target no-modules): defines \`wasm_bindgen\`, a classic script, no eval. */
export const DIFF_GLUE = ${JSON.stringify(glue)};
`);
console.log(`diff.wasm.ts: ${wasm.length} bytes of WebAssembly, ${glue.length} of glue`);
' "$out/wasm_canary_bg.wasm" "$out/wasm_canary.js"
