// The `notes` table (docs/SPEC.md sections 11 and 15): the change requests of a video. Plain data
// in, plain camelCase objects out; the rules (validation, who may do what, events) are in
// `timeline/notes.js`.
//
// States: `pending` (waiting for a job), `running` (a job took it), `done`, `failed`.

import { randomBytes } from "node:crypto";
import { systemClock } from "./open.js";

/** @typedef {import("../../../src/lib/wire/timeline.ts").NoteShape} NoteShape */
/** @typedef {import("../../../src/lib/wire/timeline.ts").NoteState} NoteState */

/**
 * @typedef {object} NoteRecord
 * @property {string} id
 * @property {string} videoKey
 * @property {string} userId Who wrote it.
 * @property {number} frame
 * @property {NoteShape | null} shape
 * @property {string | null} elementId
 * @property {string} prompt
 * @property {NoteState} state
 * @property {string | null} jobId
 * @property {string | null} error Why it failed (a sentence), `null` unless `state` is `failed`.
 * @property {number} createdAt
 */

const COLUMNS =
  "id, video_id, user_id, frame, shape, element_id, prompt, state, job_id, error, created_at";

/** @param {unknown} raw @returns {NoteShape | null} */
function parseShape(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    const { cx, cy, rx, ry } = value ?? {};
    return [cx, cy, rx, ry].every((part) => typeof part === "number") ? { cx, cy, rx, ry } : null;
  } catch {
    return null;
  }
}

/**
 * @param {import("./open.js").Row} row
 * @returns {NoteRecord}
 */
function toNote(row) {
  return {
    id: String(row.id),
    videoKey: String(row.video_id),
    userId: String(row.user_id),
    frame: Number(row.frame),
    shape: parseShape(row.shape),
    elementId: row.element_id === null ? null : String(row.element_id),
    prompt: String(row.prompt),
    state: /** @type {NoteState} */ (String(row.state)),
    jobId: row.job_id === null ? null : String(row.job_id),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: Number(row.created_at),
  };
}

/**
 * @param {import("./open.js").Database} db
 * @param {{ clock?: import("./open.js").Clock }} [options]
 */
export function createNotesRepo(db, { clock = systemClock } = {}) {
  return {
    /**
     * Stores a new request as `pending`; the input is already validated.
     * @param {{ videoKey: string, userId: string, frame: number, shape: NoteShape | null, elementId: string | null, prompt: string }} input
     * @returns {NoteRecord}
     */
    insert({ videoKey, userId, frame, shape, elementId, prompt }) {
      const id = randomBytes(16).toString("hex");
      const createdAt = clock.now();
      db.run(
        `INSERT INTO notes (id, video_id, user_id, frame, shape, element_id, prompt, state, job_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        id,
        videoKey,
        userId,
        frame,
        shape === null ? null : JSON.stringify(shape),
        elementId,
        prompt,
        createdAt,
      );
      return {
        id,
        videoKey,
        userId,
        frame,
        shape,
        elementId,
        prompt,
        state: "pending",
        jobId: null,
        error: null,
        createdAt,
      };
    },

    /** @param {string} id @returns {NoteRecord | undefined} */
    byId(id) {
      const row = db.get(`SELECT ${COLUMNS} FROM notes WHERE id = ?`, id);
      return row && toNote(row);
    },

    /**
     * Every request of the video, in the order they were written.
     * @param {string} videoKey
     * @returns {NoteRecord[]}
     */
    listForVideo(videoKey) {
      return db
        .all(`SELECT ${COLUMNS} FROM notes WHERE video_id = ? ORDER BY created_at, rowid`, videoKey)
        .map(toNote);
    },

    /** @param {string} videoKey @returns {NoteRecord[]} */
    pending(videoKey) {
      return db
        .all(
          `SELECT ${COLUMNS} FROM notes WHERE video_id = ? AND state = 'pending' ORDER BY created_at, rowid`,
          videoKey,
        )
        .map(toNote);
    },

    /** @param {string} jobId @returns {NoteRecord[]} */
    byJob(jobId) {
      return db
        .all(`SELECT ${COLUMNS} FROM notes WHERE job_id = ? ORDER BY created_at, rowid`, jobId)
        .map(toNote);
    },

    /**
     * Every pending request of the video becomes `running` and belongs to the job.
     * @param {string} videoKey
     * @param {string} jobId
     * @returns {NoteRecord[]} The taken ones, in order.
     */
    take(videoKey, jobId) {
      return db.transaction(() => {
        const taken = this.pending(videoKey);
        for (const note of taken) {
          db.run("UPDATE notes SET state = 'running', job_id = ? WHERE id = ?", jobId, note.id);
        }
        return taken.map((note) => ({
          ...note,
          state: /** @type {NoteState} */ ("running"),
          jobId,
        }));
      });
    },

    /**
     * The running requests of a job get their end state; a failed one keeps the sentence.
     * @param {string} jobId
     * @param {"done" | "failed"} state
     * @param {string | null} [error] Why they failed (ignored for `done`).
     * @returns {NoteRecord[]} The changed ones.
     */
    finish(jobId, state, error = null) {
      const sentence = state === "failed" ? error : null;
      return db.transaction(() => {
        const running = this.byJob(jobId).filter((note) => note.state === "running");
        for (const note of running) {
          db.run("UPDATE notes SET state = ?, error = ? WHERE id = ?", state, sentence, note.id);
        }
        return running.map((note) => ({ ...note, state, error: sentence }));
      });
    },

    /**
     * A request goes back to `pending` without a job (and without its old failure sentence).
     * @param {string} id
     */
    requeue(id) {
      db.run("UPDATE notes SET state = 'pending', job_id = NULL, error = NULL WHERE id = ?", id);
    },

    /**
     * @param {string} id
     * @param {NoteState} state
     * @param {string | null} [error] The sentence of a failed request.
     */
    setState(id, state, error = null) {
      db.run("UPDATE notes SET state = ?, error = ? WHERE id = ?", state, error, id);
    },

    /** @param {string} id */
    remove(id) {
      db.run("DELETE FROM notes WHERE id = ?", id);
    },

    /** @param {string} videoKey */
    removeAll(videoKey) {
      db.run("DELETE FROM notes WHERE video_id = ?", videoKey);
    },
  };
}

/** @typedef {ReturnType<typeof createNotesRepo>} NotesRepo */
