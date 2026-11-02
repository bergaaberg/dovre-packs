/**
 * Markdown (`markdown`): a PR's Markdown files read rendered (the "pr.file" slot on the Files
 * tab). The file is read from the forge at the PR's head commit (a full SHA), through core's
 * forge reads, so only the instance's owners' repos. Links to other docs stay at that commit;
 * other files link to the forge; pictures aren't fetched.
 */
import { posix } from "node:path";
import { cleanPath, isDoc } from "./docs.ts";
import { type Resolved, slug } from "./render.ts";

/** owner/name, as GitHub has them. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

export type PrDoc = { repo: string; n: number; sha: string; path: string };

const segs = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export const prDocHref = (d: PrDoc) => `/markdown/pr/${d.repo.split("/").map(encodeURIComponent).join("/")}/${d.n}/${d.sha}/${segs(d.path)}`;

/** The PR doc a /markdown/pr/... path names, checked; null when any part is odd. */
export function prDocOf(owner: string, name: string, n: string, sha: string, path: string | null): PrDoc | null {
  const repo = `${owner}/${name}`;
  const clean = path ? cleanPath(path) : null;
  if (!REPO.test(repo) || !/^[1-9][0-9]{0,8}$/.test(n) || !SHA.test(sha) || !clean || !isDoc(clean)) return null;
  return { repo, n: Number(n), sha, path: clean };
}

/** Links in a PR's doc: another doc at the same commit, other files on the forge at it. */
export function prResolver(d: PrDoc, forgeHost: string | undefined) {
  return (href: string, kind: "link" | "image"): Resolved | undefined => {
    if (kind === "image") return undefined;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
    const [pathPart, hash = ""] = href.split("#", 2) as [string, string?];
    let path: string;
    try {
      path = decodeURIComponent(pathPart.split("?")[0]!);
    } catch {
      return { broken: true };
    }
    if (!path) return undefined;
    const rel = cleanPath(path.startsWith("/") ? path : posix.join(posix.dirname(d.path), path));
    if (!rel) return { broken: true };
    if (isDoc(rel)) return { href: prDocHref({ ...d, path: rel }) + (hash ? `#md-${slug(hash)}` : "") };
    return forgeHost && /^[a-z0-9.-]+$/i.test(forgeHost) ? { href: `https://${forgeHost}/${d.repo}/blob/${d.sha}/${segs(rel)}` } : undefined;
  };
}
