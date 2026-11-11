/**
 * Writes server.js (wasm-bindgen's glue from diff.wasm.ts, then server.handler.js) and its
 * SHA-256 in server.sha.ts. build.sh runs it last; run it alone after changing the handler:
 * `node --experimental-strip-types server.build.ts`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DIFF_GLUE } from "./diff.wasm.ts";

export const serverText = () => `// Built by server.build.ts from diff.wasm.ts's glue and server.handler.js. Don't edit.\n${DIFF_GLUE}\n${readFileSync(new URL("./server.handler.js", import.meta.url), "utf8")}`;

if (import.meta.main) {
  const text = serverText();
  writeFileSync(new URL("./server.js", import.meta.url), text);
  const sha = createHash("sha256").update(text).digest("hex").slice(0, 16);
  writeFileSync(new URL("./server.sha.ts", import.meta.url), `// Built by server.build.ts. Don't edit.\n/** The first 16 hex digits of server.js's SHA-256. */\nexport const SERVER_SHA256 = ${JSON.stringify(sha)};\n`);
  console.log(`server.js: ${text.length} bytes (sha256 ${sha})`);
}
