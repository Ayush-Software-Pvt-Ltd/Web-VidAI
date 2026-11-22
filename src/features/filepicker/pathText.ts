/**
 * Path and name rules of the picker's dialog. Display and typing only: the server decides what a
 * path means, so a path that comes back from it is used exactly as it came (see `@/lib/paths`).
 * The server may run on a PC, so both kinds of path are understood from the path itself.
 */

export interface Crumb {
  name: string;
  path: string;
}

const DRIVE = /^[A-Za-z]:/;

/** The folders from the top of the volume down to `path`, each with the path that opens it. */
export function crumbsOf(path: string): Crumb[] {
  const crumbs: Crumb[] = [];
  if (DRIVE.test(path) || path.startsWith("\\\\")) {
    let rest: string[];
    let root: string;
    if (path.startsWith("\\\\")) {
      // A network path: `\\server\share` is the top.
      const parts = path
        .slice(2)
        .split("\\")
        .filter((part) => part !== "");
      root = `\\\\${parts.slice(0, 2).join("\\")}`;
      rest = parts.slice(2);
      crumbs.push({ name: root, path: `${root}\\` });
    } else {
      root = path.slice(0, 2);
      rest = path
        .slice(2)
        .split(/[\\/]/)
        .filter((part) => part !== "");
      crumbs.push({ name: root, path: `${root}\\` });
    }
    let current = root;
    for (const part of rest) {
      current = `${current}\\${part}`;
      crumbs.push({ name: part, path: current });
    }
    return crumbs;
  }
  crumbs.push({ name: "/", path: "/" });
  let current = "";
  for (const part of path.split("/").filter((p) => p !== "")) {
    current = `${current}/${part}`;
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

const isPcPath = (path: string) => DRIVE.test(path) || path.startsWith("\\\\");

/** Whether two paths of the server are the same folder (a PC ignores case and a closing `\`). */
export function samePath(a: string, b: string): boolean {
  const clean = (path: string) => {
    let end = path.length;
    while (end > 1 && /[\\/]/.test(path[end - 1] ?? "")) end -= 1;
    const text = path.slice(0, end);
    return isPcPath(path) ? text.replaceAll("/", "\\").toLowerCase() : text;
  };
  return clean(a) === clean(b);
}

/** Whether `path` is `root` or lies inside it. */
export function isInsidePath(root: string, path: string): boolean {
  return crumbsOf(path).some((crumb) => samePath(crumb.path, root));
}

/**
 * The breadcrumbs of `path` when the folders above `root` are out of reach: `root` (shown under
 * its own name) is the first one. Without a root, or when `path` is not inside it, all of them.
 */
export function crumbsBelow(path: string, root: Crumb | null): Crumb[] {
  const all = crumbsOf(path);
  if (root === null) return all;
  const at = all.findIndex((crumb) => samePath(crumb.path, root.path));
  return at < 0 ? all : [{ name: root.name, path: root.path }, ...all.slice(at + 1)];
}

/** The folder above `path`, `null` at the top. */
export function parentOf(path: string): string | null {
  return crumbsOf(path).at(-2)?.path ?? null;
}

/** Whether `text` is a full path (the server asks for one; anything else would be refused). */
export function isAbsolutePath(text: string): boolean {
  return text.startsWith("/") || /^([A-Za-z]:[\\/]|\\\\[^\\])/.test(text);
}

/** What a person typed or pasted as a path: quotes and a trailing separator are dealt with. */
export function normalizeTypedPath(text: string): string {
  let path = text.trim();
  const quoted = /^(["'])(.*)\1$/.exec(path);
  if (quoted) path = (quoted[2] ?? "").trim();
  const pc = isPcPath(path);
  if (pc) {
    path = path.startsWith("\\\\")
      ? `\\\\${path.slice(2).replaceAll("/", "\\")}`
      : path.replaceAll("/", "\\");
  }
  const keep = pc ? 3 : 1;
  while (path.length > keep && /[\\/]$/.test(path)) path = path.slice(0, -1);
  return path;
}

/** The name of the last part of `path`, or the whole path for a top (`/`, `C:\`). */
export function leafName(path: string): string {
  const crumbs = crumbsOf(path);
  const last = crumbs.at(-1);
  if (!last) return path;
  return crumbs.length === 1 ? last.path : last.name;
}
