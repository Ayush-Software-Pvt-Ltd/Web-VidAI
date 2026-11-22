// Revisions of a video's project (docs/SPEC.md section 11, Revisions): the folders under
// `<data dir>/projects/<videoKey>/revisions/<n>/`, the rows of the `revisions` table, undo and redo.
//
// Decisions the SPEC leaves open (written down here and in the report):
// - The CURRENT revision is the newest revision that is not undone. The files of the project are
//   that revision's files, unless something changed them outside VidAI (see `service.js`).
// - A HAND STEP is a revision with a user and no job (a hand edit or a restore by a person). Jobs
//   (`jobId` set) and changes made outside VidAI or by the server itself (no user, no job) are
//   BASELINES: undo never goes back across one.
// - `canUndo`: the current revision is a hand step and an older revision exists to go back to.
//   Undo puts the files of the revision before it back and marks it `undone`.
// - `canRedo`: at least one revision is undone. Redo puts the files of the lowest undone revision
//   back and clears its mark.
// - Saving any new revision (a hand edit, a restore, a job) drops the undone ones first, so a new
//   edit after an undo ends the redo history; the new number is above the dropped ones and numbers
//   are never reused (a page holding an old number can never match a different state).
// - A job that saves a revision therefore ends undo history across it: only hand steps made after
//   the job can be undone, back to the job's own revision, not beyond it. Older revisions stay in
//   the list and can be restored as a new revision.
// - The newest `keep` revisions are kept (default 200); older rows and folders go. The current
//   revision and the undone ones above it are never pruned.
//
// Everything here assumes the caller serialises operations per video (`keyedQueue.js`).

import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import { copyRevisionFiles, fingerprint, restoreRevisionFiles } from "./revisionFiles.js";

/** @typedef {import("../db/revisions.js").RevisionRecord} RevisionRecord */

/** How many revisions of a video are kept (SPEC section 11). */
export const REVISIONS_KEPT = 200;

/**
 * @param {RevisionRecord} revision
 * @returns {boolean} Whether undo may step over it.
 */
export function isHandStep(revision) {
  return revision.userId !== null && revision.jobId === null;
}

/**
 * @param {object} deps
 * @param {import("../db/revisions.js").RevisionsRepo} deps.repo
 * @param {string} deps.projectsDir `<data dir>/projects`.
 * @param {number} [deps.keep]
 * @param {import("../log.js").Logger} deps.log
 */
export function createRevisionStore({ repo, projectsDir, keep = REVISIONS_KEPT, log }) {
  /** Fingerprints of revision folders, which never change once written. @type {Map<string, string>} */
  const fingerprints = new Map();

  /** @param {string} videoKey */
  const videoDir = (videoKey) => path.join(projectsDir, videoKey);
  /** @param {string} videoKey @param {number} n */
  const revisionDir = (videoKey, n) => path.join(videoDir(videoKey), "revisions", String(n));

  /** @param {string} videoKey @param {number[]} numbers */
  async function removeFolders(videoKey, numbers) {
    for (const n of numbers) {
      fingerprints.delete(`${videoKey}/${n}`);
      await fsp
        .rm(revisionDir(videoKey, n), { recursive: true, force: true })
        .catch((error) => log.warn(`Could not remove revision ${n} of ${videoKey}: ${error}`));
    }
  }

  const store = {
    videoDir,
    revisionDir,

    /**
     * Where and what undo and redo do now.
     * @param {string} videoKey
     * @returns {{ current: RevisionRecord | null, canUndo: boolean, canRedo: boolean }}
     */
    state(videoKey) {
      const current = repo.current(videoKey) ?? null;
      const canUndo =
        current !== null && isHandStep(current) && repo.before(videoKey, current.n) !== undefined;
      return { current, canUndo, canRedo: repo.nextUndone(videoKey) !== undefined };
    },

    /**
     * Copies the project into a new revision, drops the undone ones and prunes the oldest.
     * @param {string} videoKey
     * @param {string} projectDir
     * @param {{ label: string, userId: string | null, jobId: string | null }} meta
     * @returns {Promise<RevisionRecord>}
     */
    async save(videoKey, projectDir, { label, userId, jobId }) {
      const revisionsDir = path.join(videoDir(videoKey), "revisions");
      await fsp.mkdir(revisionsDir, { recursive: true });
      const staging = path.join(revisionsDir, `.new-${randomBytes(4).toString("hex")}`);
      await fsp.rm(staging, { recursive: true, force: true });
      try {
        await copyRevisionFiles(projectDir, staging);
      } catch (error) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const { revision, dropped } = repo.insert({ videoKey, label, userId, jobId });
      try {
        // A folder left by a crash under this number is not a state anyone knows.
        await fsp.rm(revisionDir(videoKey, revision.n), { recursive: true, force: true });
        await fsp.rename(staging, revisionDir(videoKey, revision.n));
      } catch (error) {
        repo.remove(videoKey, revision.n);
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await removeFolders(videoKey, dropped);
      await removeFolders(videoKey, repo.pruneOldest(videoKey, keep, revision.n));
      return revision;
    },

    /**
     * Puts the files of revision `n` into the project (no row is written).
     * @param {string} videoKey
     * @param {number} n
     * @param {string} projectDir
     */
    async restoreFiles(videoKey, n, projectDir) {
      const from = revisionDir(videoKey, n);
      try {
        await fsp.access(from);
      } catch {
        throw new AppError("conflict", `The saved files of revision ${n} are not there any more.`);
      }
      await restoreRevisionFiles(from, projectDir);
    },

    /**
     * Steps back over the current hand step.
     * @param {string} videoKey
     * @param {string} projectDir
     * @returns {Promise<RevisionRecord | null>} The revision the project is at now; null when nothing can be undone.
     */
    async undo(videoKey, projectDir) {
      const { current, canUndo } = store.state(videoKey);
      if (!canUndo || !current) return null;
      const previous = repo.before(videoKey, current.n);
      if (!previous) return null;
      await store.restoreFiles(videoKey, previous.n, projectDir);
      repo.setUndone(videoKey, current.n, true);
      return previous;
    },

    /**
     * Brings back the lowest undone revision.
     * @param {string} videoKey
     * @param {string} projectDir
     * @returns {Promise<RevisionRecord | null>} The revision the project is at now; null when nothing can be redone.
     */
    async redo(videoKey, projectDir) {
      const next = repo.nextUndone(videoKey);
      if (!next) return null;
      await store.restoreFiles(videoKey, next.n, projectDir);
      repo.setUndone(videoKey, next.n, false);
      return { ...next, undone: false };
    },

    /**
     * Whether the project's files are exactly those of the current revision.
     * @param {string} videoKey
     * @param {string} projectDir
     * @returns {Promise<boolean | null>} null when there is no revision yet.
     */
    async matchesCurrent(videoKey, projectDir) {
      const { current } = store.state(videoKey);
      if (!current) return null;
      const key = `${videoKey}/${current.n}`;
      let saved = fingerprints.get(key);
      if (saved === undefined) {
        saved = await fingerprint(revisionDir(videoKey, current.n));
        fingerprints.set(key, saved);
      }
      return saved === (await fingerprint(projectDir));
    },

    /**
     * Whether the project's files are exactly those of revision `n`.
     * @param {string} videoKey
     * @param {number} n
     * @param {string} projectDir
     * @returns {Promise<boolean>}
     */
    async matches(videoKey, n, projectDir) {
      return (await fingerprint(revisionDir(videoKey, n))) === (await fingerprint(projectDir));
    },

    /**
     * Forgets a video: its rows and its whole folder (revisions and request pictures).
     * @param {string} videoKey
     */
    async removeVideo(videoKey) {
      repo.removeAll(videoKey);
      for (const key of [...fingerprints.keys()]) {
        if (key.startsWith(`${videoKey}/`)) fingerprints.delete(key);
      }
      await fsp.rm(videoDir(videoKey), { recursive: true, force: true });
    },
  };
  return store;
}

/** @typedef {ReturnType<typeof createRevisionStore>} RevisionStore */
