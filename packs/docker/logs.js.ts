/**
 * The pack's script (its manifest `script`, served as a file of its own on every page): only a
 * container's page has #docker-logs, so elsewhere it does nothing.
 */
/** Follows one container's logs into its <pre>: appends as text, keeps the last 400 KB, sticks to the end. */
export const DOCKER_LOGS_JS = String.raw`
const box = document.getElementById("docker-logs");
if (box && "EventSource" in window) {
  const es = new EventSource(box.dataset.src);
  const max = 400000;
  const stuck = () => box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  es.addEventListener("out", (e) => {
    const end = stuck();
    let t = box.textContent + JSON.parse(e.data);
    if (t.length > max) t = t.slice(t.length - max);
    box.textContent = t;
    if (end) box.scrollTop = box.scrollHeight;
  });
  es.addEventListener("end", (e) => {
    es.close();
    const note = JSON.parse(e.data);
    if (note) box.textContent += "\n— " + note + " —\n";
  });
  addEventListener("pagehide", () => es.close());
}
`;
