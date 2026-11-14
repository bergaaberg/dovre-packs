/**
 * Tasks (`tasks`): the browser side of quick-add. As I type, it asks the server how it reads the
 * line (GET /tasks/parse, JSON) and shows that under the box, as text. Without it, the form posts
 * and the task shows on the list as it was read.
 */
export const SCRIPT = `
(() => {
  const boxes = document.querySelectorAll("input[data-tasks-q]");
  if (!boxes.length) return;
  for (const box of boxes) {
    const out = box.form && box.form.querySelector("[data-tasks-preview]");
    if (!out) continue;
    const hint = out.textContent;
    let timer = 0, seq = 0;
    const chip = (text, title) => {
      const s = document.createElement("span");
      s.className = "tasks-chip" + (title ? " tasks-chip-title" : "");
      s.textContent = text;
      return s;
    };
    const show = (r) => {
      out.replaceChildren();
      if (!r || !r.title) { out.textContent = r && r.error ? r.error : hint; return; }
      out.append(chip(r.title, true));
      for (const bit of r.bits || []) out.append(chip(String(bit)));
    };
    box.addEventListener("input", () => {
      clearTimeout(timer);
      const q = box.value;
      if (!q.trim()) { show(null); return; }
      timer = setTimeout(async () => {
        const n = ++seq;
        try {
          const res = await fetch("/tasks/parse?q=" + encodeURIComponent(q.slice(0, 500)), { credentials: "same-origin", headers: { accept: "application/json" } });
          if (!res.ok || n !== seq) return;
          show(await res.json());
        } catch {}
      }, 120);
    });
  }
})();
`;
