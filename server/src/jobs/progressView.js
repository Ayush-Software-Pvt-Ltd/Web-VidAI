// The published view of a job's progress (docs/SPEC.md section 8, "Progress", Rules): what
// the UI shows when a job completes, and the cadence of publishing: `job-updated` when the percent
// or the stage changes, at most about once a second per job (a new stage at once); the state is
// written on a new stage and otherwise at most every 10 seconds.

import { DONE_STAGE } from "./progressModels.js";

/** @typedef {import("../../../src/lib/wire/progress.ts").JobProgress} JobProgress */

/** The publish interval of the app: at most one change per job per second. */
export const PUBLISH_INTERVAL_MS = 1000;
/** A creep-only change is persisted at most every this many publish intervals. */
export const PERSIST_EVERY = 10;
/** The output folder is looked at every this many publish intervals. */
export const OUTPUT_PROBE_EVERY = 5;

/**
 * The progress of a completed job: exactly 100, "Done".
 * @returns {JobProgress}
 */
export function completedProgress() {
  return { percent: 100, stage: DONE_STAGE, secondsLeft: null };
}

/**
 * @param {JobProgress | null} a
 * @param {JobProgress | null} b
 * @returns {boolean}
 */
export function sameProgress(a, b) {
  if (a === null || b === null) return a === b;
  return a.percent === b.percent && a.stage === b.stage && a.secondsLeft === b.secondsLeft;
}

/**
 * Decides when a change is published and persisted.
 * @param {object} options
 * @param {{ now(): number }} options.clock
 * @param {number} [options.intervalMs]
 * @param {number} [options.persistEvery]
 * @param {JobProgress | null} [options.published] What the job already shows (a continued job
 *   shows its last progress while it waits in the queue).
 */
export function createPublisher({
  clock,
  intervalMs = PUBLISH_INTERVAL_MS,
  persistEvery = PERSIST_EVERY,
  published = null,
}) {
  /** @type {JobProgress | null} */
  let last = published;
  /** @type {number | null} */
  let lastPublish = null;
  let lastPersist = clock.now();
  return {
    /**
     * Whether `view` is to be published now, and whether to write the state with it. Nothing
     * changed says no (also when `force`); a change less than `intervalMs` after the last
     * publication without a new stage says no unless `force`.
     * @param {JobProgress} view
     * @param {boolean} [force]
     * @returns {{ publish: boolean, persist: boolean }}
     */
    consider(view, force = false) {
      const no = { publish: false, persist: false };
      if (sameProgress(last, view)) return no;
      const now = clock.now();
      const newStage = last === null || last.stage !== view.stage;
      if (!force && !newStage && lastPublish !== null && now - lastPublish < intervalMs) return no;
      const persist = force || newStage || now - lastPersist >= intervalMs * persistEvery;
      last = view;
      lastPublish = now;
      if (persist) lastPersist = now;
      return { publish: true, persist };
    },
  };
}
