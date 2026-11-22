// Typical times (docs/SPEC.md section 8, "Progress", Pacing): the active time at which each
// milestone is typically finished, from the defaults measured on real edits or from the last
// completed jobs of the same kind and video type on this server.
//
// A history row has the total only (`progress_history`: kind, type, seconds, finished_at), so there are
// no per-milestone medians: once at least `MIN_HISTORY_RUNS` rows have a
// total, the median total replaces the default and every default milestone time is scaled by it.

import { modelOf } from "./progressModels.js";

/** How many of the newest completed jobs of a kind and type the estimate looks at. */
export const HISTORY_RUNS = 10;
/** A typical time is learned from history once this many completed jobs have it. */
export const MIN_HISTORY_RUNS = 3;

/**
 * Typical active milliseconds from the start of a job to the end of each step of its model, and of
 * the whole job.
 * @typedef {object} Pacing
 * @property {number[]} atMs Same order as the model's steps.
 * @property {number} totalMs
 */

/**
 * One completed job, as the history keeps it.
 * @typedef {object} HistoryRow
 * @property {import("./progressModels.js").JobKind} kind
 * @property {import("./progressModels.js").VideoType} videoType
 * @property {number} seconds Active running time of the job.
 * @property {number} finishedAt Epoch ms.
 */

/**
 * What the engine and the tracker need of the history table (`db/progressHistory.js`).
 * @typedef {object} ProgressHistory
 * @property {(kind: string, videoType: string, limit: number) => HistoryRow[]} recent The newest
 *   rows of the kind and type, newest first.
 * @property {(row: HistoryRow) => void} add
 */

/**
 * @param {number} min
 * @returns {number}
 */
function minutes(min) {
  return Math.round(min * 60_000);
}

/**
 * @param {number[]} values Not empty.
 * @returns {number}
 */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The defaults measured on real edits (see `progressModels.js`).
 * @param {import("./progressModels.js").AgentKind} kind
 * @param {import("./progressModels.js").VideoType} videoType
 * @returns {Pacing}
 */
export function defaultPacing(kind, videoType) {
  const model = modelOf(kind);
  const pick = (/** @type {readonly [number, number]} */ [short, long]) =>
    minutes(videoType === "short" ? short : long);
  return { atMs: model.steps.map((s) => pick(s.typicalMin)), totalMs: pick(model.totalMin) };
}

/**
 * Learned from completed jobs of the same kind and video type: once at least `MIN_HISTORY_RUNS`
 * rows have a total, the median total replaces the default and every default milestone time is
 * scaled by it. Rows beyond the newest `HISTORY_RUNS` are ignored.
 * @param {import("./progressModels.js").AgentKind} kind
 * @param {import("./progressModels.js").VideoType} videoType
 * @param {readonly HistoryRow[]} rows Newest first.
 * @returns {Pacing}
 */
export function pacingFromHistory(kind, videoType, rows) {
  const defaults = defaultPacing(kind, videoType);
  const totals = rows
    .slice(0, HISTORY_RUNS)
    .map((r) => Math.round(r.seconds * 1000))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (totals.length < MIN_HISTORY_RUNS) return defaults;
  const totalMs = median(totals);
  const scale = totalMs / Math.max(defaults.totalMs, 1);
  return { atMs: defaults.atMs.map((at) => Math.round(at * scale)), totalMs };
}
