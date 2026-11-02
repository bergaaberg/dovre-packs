/**
 * JSON tools (`json`): the browser side of the jq tab. jq (WebAssembly, vendor/) runs in a Web
 * Worker, so a filter that never ends only costs that worker: it's stopped after 5 seconds. What's
 * pasted goes to the worker, never to the server. Output is put on the page as text.
 */

/** The worker: loads jq once (its runtime and module from the paths the page names), then runs filters. */
export const WORKER_JS = `
let jq = null;
const FLAGS = new Set(["-c", "-r", "-s", "-S", "-n"]);
const MAX_OUT = 1000000;
self.onmessage = async (e) => {
  const { id, core, wasm, input, filter, flags } = e.data || {};
  try {
    if (!jq) jq = await (await import(core)).loadJq({ wasmURL: wasm });
    const r = jq.raw(String(input ?? ""), String(filter ?? "."), (flags || []).filter((f) => FLAGS.has(f)));
    self.postMessage({ id, stdout: r.stdout.slice(0, MAX_OUT), more: r.stdout.length > MAX_OUT, stderr: r.stderr.slice(0, 4000), exitCode: r.exitCode, version: jq.version });
  } catch (err) {
    const msg = String((err && err.message) || err).replace(/\s*Build with -s.*$/, "").slice(0, 500);
    // After an abort (out of memory, most likely) this jq is done: the next run loads a fresh one.
    const why = jq ? "jq stopped: " + msg + (/abort/i.test(msg) ? " (out of memory?)" : "") : "jq couldn't start: " + msg;
    jq = null;
    self.postMessage({ id, stdout: "", stderr: why, exitCode: -1 });
  }
};`;

/** On every page while the pack is on; does something only on the jq tab. */
export const SCRIPT = `
(() => {
  const form = document.querySelector("form[data-jq]");
  const out = document.querySelector("[data-jq-out]");
  if (!form || !out) return;
  const meta = out.querySelector("[data-jq-meta]"), stdout = out.querySelector("[data-jq-stdout]");
  const errBox = out.querySelector("[data-jq-err]"), stderr = out.querySelector("[data-jq-stderr]");
  let worker = null, timer = null, n = 0;
  const stop = () => { if (worker) worker.terminate(); worker = null; };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const flags = ["c", "r", "s", "S", "n"].filter((f) => fd.get("f-" + f)).map((f) => "-" + f);
    const id = ++n, t0 = performance.now();
    out.hidden = false;
    meta.textContent = "Running…";
    clearTimeout(timer);
    if (!worker) {
      worker = new Worker(form.dataset.worker, { type: "module" });
      worker.onerror = () => { meta.textContent = "jq couldn't start in this browser."; stop(); };
    }
    worker.onmessage = (ev) => {
      const r = ev.data || {};
      if (r.id !== n) return;
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      stdout.textContent = r.stdout + (r.more ? "\\n… (cut at 1 MB)" : "");
      stderr.textContent = r.stderr || "";
      errBox.hidden = !r.stderr;
      const lines = r.stdout ? r.stdout.replace(/\\n$/, "").split("\\n").length : 0;
      meta.textContent = (r.exitCode === 0 ? lines + " line" + (lines === 1 ? "" : "s") : "exit " + r.exitCode) + " · " + ms + " ms" + (r.version ? " · " + r.version : "");
    };
    timer = setTimeout(() => {
      if (id !== n) return;
      stop();
      meta.textContent = "Stopped: the filter was still running after 5 seconds.";
    }, 5000);
    worker.postMessage({ id, core: form.dataset.core, wasm: form.dataset.wasm, input: String(fd.get("input") ?? ""), filter: String(fd.get("filter") ?? "."), flags });
  });
})();`;
