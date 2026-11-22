// The driver's handle on the progress of the agent job it runs (docs/SPEC-desktop.md section 6
// "Progress", the `Tracker` of progress.rs): the clock, the output folder and the working folder,
// the restored engine of a continued job, what is published and when it is persisted.
//
// Everything outside is injected: the clock, the history table, the probe of the project files and
// the scan of the working folder. The job manager stores what `poll` returns (`jobs.progress`,
// `videos.progress_memory`) and calls `recordCompletion` when the job completed.

import { createProgress, parseMemory } from "./progressEngine.js";
import { outputEvidence } from "./progressEvidence.js";
import { HISTORY_RUNS, pacingFromHistory } from "./progressPacing.js";
import { OUTPUT_PROBE_EVERY, PUBLISH_INTERVAL_MS, createPublisher } from "./progressView.js";

/** @typedef {import("../../../src/lib/wire/progress.ts").JobProgress} JobProgress */
/** @typedef {import("./progressEngine.js").ProgressMemory} ProgressMemory */
/** @typedef {import("./progressEvidence.js").OutputProbe} OutputProbe */

/**
 * A progress change to publish.
 * @typedef {object} ProgressUpdate
 * @property {JobProgress} view
 * @property {ProgressMemory} memory What to store in `videos.progress_memory`.
 * @property {boolean} persist Write the job and its memory now; otherwise the change is kept in
 *   memory until the next save.
 */

/**
 * Starts tracking a job that just entered `running`: a new job starts from 0, a continued one from
 * its persisted memory and percent.
 * @param {object} options
 * @param {import("./progressModels.js").AgentKind} options.kind
 * @param {import("./progressModels.js").VideoType} options.videoType
 * @param {string} options.jobId
 * @param {{ now(): number }} options.clock
 * @param {import("./progressPacing.js").ProgressHistory} options.history
 * @param {number} [options.activeBeforeMs] The job's active time before this run.
 * @param {number | null} [options.since] When the job first started (epoch ms); without it the
 *   files of the video are not looked at.
 * @param {unknown} [options.memory] The stored `progressMemory` of the video (any JSON; another
 *   job's memory is ignored).
 * @param {JobProgress | null} [options.progress] What the job already shows.
 * @param {(() => OutputProbe) | null} [options.probeOutput] Looks at the project files (see
 *   `createDiskProbe`).
 * @param {(() => import("./workFiles.js").WorkEvidence) | null} [options.scanWork] What the working
 *   folder shows since the job started (`evidence(scan(dir), since)` of `work.js`).
 * @param {number} [options.intervalMs] The publish interval; the output folder is looked at every
 *   five of them.
 */
export function createTracker({
  kind,
  videoType,
  jobId,
  clock,
  history,
  activeBeforeMs = 0,
  since = null,
  memory = null,
  progress = null,
  probeOutput = null,
  scanWork = null,
  intervalMs = PUBLISH_INTERVAL_MS,
}) {
  const stored = parseMemory(memory);
  const engine = createProgress({
    kind,
    pacing: pacingFromHistory(kind, videoType, history.recent(kind, videoType, HISTORY_RUNS)),
    memory: stored !== null && stored.jobId === jobId ? stored : null,
    shown: progress === null ? null : progress.percent,
  });
  const runStarted = clock.now();
  /** The project files as they were when this run started. */
  const known = probeOutput === null ? null : probeOutput();
  const publisher = createPublisher({ clock, intervalMs, published: progress });
  /** The most files the video folder held that were written since the job started. */
  let workFiles = 0;
  /** @type {number | null} */
  let lastProbe = null;

  const activeMs = () => activeBeforeMs + Math.max(clock.now() - runStarted, 0);

  return {
    /** @param {import("../agents/claude/protocol.js").StreamEvent} event */
    observe(event) {
      engine.observe(event, activeMs());
    },

    /**
     * How much the job has shown of its work so far, for the stuck-model rule of `keepgoing.js`:
     * the finished milestones plus the files written in the video folder. It only grows, so a
     * model that keeps working without a milestone (a long render on a slow computer) is not
     * taken for stuck, while one that does nothing is.
     * @returns {number}
     */
    workShown: () => engine.finished() + workFiles,

    /** @param {string} name @returns {boolean} Whether the milestone is finished. */
    isDone: (name) => engine.isDone(name),

    /**
     * Looks at the output folder now instead of at the next probe, so a decision made right after
     * a turn ended sees the files that turn wrote.
     */
    probeNow() {
      lastProbe = null;
    },

    /**
     * The change to publish now, if any: at most every `intervalMs` (a new stage at once, or
     * anything when `force`), persisted on a new stage or every ten intervals.
     * @param {boolean} [force]
     * @returns {ProgressUpdate | null}
     */
    poll(force = false) {
      const now = activeMs();
      const wall = clock.now();
      if (
        since !== null &&
        (lastProbe === null || wall - lastProbe >= intervalMs * OUTPUT_PROBE_EVERY)
      ) {
        lastProbe = wall;
        if (probeOutput !== null) {
          engine.observeOutput(outputEvidence(probeOutput(), { kind, since, known }), now);
        }
        if (scanWork !== null) {
          const seen = scanWork();
          workFiles = Math.max(workFiles, seen.files);
          if (kind === "edit") engine.observeWork(seen, now);
        }
      }
      const view = engine.current(now);
      const decision = publisher.consider(view, force);
      if (!decision.publish) return null;
      return { view, memory: engine.memory(jobId), persist: decision.persist };
    },

    /**
     * Records how long the job took, for the typical times of the next ones. Call it once, when
     * the job completed.
     */
    recordCompletion() {
      history.add({ kind, videoType, seconds: activeMs() / 1000, finishedAt: clock.now() });
    },

    /**
     * The milestones that were seen (not implied) with the active time they finished at.
     * @returns {Record<string, number>}
     */
    seen: () => engine.seen(),
  };
}
