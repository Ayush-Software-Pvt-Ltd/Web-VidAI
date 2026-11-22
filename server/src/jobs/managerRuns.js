// The runs of the job manager (docs/SPEC.md section 8): one `Run` per launched job, made when the
// launch starts. Pause and Stop may arrive before the driver's handle exists (the manager still
// resolves the video and builds the context); they are remembered and applied when it does.

/**
 * @typedef {object} Handle
 * @property {() => void} pause
 * @property {() => void} stop
 */

/**
 * @typedef {object} Run
 * @property {string} jobId
 * @property {boolean} wantPause
 * @property {boolean} wantStop
 * @property {Promise<void>} settled Resolves when the job's outcome was handled.
 * @property {(handle: Handle) => void} attach Applies a Pause or Stop asked for earlier.
 * @property {() => void} pause
 * @property {() => void} stop
 * @property {() => void} end
 */

/** The runs of one manager. */
export function createRuns() {
  /** @type {Map<string, Run>} */
  const runs = new Map();

  /**
   * @param {string} jobId
   * @returns {Run}
   */
  function begin(jobId) {
    /** @type {Handle | null} */
    let handle = null;
    /** @type {() => void} */
    let release = () => {};
    const settled = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {Run} */
    const run = {
      jobId,
      wantPause: false,
      wantStop: false,
      settled,
      attach(next) {
        handle = next;
        if (run.wantStop) next.stop();
        else if (run.wantPause) next.pause();
      },
      pause() {
        run.wantPause = true;
        handle?.pause();
      },
      stop() {
        run.wantStop = true;
        handle?.stop();
      },
      end() {
        if (runs.get(jobId) === run) runs.delete(jobId);
        release();
      },
    };
    runs.set(jobId, run);
    return run;
  }

  return {
    begin,
    /** @param {string} jobId */
    get: (jobId) => runs.get(jobId),
    all: () => [...runs.values()],
  };
}

/** @typedef {ReturnType<typeof createRuns>} Runs */

/**
 * Waits for `done`, but at most `ms` (the timer is cleared either way).
 * @param {Promise<unknown>} done
 * @param {number} ms
 * @param {{ setTimeout(fn: () => void, ms: number): unknown, clearTimeout(handle: unknown): void }} timers
 * @returns {Promise<void>}
 */
export async function bounded(done, ms, timers) {
  /** @type {unknown} */
  let handle = null;
  await Promise.race([
    done,
    new Promise((resolve) => {
      handle = timers.setTimeout(() => resolve(undefined), ms);
    }),
  ]);
  timers.clearTimeout(handle);
}
