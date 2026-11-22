// The estimate (docs/SPEC.md section 8, "Progress", Pacing = evidence 5): where on its
// typical timeline a job is, from what the evidence confirmed and the active time since, as a
// percent, a stage label and the time left. Pure: the engine (`progressEngine.js`) owns the state
// and calls `estimate` with it.

import {
  FINISHING_STAGE,
  MAX_RUNNING_PERCENT,
  SETUP_STAGE,
  milestoneOf,
} from "./progressModels.js";

/**
 * Shortest stretch the estimate is paced with, so tiny or inconsistent typical times never make
 * the bar jump.
 */
const MIN_STRETCH_MS = 20_000;
/**
 * The pace of a job (its time so far against the typical time) is clamped to this range; a slow
 * computer is several times slower than the measured defaults.
 */
const PACE_MIN = 0.5;
const PACE_MAX = 6;
/**
 * Once the job is later than the typical end of the stage it is in, the estimate goes on with a
 * logarithmic slow-down whose scale is this share of the typical total time, at first at
 * `SPILL_RATE` of the typical speed (it is a guess now, not evidence).
 */
const SLOWDOWN_SHARE = 0.1;
const SPILL_RATE = 0.3;
/** The bar may be this many points past the value of the stage the label names. */
const LABEL_SLACK = 2;
/** Milestones typically reached this early say little about the pace of the job. */
const MIN_PACE_EVIDENCE_MS = 120_000;
/** The time left is rounded to this many seconds, so the number does not flicker. */
const SECONDS_LEFT_STEP = 5;

/**
 * What the estimate reads of an engine.
 * @typedef {object} EstimateInput
 * @property {import("./progressModels.js").Model} model
 * @property {import("./progressPacing.js").Pacing} pacing
 * @property {ReadonlyMap<string, Mark>} done Finished milestones by name.
 * @property {number} shown The highest percent reported so far (it never goes backwards).
 * @property {boolean} setupSeen Setup work was seen at least once.
 * @property {boolean} setupOpen A setup command or task is running now.
 * @property {(from: number, to: number) => number} setupMs The active milliseconds from `from` to
 *   `to` that went into setup.
 */

/**
 * A finished milestone: when (job active ms) and whether it was only implied by a later one.
 * @typedef {object} Mark
 * @property {number} atMs
 * @property {boolean} implied
 */

/**
 * What the estimate says at one moment.
 * @typedef {object} Estimated
 * @property {number} percent Never lower than `input.shown`, at most 99.
 * @property {string} stage
 * @property {number | null} secondsLeft Typical time left at this job's pace, rounded, or `null`
 *   when it cannot be told (no step left, the job is later than typical, or the tools are still
 *   being set up).
 */

/**
 * Where the evidence puts the job on the typical timeline: the typical time at which the finished
 * milestone that is typically reached last is finished, and the active time at which it was (the
 * start of the job when nothing is finished).
 * @param {EstimateInput} input
 * @returns {[number, number]}
 */
function anchor({ model, pacing, done }) {
  /** @type {[number, number]} */
  let best = [0, 0];
  model.steps.forEach((s, i) => {
    const mark = done.get(s.milestone);
    if (mark === undefined || !milestoneOf(s.milestone)?.anchors) return;
    const typical = pacing.atMs[i];
    if (typical > best[0] || (typical === best[0] && mark.atMs > best[1])) {
      best = [typical, mark.atMs];
    }
  });
  return best;
}

/**
 * How fast this job is against the typical pace: the active time of the finished milestone (seen,
 * not implied) that is typically reached last, over that typical time, clamped; 1 without such
 * evidence.
 * @param {EstimateInput} input
 * @returns {number}
 */
function pace({ model, pacing, done }) {
  let bestTypical = 0;
  let bestAt = 0;
  for (const [i, s] of model.steps.entries()) {
    const typical = pacing.atMs[i];
    const mark = done.get(s.milestone);
    if (
      mark === undefined ||
      mark.implied ||
      typical < MIN_PACE_EVIDENCE_MS ||
      !milestoneOf(s.milestone)?.anchors
    ) {
      continue;
    }
    // The milestone that is typically reached last wins; of equals, the later one in the list.
    if (typical >= bestTypical) {
      bestTypical = typical;
      bestAt = mark.atMs;
    }
  }
  if (bestTypical === 0) return 1;
  return Math.min(Math.max(bestAt / bestTypical, PACE_MIN), PACE_MAX);
}

/**
 * The most the bar may show while the milestones that only a file confirms have no file: the value
 * of everything before the first of them that is unfinished, plus all but one point of its own
 * weight, plus what finished beyond it.
 * @param {EstimateInput} input
 * @returns {number}
 */
function fileCeiling({ model, done }) {
  const steps = model.steps;
  const gate = steps.findIndex(
    (s) => milestoneOf(s.milestone)?.needsFile && !done.has(s.milestone),
  );
  if (gate === -1) return MAX_RUNNING_PERCENT;
  let total = Math.max(steps[gate].weight - 1, 0);
  steps.forEach((s, i) => {
    if (i < gate || (i > gate && done.has(s.milestone))) total += s.weight;
  });
  return Math.min(total, MAX_RUNNING_PERCENT);
}

/**
 * The progress to show `nowMs` into the job (active time).
 *
 * The percent is what the evidence confirms (the weights of the finished milestones) plus an
 * estimate for the unfinished ones from the active time since the evidence: the job is put on the
 * typical timeline at the anchor, and each unfinished milestone is credited the share of its
 * weight that the typical timeline has reached (a milestone that only a file confirms never
 * fully). Until the typical end of the first unfinished milestone (the stage) that milestone
 * stays one point below its value. After it, the job is later than typical without evidence, so
 * the estimate goes on into the following milestones with a slow-down that never stops, and the
 * stage reads "Working on ...", which claims no step.
 * @param {EstimateInput} input
 * @param {number} nowMs
 * @returns {Estimated}
 */
export function estimate(input, nowMs) {
  const { model, pacing, done, shown } = input;
  const steps = model.steps;
  const base = Math.min(
    steps.reduce((sum, s) => sum + (done.has(s.milestone) ? s.weight : 0), 0),
    MAX_RUNNING_PERCENT,
  );
  const frontier = steps.findIndex((s) => !done.has(s.milestone));
  if (frontier === -1) {
    return {
      percent: Math.min(Math.max(shown, base), MAX_RUNNING_PERCENT),
      stage: FINISHING_STAGE,
      secondsLeft: null,
    };
  }
  const typicalAt = (/** @type {string | null} */ name) => {
    const i = name === null ? -1 : steps.findIndex((s) => s.milestone === name);
    return i === -1 ? 0 : pacing.atMs[i];
  };
  const [anchorTypical, anchorAt] = anchor(input);
  // Time spent installing or testing tools is not the work: the estimate waits for it.
  const working = Math.max(Math.max(nowMs - anchorAt, 0) - input.setupMs(anchorAt, nowMs), 0);
  const jobPace = pace(input);
  const raw = anchorTypical + working / jobPace;
  // The typical window of every unfinished milestone, in the order the steps are listed (what a
  // milestone waits for is listed before it). A stretch starts when what it waits for ends: at
  // its typical time when that is finished, at its own window when not. A milestone the typical
  // timeline expected before the evidence (the b-roll when the graphics were confirmed first)
  // has no evidence yet, so its stretch starts at the evidence instead.
  /** @type {([number, number] | null)[]} */
  const windows = steps.map(() => null);
  steps.forEach((s, i) => {
    if (done.has(s.milestone)) return;
    const ends = (/** @type {string | null} */ name) => {
      if (name === null) return 0;
      const j = steps.findIndex((o) => o.milestone === name);
      if (j !== -1 && !done.has(name)) return windows[j]?.[1] ?? 0;
      return typicalAt(name);
    };
    const typicalStart = typicalAt(s.after);
    const end = Math.max(pacing.atMs[i], typicalStart + MIN_STRETCH_MS);
    const stretch = end - typicalStart;
    let start = Math.max(ends(s.after), ends(milestoneOf(s.milestone)?.alsoAfter ?? null));
    if (end <= anchorTypical) start = Math.max(start, anchorTypical);
    windows[i] = [start, start + stretch];
  });
  // Until the typical end of the stage the evidence has the job in, the stage stays a point short
  // of its value. After it the job is later than typical without evidence.
  const stageEnd = windows[frontier]?.[1] ?? raw;
  const overdue = raw - stageEnd;
  const total = Math.max(pacing.totalMs, ...pacing.atMs);
  // Before the footage is looked at, a computer that is still getting its tools ready has no work
  // to estimate: the bar stays in the first stage.
  const bootstrapping = input.setupSeen && !done.has("inspected") && model.kind === "edit";
  let typicalNow = raw;
  let spilled = false;
  if (bootstrapping) {
    typicalNow = Math.min(raw, stageEnd);
  } else if (overdue > 0) {
    const scale = Math.max(total * SLOWDOWN_SHARE, MIN_STRETCH_MS);
    typicalNow = stageEnd + SPILL_RATE * scale * Math.log(1 + overdue / scale);
    spilled = true;
  }
  let credit = 0;
  steps.forEach((s, i) => {
    const window = windows[i];
    if (window === null) return;
    const [start, end] = window;
    const reached = Math.min(Math.max((typicalNow - start) / (end - start), 0), 1);
    // The stage itself stays a point short of its value until it is overdue; a milestone that
    // only a file confirms always does.
    const held = (i === frontier && !spilled) || milestoneOf(s.milestone)?.needsFile === true;
    const cap = held ? Math.max(s.weight - 1, 0) : s.weight;
    credit += Math.min(s.weight * reached, cap);
  });
  const percent = Math.min(
    Math.max(shown, Math.min(base + Math.floor(credit), fileCeiling(input), MAX_RUNNING_PERCENT)),
    MAX_RUNNING_PERCENT,
  );
  // The label names the stage while the estimate is inside it (and a little past its value, so a
  // stage that runs a moment over does not flicker).
  let stage = steps[frontier].stage;
  if (bootstrapping || input.setupOpen) {
    stage = SETUP_STAGE;
  } else if (spilled && percent >= base + steps[frontier].weight + LABEL_SLACK) {
    stage = model.workingStage;
  }
  // The time left is the typical time left at this job's pace, told only while the job is on its
  // typical timeline: later than typical, or still getting its tools ready, nobody knows.
  let secondsLeft = null;
  if (!spilled && !bootstrapping && !input.setupOpen) {
    const seconds = (Math.max(total - typicalNow, 0) * jobPace) / 1000;
    const rounded = Math.round(seconds / SECONDS_LEFT_STEP) * SECONDS_LEFT_STEP;
    if (rounded > 0) secondsLeft = rounded;
  }
  return { percent, stage, secondsLeft };
}
