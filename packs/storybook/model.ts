/**
 * What the Storybook pack works out without the network: which repos have a published Storybook and
 * where (STORYBOOK), which stories a PR's files touch, and each story's id as Storybook makes it.
 * The Storybook sits behind a sign-in, so its index.json can't be read from the server: ids come
 * from the stories files themselves (CSF: the meta's `title`, or one made from the path, and the
 * named exports).
 */

/**
 * Where one repo's Storybook is: `head` for a PR, `base` for the branch it targets, each a published
 * URL template, or undefined when Dovre builds that side here (#166).
 */
export type Book = { repo: string; head?: string; base?: string };

/** What a template's placeholders become. */
export type Vars = { pr: number; branch: string; base: string; sha: string };

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const PLACE = /\{(pr|branch|base|sha)\}/g;

/**
 * STORYBOOK: entries split by `;` or new lines, each `owner/repo`, then the URLs it's published
 * at: `<PR url> <base url>`, only `<base url>` (the PR built here), or none (both built here). The
 * URLs are https, with {pr}, {branch}, {base} or {sha} in their path (never the host). An entry
 * that isn't that is left out.
 */
export function booksOf(raw: string | undefined): Book[] {
  const out: Book[] = [];
  for (const entry of String(raw ?? "").split(/[;\n]/)) {
    const [repo, ...urls] = entry.trim().split(/\s+/);
    if (!repo || urls.length > 2 || !REPO.test(repo) || urls.some((u) => !originOf(u))) continue;
    if (out.some((b) => b.repo.toLowerCase() === repo.toLowerCase())) continue;
    const [head, base] = urls.length === 2 ? urls : [undefined, urls[0]];
    out.push({ repo, ...(head ? { head } : {}), ...(base ? { base } : {}) });
  }
  return out;
}

export const bookOf = (books: Book[], repo: string) => books.find((b) => b.repo.toLowerCase() === repo.toLowerCase());

/** A template's site: an https origin with no placeholder in it, or undefined. */
export function originOf(template: string): string | undefined {
  const m = /^https:\/\/([a-z0-9.-]+(?::\d+)?)(\/[^\s]*)?$/i.exec(template);
  if (!m) return undefined;
  try {
    return new URL(`https://${m[1]}`).origin;
  } catch {
    return undefined;
  }
}

/** A branch name in a path: each part encoded, the slashes kept (CI publishes feat/x under feat/x/). */
const pathPart = (s: string) => s.split("/").map(encodeURIComponent).join("/");

/** A template filled in, ending in a slash so pages are found under it. */
export function urlOf(template: string, v: Vars): string {
  const filled = template.replace(PLACE, (_, k: keyof Vars) => (k === "pr" ? String(v.pr) : k === "sha" ? encodeURIComponent(v.sha) : pathPart(v[k])));
  return filled.endsWith("/") ? filled : `${filled}/`;
}

export const STORIES = /\.stories\.(tsx|ts|jsx|js|mjs)$/;
/** Changed files whose folder's stories may show the change. */
const SOURCE = /\.(tsx|ts|jsx|js|mjs|vue|svelte|css|scss|sass|less)$/;
const NOT_SOURCE = /(\.(test|spec|d)\.[a-z]+$)|(^|\/)(__tests__|__mocks__|test|tests)\//;

/** A file the PR changed, as the forge lists it. */
export type Changed = { path: string; status: string };

/** The stories files a PR changed, and the folders of the other source files it changed (where to look for their stories). */
export function touched(files: Changed[]): { stories: Changed[]; dirs: string[] } {
  const stories = files.filter((f) => STORIES.test(f.path));
  const dirs = new Set<string>();
  for (const f of files) {
    if (STORIES.test(f.path) || !SOURCE.test(f.path) || NOT_SOURCE.test(f.path) || f.status === "removed") continue;
    dirs.add(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "");
  }
  return { stories, dirs: [...dirs] };
}

/** Storybook's sanitize: lowercase, anything but letters and digits a dash, no dashes at the ends. */
export function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** An export's story name (Storybook's storyNameFromExport, lodash startCase): "PrimaryLarge" → "Primary Large". */
export function storyName(key: string): string {
  // Capitals before a capitalised word are a word of their own: "EFaktura" → "E Faktura", "AnsattIJbf" → "Ansatt I Jbf".
  const words = key.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [key];
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/** A title Storybook would make from the path: no `src/`, no `.stories.tsx`, `Button/Button` once. */
export function autoTitle(path: string): string {
  const parts = path.replace(/^src\//, "").replace(STORIES, "").split("/");
  const last = parts[parts.length - 1];
  if (parts.length > 1 && (last === "index" || last?.toLowerCase() === parts[parts.length - 2]?.toLowerCase())) parts.pop();
  return parts.join("/");
}

/**
 * The `title` at the top level of the object literal opening at `open` (the meta), not one nested in
 * it (an arg's). Strings and template literals are skipped (comments are gone already); at most
 * 50 000 characters are read.
 */
export function topTitle(code: string, open: number): string | undefined {
  let depth = 0;
  const end = Math.min(code.length, open + 50_000);
  for (let i = open; i < end; i++) {
    const ch = code[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < end && code[j] !== ch) j += code[j] === "\\" ? 2 : 1;
      if (j >= end) return undefined;
      i = j;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (--depth === 0) return undefined;
    } else if (depth === 1 && /[\s,{]/.test(code[i - 1] ?? "") && code.startsWith("title", i)) {
      const m = /^title\s*:\s*(['"`])([^'"`\n]{1,200})\1/.exec(code.slice(i, i + 220));
      if (m) return m[2];
    }
  }
  return undefined;
}

/** A stories file read (CSF): its title, and its stories' export names. */
export function parseStories(path: string, src: string): { title: string; exports: string[] } {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  let title: string | undefined;
  // The meta: `export default { … }`, or `export default meta` with `const meta = { … }`.
  const def = /export\s+default\s+(\{|([A-Za-z_$][\w$]*))/.exec(code);
  if (def) {
    const from = def[1] === "{" ? def.index : code.search(new RegExp(`(const|let|var)\\s+${def[2]}\\b`));
    const open = from >= 0 ? code.indexOf("{", from) : -1;
    if (open >= 0) title = topTitle(code, open);
  }
  const names = new Set<string>();
  for (const m of code.matchAll(/export\s+(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g))
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  names.delete("default");
  names.delete("__namedExportsOrder");
  return { title: title ?? autoTitle(path), exports: [...names].slice(0, 50) };
}

/** A story's id: `components-button--primary-large`. */
export const storyId = (title: string, exportName: string) => `${sanitize(title)}--${sanitize(storyName(exportName))}`;

/** Where a story is drawn alone (the iframe), and where it's opened in Storybook's own page. */
export const frameUrl = (root: string, id: string) => `${root}iframe.html?id=${encodeURIComponent(id)}&viewMode=story`;
export const openUrl = (root: string, id: string) => `${root}?path=/story/${encodeURIComponent(id)}`;
