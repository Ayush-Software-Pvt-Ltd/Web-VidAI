// The job log (docs/SPEC.md section 8, "The job log"): one entry per line of what the agent did, kept in
// `<data dir>/logs/<jobId>.jsonl` and sent to the browser in batches.
//
// The parts, each in its own file:
// - `logText.js`: limits and cutting text.
// - `logPaths.js`: shortening absolute paths.
// - `logScrub.js`: keeping registered secrets (API keys) out of every entry.
// - `logDescribe.js`: stream events to entries (the Describer).
// - `logStore.js`: the JSONL file, with the `LogEntry` type.
// - `logSink.js`: seq numbers, scrubbing, batching and delivery.

export {
  LINE_CHARS,
  MAX_LOG_DETAIL_CHARS,
  MAX_LOG_ENTRIES,
  firstLine,
  truncateChars,
} from "./logText.js";
export { createPaths, noPaths } from "./logPaths.js";
export { API_KEY_LABEL, createScrubber } from "./logScrub.js";
export {
  createDescriber,
  draft,
  errorDraft,
  statusDraft,
  toolDetail,
  toolLine,
} from "./logDescribe.js";
export { createLogStore } from "./logStore.js";
export { LOG_INTERVAL_MS, createLogSink, realTimers } from "./logSink.js";

/** @typedef {import("./logDescribe.js").Describer} Describer */
/** @typedef {import("./logDescribe.js").Described} Described */
/** @typedef {import("./logDescribe.js").Draft} Draft */
/** @typedef {import("./logDescribe.js").LogKind} LogKind */
/** @typedef {import("./logDescribe.js").MarkerRules} MarkerRules */
/** @typedef {import("./logPaths.js").Paths} Paths */
/** @typedef {import("./logScrub.js").Scrubber} Scrubber */
/** @typedef {import("./logSink.js").LogSink} LogSink */
/** @typedef {import("./logSink.js").Timers} Timers */
/** @typedef {import("./logStore.js").LogEntry} LogEntry */
/** @typedef {import("./logStore.js").LogStore} LogStore */
/** @typedef {import("./logStore.js").JobLogBatch} JobLogBatch */
