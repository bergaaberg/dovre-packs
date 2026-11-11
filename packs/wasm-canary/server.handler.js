// The canary's server (core's Pack.server): wasm-bindgen's glue comes first in server.js, and
// core hands over diff.wasm compiled, as `wasm.diff`. Locally a thread runs this; hosted, a Worker
// of its own.
let ready = false;
export function call(fn, input, wasm) {
  if (fn !== "diff") throw new Error("only diff");
  if (!ready) {
    wasm_bindgen.initSync({ module: wasm.diff });
    ready = true;
  }
  const lines = wasm_bindgen.diff(String(input?.old ?? ""), String(input?.new ?? "")).split("\n").slice(0, -1);
  return { lines };
}
