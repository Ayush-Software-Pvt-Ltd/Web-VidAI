// The progress models (docs/SPEC.md section 8 "Progress", carried over from docs/SPEC-desktop.md
// section 6 "Progress", src-tauri/src/jobs/progress.rs): for every agent job kind a weighted
// checklist of milestones, in the order the stage label follows.
//
// `render` has no model: the server runs the renderer itself and its progress comes from the
// renderer's own lines (`progressRender.js`).

/** The highest percent before the job is `completed`. */
export const MAX_RUNNING_PERCENT = 99;
/** The stage of a completed job. */
export const DONE_STAGE = "Done";
/**
 * The stage while the job installs or tests the tools it needs (a fresh computer has none of
 * them): setup commands are not the work, so the bar waits for the work.
 */
export const SETUP_STAGE = "Getting the tools ready";
/** The stage once every milestone of the model is finished but the job is not completed yet. */
export const FINISHING_STAGE = "Finishing up";

/** @typedef {"edit" | "reEdit" | "timelineEdit" | "render"} JobKind */
/** @typedef {"edit" | "reEdit" | "timelineEdit"} AgentKind The kinds an agent does. */
/** @typedef {"long" | "short"} VideoType */

/**
 * @typedef {"inspected" | "transcribed" | "planned" | "graphics_built" | "broll_ready"
 *   | "assembled" | "checked" | "project_saved" | "extras_written" | "changes_applied"
 * } MilestoneName One step of a job whose end can be confirmed; also the marker name, the key in
 *   the persisted memory and what the log shows.
 */

/**
 * What is known about one milestone, whatever model it is in.
 * @typedef {object} Milestone
 * @property {MilestoneName} name
 * @property {string} doneText The status line the activity log shows for its marker.
 * @property {string} hint What counts as finished, for the prompt.
 * @property {readonly MilestoneName[]} implies Milestones that must be finished when this one is
 *   (one level; the engine follows them transitively). Inside the step after the plan only the
 *   project implies the others: it is built from the finished graphics, b-roll, timeline and
 *   checks.
 * @property {MilestoneName | null} alsoAfter A milestone that must also be finished before this
 *   one starts, besides the one its stretch follows: the timeline is assembled from the graphics
 *   and the b-roll.
 * @property {boolean} needsFile Whether only a file can confirm it (the project, the thumbnails
 *   with meta.txt). Time never credits such a milestone: the bar stays below its value until the
 *   file exists.
 * @property {boolean} anchors Whether finishing it says where the job is on the typical timeline.
 *   The thumbnails and meta.txt come from a helper that runs beside the main work, and the b-roll
 *   runs beside the graphics (which take longer), so neither says anything about the pace.
 */

/**
 * @param {MilestoneName} name
 * @param {string} doneText
 * @param {string} hint
 * @param {Partial<Omit<Milestone, "name" | "doneText" | "hint">>} [rest]
 * @returns {Milestone}
 */
function milestone(name, doneText, hint, rest = {}) {
  return Object.freeze({
    name,
    doneText,
    hint,
    implies: Object.freeze(rest.implies ?? []),
    alsoAfter: rest.alsoAfter ?? null,
    needsFile: rest.needsFile ?? false,
    anchors: rest.anchors ?? true,
  });
}

/** Every milestone, in the order of the edit model, then the ones of the other kinds. */
export const MILESTONES = Object.freeze({
  inspected: milestone(
    "inspected",
    "Footage inspected",
    "the footage, MEMORY.md and the inputs are checked",
  ),
  transcribed: milestone("transcribed", "Transcription done", "the A-roll transcript is ready", {
    implies: ["inspected"],
  }),
  planned: milestone("planned", "Edit plan written", "the written edit plan is ready", {
    implies: ["transcribed"],
  }),
  graphics_built: milestone(
    "graphics_built",
    "Graphics built",
    "every programmatic graphic and b-roll is built",
    { implies: ["planned"] },
  ),
  broll_ready: milestone(
    "broll_ready",
    "B-roll and product images ready",
    "the b-roll footage is conformed and the product images are prepared",
    { implies: ["planned"], anchors: false },
  ),
  assembled: milestone(
    "assembled",
    "Timeline assembled",
    "the timeline is assembled and the audio is normalized",
    { implies: ["planned"], alsoAfter: "broll_ready" },
  ),
  checked: milestone("checked", "Quality checks done", "the quality checks are done", {
    implies: ["planned"],
  }),
  project_saved: milestone(
    "project_saved",
    "Project saved",
    "the project is saved in the output folder",
    {
      implies: ["graphics_built", "broll_ready", "assembled", "checked", "changes_applied"],
      needsFile: true,
    },
  ),
  extras_written: milestone(
    "extras_written",
    "Thumbnails and details written",
    "the thumbnails, meta.txt and info.txt are written",
    { implies: ["transcribed"], needsFile: true, anchors: false },
  ),
  changes_applied: milestone(
    "changes_applied",
    "Changes applied",
    "the requested changes are made",
  ),
});

/** @type {readonly MilestoneName[]} */
export const MILESTONE_NAMES = Object.freeze(
  /** @type {MilestoneName[]} */ (Object.keys(MILESTONES)),
);

/**
 * The milestone with a marker name, or `null` for a name VidAI does not know.
 * @param {string} name
 * @returns {Milestone | null}
 */
export function milestoneOf(name) {
  return Object.hasOwn(MILESTONES, name) ? MILESTONES[/** @type {MilestoneName} */ (name)] : null;
}

/**
 * One milestone of a model.
 * @typedef {object} Step
 * @property {MilestoneName} milestone
 * @property {number} weight Percent points it adds when finished.
 * @property {string} stage What the job works on while this milestone is the next one.
 * @property {MilestoneName | null} after The milestone whose end starts this stretch (`null`: the
 *   start of the job), for timing.
 * @property {readonly [number, number]} typicalMin Typical active minutes from the start of the
 *   job to the end of this milestone, for a Short and for a Long video, when there is no history.
 */

/**
 * The milestones of one job kind, in the order the stage label follows (the first unfinished one
 * is the stage), and the typical active minutes of the whole job (Short, Long).
 * @typedef {object} Model
 * @property {AgentKind} kind
 * @property {readonly Step[]} steps
 * @property {readonly [number, number]} totalMin
 * @property {string} workingStage The label while the bar is ahead of what the evidence confirms.
 */

/**
 * @param {MilestoneName} name
 * @param {number} weight
 * @param {string} stage
 * @param {MilestoneName | null} after
 * @param {[number, number]} typicalMin
 * @returns {Step}
 */
function step(name, weight, stage, after, typicalMin) {
  return Object.freeze({ milestone: name, weight, stage, after, typicalMin });
}

/**
 * `edit`. Calibration (active minutes, waiting for the creator excluded) from the owner's real
 * edits, kept from the desktop app (progress.rs):
 * - Short (about 90 s of output): transcription 1.5-5, transcription to written plan 3-8, plan to
 *   project 15-20, total 19.5-30, typically about 25. Inside the last stretch 4 graphics agents
 *   build 19-25 compositions while the lead conforms b-roll and sets the audio loudness;
 *   thumbnails and meta.txt come from a parallel agent that finishes at 13-18.
 * - Long: transcription 1.5-14, written plan at 10-26, graphics fan-out of 20-30 ending at 22-49,
 *   project at 27-60, typically about 40.
 * The weights follow the shares of the whole time the milestones end at, rounded toward the
 * owner's anchors (transcription about 15%, plan about 25%, all b-roll about 70%): the cumulative
 * values are 3, 15, 30, then 64 / 74 for graphics and b-roll in either order, 83, 91, 96 and 99.
 * The time creep fills the gaps, so the bar moves at a nearly even speed on a typical edit and
 * still lands on the right value whenever evidence arrives.
 * @type {Model}
 */
const EDIT = Object.freeze({
  kind: "edit",
  steps: Object.freeze([
    step("inspected", 3, "Inspecting the footage", null, [0.75, 1.0]),
    step("transcribed", 12, "Transcribing", "inspected", [3.5, 8.0]),
    step("planned", 15, "Planning the edit", "transcribed", [7.0, 15.0]),
    step("graphics_built", 34, "Building graphics", "planned", [20.5, 34.0]),
    step("broll_ready", 10, "Preparing b-roll", "planned", [15.0, 24.0]),
    step("assembled", 9, "Assembling the timeline", "graphics_built", [21.5, 36.0]),
    step("checked", 8, "Checking the edit", "assembled", [22.5, 38.0]),
    step("project_saved", 5, "Saving the project", "checked", [23.5, 40.0]),
    step("extras_written", 3, "Thumbnails and details", "project_saved", [24.5, 41.5]),
  ]),
  totalMin: Object.freeze(/** @type {[number, number]} */ ([25.0, 42.5])),
  workingStage: "Working on the edit",
});

/**
 * `reEdit`: revisions of the owner's edits took 6-9 minutes on a Short (all text pop-ups moved and
 * checked frame by frame, the project exported again); a Long takes longer. The two weights
 * add up to 95: a finished re-edit shows 95, "Finishing up", until the job is completed, and
 * without the project file the bar stops at 94 (as in the desktop app).
 * @type {Model}
 */
const RE_EDIT = Object.freeze({
  kind: "reEdit",
  steps: Object.freeze([
    step("changes_applied", 65, "Applying the changes", null, [5.0, 9.0]),
    step("project_saved", 30, "Saving the project", "changes_applied", [6.5, 11.0]),
  ]),
  totalMin: Object.freeze(/** @type {[number, number]} */ ([7.5, 12.5])),
  workingStage: "Working on the changes",
});

/**
 * `timelineEdit`: the agent applies change requests made on the timeline to the existing project
 * (SPEC section 11), a smaller job than a whole-video re-edit; the typical times are estimates
 * until this server has its own history. Same mechanism as `reEdit`: the weights add up to 95.
 * @type {Model}
 */
const TIMELINE_EDIT = Object.freeze({
  kind: "timelineEdit",
  steps: Object.freeze([
    step("changes_applied", 70, "Applying the changes", null, [3.0, 6.0]),
    step("project_saved", 25, "Saving the project", "changes_applied", [4.0, 7.5]),
  ]),
  totalMin: Object.freeze(/** @type {[number, number]} */ ([5.0, 8.5])),
  workingStage: "Working on the changes",
});

/** The models by kind. */
export const MODELS = Object.freeze({
  edit: EDIT,
  reEdit: RE_EDIT,
  timelineEdit: TIMELINE_EDIT,
});

/**
 * Whether the kind is one an agent does (and so has a progress model).
 * @param {string} kind
 * @returns {kind is AgentKind}
 */
export function isAgentKind(kind) {
  return Object.hasOwn(MODELS, kind);
}

/**
 * The model of an agent job kind.
 * @param {AgentKind} kind
 * @returns {Model}
 */
export function modelOf(kind) {
  if (!isAgentKind(kind)) {
    throw new TypeError(`The kind "${String(kind)}" has no progress model.`);
  }
  return MODELS[kind];
}
