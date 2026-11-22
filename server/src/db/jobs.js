// The `jobs` table (docs/SPEC.md sections 8 and 15). Plain data in, plain camelCase records out;
// the scheduling rules are in `jobs/schedule.js` and the decisions in `jobs/queueService.js`.
//
// Every change of state goes through `transition`: one UPDATE guarded by the state the caller
// expects, so two requests (Pause and Stop, a scheduler pass and a Stop) can never both win, and
// the running time bookkeeping happens in the same statement so it cannot be forgotten.

import { randomBytes } from "node:crypto";
import { conflict, invalidInput } from "../errors.js";
import { ENDED_STATES, queueOfKind } from "../jobs/schedule.js";
import { systemClock } from "./open.js";

/** @typedef {import("../../../src/lib/wire/jobs.ts").JobKind} JobKind */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobQueue} JobQueue */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobState} JobState */
/** @typedef {import("../../../src/lib/wire/channels.ts").VideoType} VideoType */
/** @typedef {import("../../../src/lib/wire/progress.ts").JobProgress} JobProgress */
/** @typedef {import("../../../src/lib/wire.ts").Setup} Setup */
/** @typedef {import("../../../src/lib/wire/harness.ts").HarnessProgram} HarnessProgram */

/**
 * A job row as the server works with it.
 * @typedef {object} JobRecord
 * @property {string} id
 * @property {string} videoKey `videos.id` of the video it belongs to.
 * @property {string} userId
 * @property {JobKind} kind
 * @property {JobQueue} queue
 * @property {JobState} state
 * @property {boolean} urgent
 * @property {number} joinedAt
 * @property {number | null} startedAt When it first ran; a Continue does not change it.
 * @property {number | null} endedAt
 * @property {Setup | null} setup
 * @property {HarnessProgram | null} harness
 * @property {string | null} model
 * @property {string | null} effort
 * @property {unknown} request What the job was asked (stays as the job's own JSON).
 * @property {JobProgress | null} progress
 * @property {string | null} error The sentence for the user.
 * @property {number} retries
 * @property {number} activeMs Time spent `running` so far, the open stretch excluded.
 * @property {number | null} runningSince Set while `running`.
 * @property {VideoType} videoType
 * @property {number | null} costUsd
 * @property {boolean} startNow The start delay is skipped for this job once.
 * @property {boolean} resume This waiting job continues a paused session; it is not a launch.
 */

/**
 * @typedef {object} NewJob
 * @property {string} [id]
 * @property {string} videoKey
 * @property {string} userId
 * @property {JobKind} kind The queue follows from the kind.
 * @property {boolean} [urgent] Edit queue only.
 * @property {number} [joinedAt] Default: now.
 * @property {Setup | null} [setup]
 * @property {HarnessProgram | null} [harness]
 * @property {string | null} [model]
 * @property {string | null} [effort]
 * @property {unknown} [request]
 * @property {VideoType} videoType
 * @property {JobState} [state] `queued` unless the job is made already running (tests, imports).
 * @property {boolean} [resume]
 */

/**
 * What `transition` may set besides the state. Times and the running time bookkeeping are done
 * by `transition` itself; `startedAt` and `endedAt` are only needed to override them.
 * @typedef {object} TransitionPatch
 * @property {number | null} [startedAt]
 * @property {number | null} [endedAt]
 * @property {string | null} [error]
 * @property {boolean} [resume]
 * @property {boolean} [startNow]
 * @property {number | null} [costUsd]
 * @property {JobProgress | null} [progress]
 */

/** Ended jobs kept per video; older ones are pruned (SPEC section 15 keeps history short). */
export const KEEP_ENDED_PER_VIDEO = 50;

const COLUMNS = `id, video_id, user_id, kind, queue, state, urgent, joined_at, started_at, ended_at,
  setup, harness, model, effort, request, progress, error, retries, active_ms, running_since,
  video_type, cost_usd, start_now, resume`;

const ALREADY_ACTIVE = "This video already has an edit in progress.";
const HOLDING = "'running', 'pausing', 'stopping'";
const ACTIVE = "'queued', 'running', 'pausing', 'paused', 'stopping'";
// A statement can carry this many keys in `IN (...)` comfortably under SQLite's variable limit.
const KEY_CHUNK = 500;

/** @param {unknown} raw */
function parseJson(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The error column holds `{ "message": sentence }`; a bare JSON string is read too. @param {unknown} raw */
function parseError(raw) {
  const value = parseJson(raw);
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const message = /** @type {{ message?: unknown }} */ (value).message;
    if (typeof message === "string") return message;
  }
  return null;
}

/**
 * @param {import("./open.js").Row} row
 * @returns {JobRecord}
 */
function toJob(row) {
  return {
    id: String(row.id),
    videoKey: String(row.video_id),
    userId: String(row.user_id),
    kind: /** @type {JobKind} */ (row.kind),
    queue: /** @type {JobQueue} */ (row.queue),
    state: /** @type {JobState} */ (row.state),
    urgent: row.urgent === 1,
    joinedAt: Number(row.joined_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    setup: /** @type {Setup | null} */ (row.setup),
    harness: /** @type {HarnessProgram | null} */ (row.harness),
    model: row.model === null ? null : String(row.model),
    effort: row.effort === null ? null : String(row.effort),
    request: parseJson(row.request) ?? {},
    progress: /** @type {JobProgress | null} */ (parseJson(row.progress)),
    error: parseError(row.error),
    retries: Number(row.retries),
    activeMs: Number(row.active_ms),
    runningSince: row.running_since === null ? null : Number(row.running_since),
    videoType: row.video_type === "short" ? "short" : "long",
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    startNow: row.start_now === 1,
    resume: row.resume === 1,
  };
}

/** @param {string | null | undefined} message */
function errorJson(message) {
  return message === null || message === undefined ? null : JSON.stringify({ message });
}

/**
 * @param {import("./open.js").Database} db
 * @param {{ clock?: import("./open.js").Clock }} [options]
 */
export function createJobsRepo(db, { clock = systemClock } = {}) {
  /** @param {string} id @returns {JobRecord | undefined} */
  function get(id) {
    const row = db.get(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`, id);
    return row && toJob(row);
  }

  /** @param {string} where @param {...(string | number)} params @returns {JobRecord[]} */
  function list(where, ...params) {
    return db.all(`SELECT ${COLUMNS} FROM jobs WHERE ${where}`, ...params).map(toJob);
  }

  return {
    get,

    /**
     * Makes a job (`queued` unless said otherwise).
     * @param {NewJob} job
     * @returns {JobRecord}
     * @throws {import("../errors.js").AppError} `conflict` when the video already has an active job.
     */
    create(job) {
      const queue = queueOfKind(job.kind);
      const state = job.state ?? "queued";
      const id = job.id ?? randomBytes(16).toString("hex");
      const now = clock.now();
      if (job.videoType !== "long" && job.videoType !== "short") {
        throw invalidInput("The video type of a job must be long or short.");
      }
      try {
        db.run(
          `INSERT INTO jobs (id, video_id, user_id, kind, queue, state, urgent, joined_at, started_at,
             running_since, setup, harness, model, effort, request, video_type, resume)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          job.videoKey,
          job.userId,
          job.kind,
          queue,
          state,
          queue === "edits" && job.urgent ? 1 : 0,
          job.joinedAt ?? now,
          state === "running" ? now : null,
          state === "running" ? now : null,
          job.setup ?? null,
          job.harness ?? null,
          job.model ?? null,
          job.effort ?? null,
          JSON.stringify(job.request ?? {}),
          job.videoType,
          job.resume ? 1 : 0,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          /UNIQUE constraint failed: jobs\.video_id/.test(error.message)
        ) {
          throw conflict(ALREADY_ACTIVE);
        }
        throw error;
      }
      const created = get(id);
      if (!created) throw new Error("A job that was just created cannot be read.");
      return created;
    },

    /**
     * The newest job of each video (the library shows its state).
     * @param {readonly string[]} videoKeys
     * @returns {Map<string, JobRecord>} Keyed by video key; videos without a job are absent.
     */
    latestForVideos(videoKeys) {
      /** @type {Map<string, JobRecord>} */
      const result = new Map();
      for (let i = 0; i < videoKeys.length; i += KEY_CHUNK) {
        const chunk = videoKeys.slice(i, i + KEY_CHUNK);
        const marks = chunk.map(() => "?").join(", ");
        const rows = db.all(
          `SELECT ${COLUMNS} FROM jobs
           WHERE video_id IN (${marks})
             AND rowid = (SELECT MAX(rowid) FROM jobs AS newer WHERE newer.video_id = jobs.video_id)`,
          ...chunk,
        );
        for (const row of rows) result.set(String(row.video_id), toJob(row));
      }
      return result;
    },

    /** The active job of a video, if any. @param {string} videoKey */
    activeForVideo(videoKey) {
      return list(`video_id = ? AND state IN (${ACTIVE})`, videoKey)[0];
    },

    /** Every active job of every queue, oldest first. @returns {JobRecord[]} */
    active() {
      return list(`state IN (${ACTIVE}) ORDER BY joined_at, id`);
    },

    /** Jobs waiting in a queue, in the order they joined (the line order is `schedule.js`). @param {JobQueue} queue */
    waiting(queue) {
      return list("queue = ? AND state = 'queued' ORDER BY joined_at, id", queue);
    },

    /** Jobs holding a slot of a queue: running, pausing, stopping. @param {JobQueue} queue */
    running(queue) {
      return list(`queue = ? AND state IN (${HOLDING}) ORDER BY joined_at, id`, queue);
    },

    /**
     * How many jobs of each user hold a slot of a queue.
     * @param {JobQueue} queue
     * @returns {Map<string, number>}
     */
    countRunningByUser(queue) {
      const rows = db.all(
        `SELECT user_id, COUNT(*) AS n FROM jobs WHERE queue = ? AND state IN (${HOLDING}) GROUP BY user_id`,
        queue,
      );
      return new Map(rows.map((row) => [String(row.user_id), Number(row.n)]));
    },

    /** A user's active jobs of all queues, oldest first. @param {string} userId */
    forUser(userId) {
      return list(`user_id = ? AND state IN (${ACTIVE}) ORDER BY joined_at, id`, userId);
    },

    /**
     * Moves a job to another state if it is in one of the `from` states right now; one UPDATE.
     * Running time is kept here: leaving `running` adds the open stretch to `activeMs`, entering
     * it opens one (`runningSince`). `startedAt` is set the first time a job runs and `endedAt`
     * when it ends, unless the patch says otherwise.
     * @param {string} id
     * @param {readonly JobState[]} from
     * @param {JobState} to
     * @param {TransitionPatch} [patch]
     * @param {{ countTime?: boolean }} [options] `countTime: false` closes the open stretch
     *   without adding it (recovery after a restart: the time the server was down is not work).
     * @returns {boolean} Whether this call changed the job.
     * @throws {import("../errors.js").AppError} `conflict` when moving it would give the video
     *   a second active job.
     */
    transition(id, from, to, patch = {}, { countTime = true } = {}) {
      if (from.length === 0) return false;
      const now = clock.now();
      /** @type {string[]} */
      const sets = ["state = ?"];
      /** @type {(string | number | null)[]} */
      const params = [to];
      if (countTime) {
        sets.push(
          `active_ms = active_ms + CASE WHEN state = 'running' AND ? <> 'running'
             AND running_since IS NOT NULL THEN MAX(0, ? - running_since) ELSE 0 END`,
        );
        params.push(to, now);
      }
      // SQLite reads the old row for every expression, so `state` here is the state before.
      sets.push(
        `running_since = CASE WHEN ? = 'running' THEN
           (CASE WHEN state = 'running' THEN running_since ELSE ? END) ELSE NULL END`,
      );
      params.push(to, now);

      if (patch.startedAt !== undefined) {
        sets.push("started_at = ?");
        params.push(patch.startedAt);
      } else if (to === "running") {
        sets.push("started_at = COALESCE(started_at, ?)");
        params.push(now);
      }
      if (patch.endedAt !== undefined) {
        sets.push("ended_at = ?");
        params.push(patch.endedAt);
      } else if (/** @type {readonly string[]} */ (ENDED_STATES).includes(to)) {
        sets.push("ended_at = COALESCE(ended_at, ?)");
        params.push(now);
      }
      if (patch.error !== undefined) {
        sets.push("error = ?");
        params.push(errorJson(patch.error));
      }
      if (patch.resume !== undefined) {
        sets.push("resume = ?");
        params.push(patch.resume ? 1 : 0);
      }
      if (patch.startNow !== undefined) {
        sets.push("start_now = ?");
        params.push(patch.startNow ? 1 : 0);
      }
      if (patch.costUsd !== undefined) {
        sets.push("cost_usd = ?");
        params.push(patch.costUsd);
      }
      if (patch.progress !== undefined) {
        sets.push("progress = ?");
        params.push(patch.progress === null ? null : JSON.stringify(patch.progress));
      }

      const marks = from.map(() => "?").join(", ");
      try {
        const result = db.run(
          `UPDATE jobs SET ${sets.join(", ")} WHERE id = ? AND state IN (${marks})`,
          ...params,
          id,
          ...from,
        );
        return result.changes === 1;
      } catch (error) {
        if (
          error instanceof Error &&
          /UNIQUE constraint failed: jobs\.video_id/.test(error.message)
        ) {
          throw conflict(ALREADY_ACTIVE);
        }
        throw error;
      }
    },

    /**
     * Urgent on or off for a job that waits in the edit queue.
     * @param {string} id
     * @param {boolean} urgent
     * @returns {boolean} Whether the job is a waiting edit (and now has this value).
     */
    setUrgent(id, urgent) {
      const result = db.run(
        "UPDATE jobs SET urgent = ? WHERE id = ? AND queue = 'edits' AND state = 'queued'",
        urgent ? 1 : 0,
        id,
      );
      return result.changes === 1;
    },

    /**
     * Skip the start delay once for a waiting edit.
     * @param {string} id
     * @param {boolean} startNow
     * @returns {boolean}
     */
    setStartNow(id, startNow) {
      const result = db.run(
        "UPDATE jobs SET start_now = ? WHERE id = ? AND queue = 'edits' AND state = 'queued'",
        startNow ? 1 : 0,
        id,
      );
      return result.changes === 1;
    },

    /** @param {string} id @param {JobProgress | null} progress @returns {boolean} */
    setProgress(id, progress) {
      const result = db.run(
        "UPDATE jobs SET progress = ? WHERE id = ?",
        progress === null ? null : JSON.stringify(progress),
        id,
      );
      return result.changes === 1;
    },

    /** @param {string} id @param {string | null} message A sentence for the user. @returns {boolean} */
    setError(id, message) {
      return db.run("UPDATE jobs SET error = ? WHERE id = ?", errorJson(message), id).changes === 1;
    },

    /** @param {string} id @param {number | null} costUsd @returns {boolean} */
    setCost(id, costUsd) {
      return db.run("UPDATE jobs SET cost_usd = ? WHERE id = ?", costUsd, id).changes === 1;
    },

    /**
     * Replaces what the job was asked (the manager keeps the saved revision number, the taken
     * change requests and the like in it).
     * @param {string} id
     * @param {unknown} request
     * @returns {boolean}
     */
    setRequest(id, request) {
      return (
        db.run("UPDATE jobs SET request = ? WHERE id = ?", JSON.stringify(request ?? {}), id)
          .changes === 1
      );
    },

    /**
     * Records the setup, program, model and effort a job really launches with (they differ from
     * the ones it was queued with when its own setup cannot continue its session).
     * @param {string} id
     * @param {{ setup: Setup, harness: HarnessProgram, model: string | null, effort: string | null }} launch
     * @returns {boolean}
     */
    setLaunch(id, { setup, harness, model, effort }) {
      return (
        db.run(
          "UPDATE jobs SET setup = ?, harness = ?, model = ?, effort = ? WHERE id = ?",
          setup,
          harness,
          model,
          effort,
          id,
        ).changes === 1
      );
    },

    /**
     * Counts one more model retry.
     * @param {string} id
     * @returns {number | null} The new count; `null` for an unknown job.
     */
    addRetry(id) {
      const row = db.get(
        "UPDATE jobs SET retries = retries + 1 WHERE id = ? RETURNING retries",
        id,
      );
      return row ? Number(row.retries) : null;
    },

    /**
     * The jobs of a video, newest first.
     * @param {string} videoKey
     * @param {number} [limit]
     */
    history(videoKey, limit = KEEP_ENDED_PER_VIDEO) {
      return db
        .all(
          `SELECT ${COLUMNS} FROM jobs WHERE video_id = ? ORDER BY rowid DESC LIMIT ?`,
          videoKey,
          Math.max(0, Math.floor(limit)),
        )
        .map(toJob);
    },

    /**
     * Deletes ended jobs of a video beyond the newest `keep`. Their log files are the caller's.
     * @param {string} videoKey
     * @param {number} [keep]
     * @returns {string[]} The ids removed.
     */
    pruneEnded(videoKey, keep = KEEP_ENDED_PER_VIDEO) {
      return db.transaction(() => {
        const rows = db.all(
          `SELECT id FROM jobs WHERE video_id = ? AND state IN ('stopped', 'failed', 'completed')
           ORDER BY rowid DESC LIMIT -1 OFFSET ?`,
          videoKey,
          Math.max(0, Math.floor(keep)),
        );
        const ids = rows.map((row) => String(row.id));
        for (const id of ids) db.run("DELETE FROM jobs WHERE id = ?", id);
        return ids;
      });
    },
  };
}
