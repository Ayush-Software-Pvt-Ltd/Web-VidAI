/**
 * Display helpers for paths that come from the backend. A path written with backslashes only
 * (`C:\Users\...`) is a Windows path; anything else uses `/` (macOS). Paths are never built here
 * for the backend to use: it gets back exactly the paths it sent.
 */

/** The separator a path uses. */
export function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Joins a folder path with a child name, keeping the separator style of the parent. */
export function joinPath(parent: string, child: string): string {
  const separator = separatorOf(parent);
  return parent.endsWith(separator) ? `${parent}${child}` : `${parent}${separator}${child}`;
}

/** The last part of a path (a trailing separator ignored). */
export function baseName(path: string): string {
  const separator = separatorOf(path);
  let end = path.length;
  while (end > 1 && path[end - 1] === separator) end -= 1;
  const trimmed = path.slice(0, end);
  return trimmed.slice(trimmed.lastIndexOf(separator) + 1) || trimmed;
}

/**
 * A path cut into the parts a line may break between: each part is one name with the separator
 * that follows it, so a wrapped path ends a line only after a separator and the next line starts
 * with a name (never with a separator, never in the middle of a name). A root (`/`, the `\\` of a
 * network path) stays with the name after it. Joined, the parts are the path again.
 */
export function pathSegments(path: string): string[] {
  const separator = separatorOf(path);
  const parts: string[] = [];
  let current = "";
  for (const char of path) {
    current += char;
    // A part ends after a separator that follows a name; a root of separators only goes on.
    if (char === separator && current.replaceAll(separator, "") !== "") {
      parts.push(current);
      current = "";
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

/** The second to last part of a path: the folder that holds `path`. */
export function parentName(path: string): string | undefined {
  const parts = path.split(separatorOf(path)).filter((part) => part !== "");
  return parts.at(-2);
}
