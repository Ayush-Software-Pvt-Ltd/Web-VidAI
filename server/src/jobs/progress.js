// The progress of a job (docs/SPEC.md section 8 "Progress", carried over from
// docs/SPEC-desktop.md section 6 and src-tauri/src/jobs/progress.rs). Entry point; each part is in
// its own file:
// - `progressModels.js`: milestones and weights per agent job kind, stage labels.
// - `progressMarkers.js`: the `[VIDAI_PROGRESS name]` syntax, the prompt paragraph, `markerRules`.
// - `progressStream.js`: keyword inference from tool calls, tasks and sub-agents; setup words.
// - `progressEvidence.js`: the project files of the output folder (injected probe).
// - `progressPacing.js`: typical times, defaults and from the history.
// - `progressEstimate.js`: the pure estimate (percent, stage, time left).
// - `progressEngine.js`: the engine of one agent job (never backwards, 99 until done).
// - `progressView.js`: the completed view and the publishing cadence.
// - `progressTracker.js`: the driver's handle (clock, probes, history, what to persist).
// - `progressRender.js`: the progress of a `render` job from the renderer's own lines.

export {
  DONE_STAGE,
  FINISHING_STAGE,
  MAX_RUNNING_PERCENT,
  MILESTONES,
  MILESTONE_NAMES,
  MODELS,
  SETUP_STAGE,
  isAgentKind,
  milestoneOf,
  modelOf,
} from "./progressModels.js";
export {
  MARKER_TAG,
  markerInstructions,
  markerLines,
  markerLogLine,
  markerRules,
  splitMarkers,
} from "./progressMarkers.js";
export { createDiskProbe, emptyProbe, outputEvidence } from "./progressEvidence.js";
export {
  HISTORY_RUNS,
  MIN_HISTORY_RUNS,
  defaultPacing,
  median,
  pacingFromHistory,
} from "./progressPacing.js";
export { estimate } from "./progressEstimate.js";
export { createProgress, parseMemory } from "./progressEngine.js";
export {
  OUTPUT_PROBE_EVERY,
  PERSIST_EVERY,
  PUBLISH_INTERVAL_MS,
  completedProgress,
  createPublisher,
  sameProgress,
} from "./progressView.js";
export { createTracker } from "./progressTracker.js";
export {
  RENDER_STAGES,
  RENDER_START_STAGE,
  createRenderProgress,
  parseRenderLine,
  renderProgress,
  renderView,
} from "./progressRender.js";

/** @typedef {import("./progressModels.js").AgentKind} AgentKind */
/** @typedef {import("./progressModels.js").JobKind} JobKind */
/** @typedef {import("./progressModels.js").VideoType} VideoType */
/** @typedef {import("./progressModels.js").MilestoneName} MilestoneName */
/** @typedef {import("./progressPacing.js").Pacing} Pacing */
/** @typedef {import("./progressPacing.js").HistoryRow} HistoryRow */
/** @typedef {import("./progressPacing.js").ProgressHistory} ProgressHistory */
/** @typedef {import("./progressEngine.js").ProgressMemory} ProgressMemory */
/** @typedef {import("./progressEngine.js").OutputEvidence} OutputEvidence */
/** @typedef {import("./progressEvidence.js").OutputProbe} OutputProbe */
/** @typedef {import("./progressTracker.js").ProgressUpdate} ProgressUpdate */
/** @typedef {import("../../../src/lib/wire/progress.ts").JobProgress} JobProgress */
