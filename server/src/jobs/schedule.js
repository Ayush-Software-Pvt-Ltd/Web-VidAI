// The scheduling rules of the three queues as one pure function (docs/SPEC.md section 8, "The edit
// queue" and "The timeline queue and the render queue"). No
// clock, no database: the caller passes everything in and applies the answer, so every rule is
// a table test.

/** @typedef {import("../../../src/lib/wire/jobs.ts").JobKind} JobKind */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobQueue} JobQueue */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobState} JobState */

/** The three lines, in the order the pages list them. */
export const QUEUES = /** @type {const} */ (["edits", "timeline", "renders"]);

/** A job is active in these states; a video has at most one active job (SPEC section 8). */
export const ACTIVE_STATES = /** @type {const} */ ([
  "queued",
  "running",
  "pausing",
  "paused",
  "stopping",
]);

/** Running, pausing and stopping jobs hold a slot; paused and queued ones do not. */
export const SLOT_STATES = /** @type {const} */ (["running", "pausing", "stopping"]);

/** A job in one of these states is over. */
export const ENDED_STATES = /** @type {const} */ (["stopped", "failed", "completed"]);

/**
 * The line a kind always waits in.
 * @param {JobKind} kind
 * @returns {JobQueue}
 */
export function queueOfKind(kind) {
  switch (kind) {
    case "edit":
    case "reEdit":
      return "edits";
    case "timelineEdit":
      return "timeline";
    case "render":
      return "renders";
  }
}

/**
 * A job in the line.
 * @typedef {object} WaitingJob
 * @property {string} id
 * @property {string} userId
 * @property {boolean} urgent Edit queue only; ignored in the other two.
 * @property {number} joinedAt Start Editing, Re-Edit, ...; a continued job keeps its original time.
 * @property {boolean} resume The job continues a paused session: not a launch of a new session,
 *   so the start delay neither holds it nor restarts.
 * @property {boolean} startNow The start delay is skipped for this job once.
 */

/**
 * A job that holds a slot (running, pausing or stopping).
 * @typedef {object} HoldingJob
 * @property {string} id
 * @property {string} userId
 */

/**
 * @typedef {object} Limits
 * @property {number} slots Jobs that may hold a slot at once (`maxEdits` and so on).
 * @property {number} perUser Edit queue only: edits of one user that may hold a slot at once; 0 = no limit.
 * @property {number} startDelayMs Edit queue only: between two launches of new sessions; 0 = off.
 */

/**
 * @typedef {object} Plan
 * @property {string[]} start Jobs that get a slot now, in the order they start.
 * @property {Map<string, number>} positions Every waiting job (also the ones in `start`), 1..n in
 *   line order without holes; a job skipped for the per-user limit keeps its number.
 * @property {Map<string, number>} startsAt Only the job that is next and held back by nothing but
 *   the start delay (a slot is free and the user is within the limit): when the delay lets it start.
 * @property {number | null} wakeAt When the plan must be computed again without any event: the
 *   delay running out; `null` when no timer is needed.
 */

/**
 * The line order: edit queue Urgent first, each class by `joinedAt`; the others by `joinedAt`.
 * Ties go to the id, so the order is total and stable.
 * @param {JobQueue} queue
 * @param {readonly WaitingJob[]} waiting
 * @returns {WaitingJob[]}
 */
export function lineOrder(queue, waiting) {
  const urgentFirst = queue === "edits";
  return [...waiting].sort((a, b) => {
    if (urgentFirst && a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Decides which waiting jobs start now, their positions and what the start delay says.
 *
 * Walking the line in order while slots are free: a job of a user at their limit is skipped; a
 * job with `resume` starts (a resume may pass a fresh job the delay holds); a fresh job starts
 * when no job holds a slot or `startDelayMs` has passed since the last launch (each launch
 * restarts that clock), or when `startNow` is set (it is then ahead of the held jobs too). Once a
 * fresh job is held back the fresh jobs behind it stay behind it. The timeline and render
 * queues are plain first-in first-out with their own slots.
 *
 * "No job holds a slot" opens the delay: with nothing running there is
 * nothing to spare the CPU for, so a job that finishes lets the next launch start at once.
 *
 * @param {object} input
 * @param {JobQueue} input.queue
 * @param {readonly WaitingJob[]} input.waiting
 * @param {readonly HoldingJob[]} input.running Jobs holding a slot.
 * @param {Limits} input.limits
 * @param {number | null} input.lastLaunchAt The most recent launch of a new session in the edit queue.
 * @param {number} input.now
 * @returns {Plan}
 */
export function plan({ queue, waiting, running, limits, lastLaunchAt, now }) {
  const ordered = lineOrder(queue, waiting);
  /** @type {Map<string, number>} */
  const positions = new Map();
  ordered.forEach((job, index) => positions.set(job.id, index + 1));

  const edits = queue === "edits";
  const perUser = edits ? Math.max(0, limits.perUser) : 0;
  const delay = edits ? Math.max(0, limits.startDelayMs) : 0;
  let free = Math.max(0, limits.slots - running.length);
  let holding = running.length;
  /** @type {Map<string, number>} */
  const perUserCount = new Map();
  for (const job of running) perUserCount.set(job.userId, (perUserCount.get(job.userId) ?? 0) + 1);
  // A last launch in the future (the clock was set back) counts as now: nothing waits longer
  // than one delay.
  let last = lastLaunchAt === null ? null : Math.min(lastLaunchAt, now);

  /** @param {WaitingJob} job */
  const atLimit = (job) => perUser > 0 && (perUserCount.get(job.userId) ?? 0) >= perUser;
  /** @param {number | null} at */
  const delayOpen = (at) => delay === 0 || holding === 0 || at === null || now >= at + delay;

  /** @type {string[]} */
  const start = [];
  /** @type {Set<string>} */
  const started = new Set();
  let blocked = false;
  for (const job of ordered) {
    if (free === 0) break;
    if (atLimit(job)) continue;
    let go;
    if (!edits || job.resume || job.startNow) go = true;
    else if (blocked) go = false;
    else {
      go = delayOpen(last);
      if (!go) blocked = true;
    }
    if (!go) continue;
    start.push(job.id);
    started.add(job.id);
    free -= 1;
    holding += 1;
    perUserCount.set(job.userId, (perUserCount.get(job.userId) ?? 0) + 1);
    if (edits && !job.resume) last = now;
  }

  /** @type {Map<string, number>} */
  const startsAt = new Map();
  let wakeAt = null;
  if (edits && free > 0 && delay > 0 && holding > 0 && last !== null && last + delay > now) {
    // A slot is free, so whoever is next in line waits for the delay and nothing else.
    const next = ordered.find((job) => !started.has(job.id) && !atLimit(job));
    if (next) {
      startsAt.set(next.id, last + delay);
      wakeAt = last + delay;
    }
  }
  return { start, positions, startsAt, wakeAt };
}
