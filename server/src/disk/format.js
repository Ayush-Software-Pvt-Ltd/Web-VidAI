// Byte sizes for the edit log line of Disk Cleanup (docs/SPEC.md section 13: "Disk Cleanup freed
// 12.3 GB"). Steps of 1024; whole numbers for B and KB, one decimal from MB up; GB is the top unit.

const UNITS = /** @type {const} */ (["B", "KB", "MB", "GB"]);

/**
 * @param {number} value
 * @param {number} unit
 */
const rounded = (value, unit) => (unit >= 2 ? Math.round(value * 10) / 10 : Math.round(value));

/**
 * @param {number} bytes
 * @returns {string} For example `0 B`, `512 B`, `3 KB`, `1.5 MB`, `12.3 GB`.
 */
export function formatBytes(bytes) {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  // A value that rounds up to the next unit's first step is shown there ("1023.97 MB" is "1.0 GB").
  while (unit < UNITS.length - 1 && rounded(value, unit) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const text = unit >= 2 ? rounded(value, unit).toFixed(1) : String(rounded(value, unit));
  return `${text} ${UNITS[unit]}`;
}
