// A small helper: run an async function over a list with at most `limit` calls at a time.
// The scanner reads many folders and the service many channels; neither may open every folder
// at once on a large library.

/**
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit At least 1.
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>} The results in the order of `items`; the first failure rejects.
 */
export async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(/** @type {T} */ (items[index]), index);
    }
  });
  await Promise.all(workers);
  return results;
}
