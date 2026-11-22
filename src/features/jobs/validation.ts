/** Input checks of the job sheets. They only guide the user; the backend validates again. */

/** The non-empty lines of a text area, trimmed. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Product links as sent to the backend: one trimmed link per line, no blank lines. */
export function normalizeLinks(text: string): string {
  return lines(text).join("\n");
}

/** A link is one word with a dot in its host, with or without `http(s)://`. */
function looksLikeLink(line: string): boolean {
  if (/\s/.test(line)) return false;
  const host = line.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "";
  return /^[^.]+\.[^.]/.test(host);
}

/** Why the product links cannot be used, or `null` when they are fine (empty is fine). */
export function productLinksProblem(text: string): string | null {
  const all = text.split(/\r?\n/).map((line) => line.trim());
  const bad = all.findIndex((line) => line !== "" && !looksLikeLink(line));
  if (bad < 0) return null;
  if (all.length === 1 || lines(text).length === 1) {
    return "This does not look like a link. Put one link per line.";
  }
  return `Line ${bad + 1} does not look like a link. Put one link per line.`;
}

/** The longest Re-Edit text the server takes (SPEC section 8). */
export const MAX_CHANGES_LENGTH = 8000;

export function changesProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Describe what should change.";
  if (trimmed.length > MAX_CHANGES_LENGTH) {
    return `Keep the text under ${MAX_CHANGES_LENGTH} characters.`;
  }
  return null;
}

/** The last part of a path, for display (macOS and Windows paths). */
export { baseName as fileName } from "@/lib/paths";
