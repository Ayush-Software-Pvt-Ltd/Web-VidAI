/** Cleanups registered by test helpers, run after each test by `setup.ts`. */
const cleanups = new Set<() => void>();

/** Runs `cleanup` after the current test (unless it was removed with the returned function). */
export function onTestCleanup(cleanup: () => void): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

export function runTestCleanups(): void {
  const pending = [...cleanups];
  cleanups.clear();
  for (const cleanup of pending) cleanup();
}
