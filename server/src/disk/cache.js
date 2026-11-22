// The cache of measured sizes (docs/SPEC.md section 13: "cached per folder time"). Keyed by the
// video folder's real path, so a renamed channel or a moved link does not mix numbers up. Each
// entry holds the fingerprint ("folder time", see `measure.js`) it was measured under.
//
// An entry is trusted without a look at the disk for `verifyAfterMs` after the last check; after
// that the background worker compares fingerprints (cheap) and measures again (expensive) only
// when it differs, or when the measurement is older than `maxAgeMs` (changes deep in the tree do
// not change the fingerprint).

/** @typedef {import("../../../src/lib/wire/disk.ts").DiskSizes} DiskSizes */

/**
 * @typedef {object} CacheEntry
 * @property {string} fingerprint
 * @property {DiskSizes} sizes
 * @property {number} measuredAt When the sizes were measured.
 * @property {number} checkedAt When the fingerprint was last found unchanged (or measured).
 */

/**
 * @param {{ limit?: number }} [options] The most entries kept; the least recently used go first.
 */
export function createSizeCache({ limit = 20_000 } = {}) {
  /** @type {Map<string, CacheEntry>} */
  const entries = new Map();
  return {
    /** @param {string} dir @returns {CacheEntry | undefined} */
    get: (dir) => entries.get(dir),

    /** @param {string} dir @param {CacheEntry} entry */
    set(dir, entry) {
      entries.delete(dir);
      entries.set(dir, entry);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },

    /** @param {string} dir */
    delete: (dir) => void entries.delete(dir),

    /** Makes the entry be verified at the next look. @param {string} dir */
    stale(dir) {
      const entry = entries.get(dir);
      if (entry) entry.checkedAt = Number.NEGATIVE_INFINITY;
    },

    get size() {
      return entries.size;
    },
  };
}
