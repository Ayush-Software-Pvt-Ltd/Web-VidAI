// Text helpers of the job log and the error sentences.

/** Longest one-line summary (tool lines, last activity). */
export const LINE_CHARS = 160;
/** Longest `text` or `detail` of a stored log entry. */
export const MAX_LOG_DETAIL_CHARS = 4000;
/** The most entries `readLog` returns (the last ones). */
export const MAX_LOG_ENTRIES = 5000;

/**
 * Cuts `text` to at most `max` characters (Unicode code points, never half a character), ending
 * with "..." when it was cut.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateChars(text, max) {
  // UTF-16 length is never smaller than the number of code points: a short string is safe.
  if (text.length <= max) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 3)).join("")}...`;
}

/**
 * The first non-empty line, trimmed and shortened to one readable line.
 * @param {string} text
 * @returns {string}
 */
export function firstLine(text) {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return truncateChars(line ?? "", LINE_CHARS);
}
