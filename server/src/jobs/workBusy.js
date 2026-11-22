// "Busy workers" (docs/SPEC-desktop.md section 6, "Waiting for its own commands"): a model that
// starts a long command in the background of a shell (a local transcription, a render) ends its
// turn to wait, and the agent does not track such a process as a task. The server reads the CPU
// time of the job's process tree every few seconds, the model host itself left out: when some
// process used at least a tenth of a core since the last look, the computer is busy with the
// model's commands for the next 90 seconds.
//
// At an idle moment of a job that is busy this way, with no deliverable and no marker, the model
// is not stuck (`workersBusy` of `keepgoing.js`). A process that is not busy (a download that
// stalled, a gate waiting for memory) leaves the ordinary rules in force, so a hang is still
// found.
//
// Pure apart from the injected `sample`. Where the CPU time cannot be read (`supported: false`,
// Windows for now) nothing is ever busy.

/** @typedef {{ now(): number }} Clock */

/**
 * CPU seconds used so far, as `treeCpuSeconds` (one total) or `cpuByPid` (one number per pid)
 * of `platform/process.js` returns them, possibly after waiting.
 * @typedef {number | ReadonlyMap<number, number>} CpuSample
 */

/**
 * A process of the job's tree must use at least this share of a core between two refreshes to
 * count as busy; a download or an idle server does not.
 */
export const BUSY_CPU_SHARE = 0.1;
/**
 * Busy stays true this long after the last time something was, so a command that works in bursts
 * is not taken for finished.
 */
export const BUSY_HOLD_MS = 90_000;
/** The model that waits for its busy commands is reminded at most this often. */
export const WAIT_MESSAGE_EVERY_MS = 300_000;
/** How often the driver should refresh the tree (`tree_refresh` of the Rust `Timings`). */
export const REFRESH_MS = 5000;

/**
 * @typedef {object} IdleGate
 * @property {boolean} workersBusy What `Evidence.workersBusy` of `keepgoing.js` is right now.
 * @property {boolean} skip Reminded a moment ago: the commands are busy, so the model is waiting
 *   for them and this idle moment needs no decision. Never true when a deliverable exists.
 */

/**
 * @typedef {object} WorkerWatch
 * @property {(pids: readonly number[]) => Promise<void>} refresh Looks at the CPU time of the
 *   processes of the job's tree. `pids` are the members of the tree WITHOUT the model host
 *   itself (its own CPU is the model's thinking, not its commands).
 * @property {() => boolean} busy The computer is busy with the model's commands right now.
 * @property {(hasDeliverable: boolean) => IdleGate} idle What an idle moment of the model needs
 *   to know: the evidence and whether to leave it alone.
 * @property {() => void} noteWaitMessage The model was just asked to wait for its commands.
 */

/**
 * @param {object} options
 * @param {Clock} options.clock
 * @param {(pids: readonly number[]) => CpuSample | Promise<CpuSample>} options.sample CPU
 *   seconds of the pids so far (`treeCpuSeconds` or `cpuByPid` of `platform/process.js`). With
 *   a total, growth is the difference to the previous total (a process that ended lowers it,
 *   which never counts as growth); with one number per pid only the pids seen in both samples
 *   count, as the Rust did.
 * @param {boolean} options.supported Whether CPU time can be read on this system at all.
 * @param {number} [options.cpuShare] Default `BUSY_CPU_SHARE`.
 * @param {number} [options.holdMs] Default `BUSY_HOLD_MS`.
 * @param {number} [options.waitMessageEveryMs] Default `WAIT_MESSAGE_EVERY_MS`.
 * @returns {WorkerWatch}
 */
export function createWorkerWatch({
  clock,
  sample,
  supported,
  cpuShare = BUSY_CPU_SHARE,
  holdMs = BUSY_HOLD_MS,
  waitMessageEveryMs = WAIT_MESSAGE_EVERY_MS,
}) {
  /** @type {CpuSample | null} */
  let before = null;
  let beforeAt = clock.now();
  /** @type {number | null} */
  let busyUntil = null;
  /** @type {number | null} */
  let lastWaitMessage = null;

  const busy = () => busyUntil !== null && busyUntil > clock.now();

  return {
    busy,
    async refresh(pids) {
      if (!supported) return;
      const current = await sample(pids);
      const now = clock.now();
      const wallMs = now - beforeAt;
      const grew = cpuGrowth(before, current);
      // Less than a second between two looks says nothing; the first look only sets the base.
      if (before !== null && wallMs >= 1000 && grew >= (wallMs / 1000) * cpuShare) {
        busyUntil = now + holdMs;
      }
      before = current;
      beforeAt = now;
    },
    idle(hasDeliverable) {
      const workersBusy = busy();
      const reminded =
        lastWaitMessage !== null && clock.now() - lastWaitMessage < waitMessageEveryMs;
      return { workersBusy, skip: workersBusy && reminded && !hasDeliverable };
    },
    noteWaitMessage() {
      lastWaitMessage = clock.now();
    },
  };
}

/**
 * CPU seconds used between two samples.
 * @param {CpuSample | null} before
 * @param {CpuSample} current
 * @returns {number}
 */
function cpuGrowth(before, current) {
  if (before === null) return 0;
  if (typeof current === "number") {
    return typeof before === "number" ? Math.max(0, current - before) : 0;
  }
  if (typeof before === "number") return 0;
  let grew = 0;
  for (const [pid, seconds] of current) {
    const was = before.get(pid);
    if (was !== undefined) grew += Math.max(0, seconds - was);
  }
  return grew;
}
