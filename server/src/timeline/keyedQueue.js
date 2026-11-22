// One operation at a time per key (docs/SPEC.md section 11, Hand edits: "one operation at a time per
// video"). Operations of one key run in the order they were asked; different keys run side by side.
// A failing operation never blocks the ones behind it.

/** Creates a fresh queue (no global state). */
export function createKeyedQueue() {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  return {
    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T> | T} operation
     * @returns {Promise<T>}
     */
    run(key, operation) {
      const before = tails.get(key) ?? Promise.resolve();
      const result = before.then(operation);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, settled);
      void settled.then(() => {
        if (tails.get(key) === settled) tails.delete(key);
      });
      return result;
    },
  };
}
