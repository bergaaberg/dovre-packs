/**
 * Tasks (`tasks`): the browser side of quick-add. As I type, it asks the server how it reads the
 * line (GET /tasks/parse, JSON) and shows that under the box, as text. Without it, the form posts
 * and the task shows on the list as it was read.
 *
 * And the keys on a list of tasks: j and k move down and up the rows (the row's title takes the
 * focus, so Enter opens it), x ticks the row where the review has tickboxes. Never while typing.
 */
export const SCRIPT = `
(() => {
  const rowOf = (el) => (el && el.closest ? el.closest('li[id^="task-"]') : null);
  if (!window.tasksKeys) document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const by = e.key === "j" ? 1 : e.key === "k" ? -1 : 0;
    if (!by && e.key !== "x") return;
    const on = e.target;
    if (on && on.closest && on.closest("input:not([type=checkbox]), textarea, select, [contenteditable], dialog[open], .xterm")) return;
    const rows = [...document.querySelectorAll('li[id^="task-"]')].filter((li) => li.offsetParent !== null && li.querySelector(".title a"));
    if (!rows.length) return;
    const at = rows.indexOf(rowOf(document.activeElement));
    if (!by) {
      const box = at < 0 ? null : rows[at].querySelector("input.pick");
      if (!box) return;
      e.preventDefault();
      box.checked = !box.checked;
      return;
    }
    e.preventDefault();
    const link = rows[at < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + by))].querySelector(".title a");
    link.focus();
    link.scrollIntoView({ block: "nearest" });
  });
  window.tasksKeys = true;
  const boxes = document.querySelectorAll("input[data-tasks-q]");
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
