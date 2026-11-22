// The timeline service (docs/SPEC.md section 11): reading the project as a `Timeline`, hand edits,
// revisions with undo and redo, and change requests. Everything that changes a video's project runs
// through one queue per video, so operations never interleave.
//
// Rules decided here where the SPEC is silent (also listed in the report):
// - The project is `<video folder>/output/<video folder name>.hf/`; its real path must lie inside the
//   video's real folder (the agent writes there, a link out of it is not a project). Without
//   `index.html` the video has no project: `notFound`.
// - Reading: `getTimeline` and `openTimeline` compare the project's files with the current revision.
//   When they differ and no job holds the project, a baseline revision "Changed outside VidAI" is
//   saved (no user, no job; undo does not cross it) so the revision number the page holds names the
//   state it sees. A project with no revision at all gets the baseline "Existing project". While a
//   job holds the project nothing is saved (the files are in flux; the job saves its own revision).
// - A project that cannot be read at all (no root, no usable `edit.json`) has no `Timeline`:
//   `getTimeline` answers `notReady` with the first reason, `openTimeline` answers `timeline: null`
//   with the violations. A project that breaks the profile elsewhere is shown, with `violations`.
// - A hand edit, an undo, a redo and a restore are refused with `conflict` while a job of the video is
//   active (`activeJob`); a stale revision number is `conflict` as well.
// - Change requests: a frame must be inside the video, an ellipse centre inside the frame, radii
//   above 0 and at most 1; they are accepted while a job runs. When asking for the edit fails, an
//   added or retried request is put back as it was and the error reaches the user.

import fsp from "node:fs/promises";
import path from "node:path";
import { AppError, conflict, invalidInput, notFound, notReady } from "../errors.js";
import { clipsAtFrame } from "./clipsAt.js";
import { parseProject } from "./document.js";
import { writeEditFiles } from "./editFiles.js";
import { applyOp } from "./edits.js";
import { framesToSeconds } from "./frames.js";
import { createKeyedQueue } from "./keyedQueue.js";
import { toTimeline } from "./model.js";
import { toNoteView, validateNote } from "./notes.js";
import { checkDocument, loadProject } from "./profile.js";
import { writeFileSafely } from "./revisionFiles.js";
import { createRevisionStore } from "./revisions.js";

/** @typedef {import("../../../src/lib/wire/timeline.ts").Timeline} Timeline */
/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineNote} TimelineNote */
/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineOp} TimelineOp */
/** @typedef {import("../../../src/lib/wire/timeline.ts").RevisionView} RevisionView */
/** @typedef {import("../../../src/lib/wire/timeline.ts").OpenTimelineResult} OpenTimelineResult */
/** @typedef {import("../../../src/lib/wire/timeline.ts").ProjectViolation} ProjectViolation */
/** @typedef {import("../db/revisions.js").RevisionRecord} RevisionRecord */
/** @typedef {import("../db/notes.js").NoteRecord} NoteRecord */
/** @typedef {import("./clipsAt.js").ClipAt} ClipAt */

/**
 * @typedef {object} PromptNote A taken change request with what the message to the agent needs.
 * @property {string} id
 * @property {number} frame
 * @property {number | null} seconds The time of the frame; null when the frame rate is unknown.
 * @property {import("../../../src/lib/wire/timeline.ts").NoteShape | null} shape
 * @property {string | null} elementId
 * @property {string} prompt
 * @property {string | null} author The writer's email; null when the account is gone.
 * @property {number} createdAt
 * @property {string} folder Where the frame pictures of this request go (`projects/<videoKey>/notes/<id>/`).
 */

/**
 * @typedef {object} ServiceDeps
 * @property {import("../db/revisions.js").RevisionsRepo} revisionsRepo
 * @property {import("../db/notes.js").NotesRepo} notesRepo
 * @property {{ byId(id: string): { email: string } | null | undefined }} users
 * @property {{ videoByWireId(userId: string, videoId: unknown): Promise<{ key: string, dir: string, channelDir: string, folderName: string, channel: { id: string } }>, describeKey(key: string): { videoId: string, userId: string } | undefined }} library
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {import("../log.js").Logger} log
 * @property {string} projectsDir `<data dir>/projects`.
 * @property {(videoKey: string) => { id: string, kind: import("../../../src/lib/wire/jobs.ts").JobKind } | null} activeJob
 * @property {(request: { videoKey: string, userId: string }) => void | Promise<void>} requestTimelineEdit
 * @property {{ open(request: { sessionId: string, userId: string, videoKey: string, projectDir: string, videoDir: string, channelDir: string }): Promise<{ url: string }> | { url: string } } | null} preview
 * @property {(projectDir: string) => Promise<import("./check.js").CheckResult>} check
 * @property {{ ensureFor(videoKey: string, projectDir: string, scope: { videoDir: string, channelDir: string, videoId: string, userId: string }, options?: { first?: boolean }): Promise<unknown>, state(videoKey: string): import("../../../src/lib/wire/timeline.ts").PreviewCopiesState } | null} [previewCopies]
 *   Preview copies of heavy media (`proxy.js`): asked for when a timeline opens and after a job.
 * @property {number} [keep] Revisions kept per video (default 200).
 */

const STALE = "The video changed since you opened it. Reload the timeline and try again.";
const NO_PROJECT =
  "This video has no project to open yet. Edit the video first, then open its timeline.";

/** @param {ServiceDeps} deps */
export function createTimelineService(deps) {
  const { revisionsRepo, notesRepo, users, library, events, log, projectsDir, activeJob } = deps;
  const queue = createKeyedQueue();
  const revisions = createRevisionStore({
    repo: revisionsRepo,
    projectsDir,
    log,
    ...(deps.keep === undefined ? {} : { keep: deps.keep }),
  });

  /**
   * @typedef {object} Location
   * @property {string} key The video key.
   * @property {string} videoId `<channelId>/<folder name>`.
   * @property {string} ownerId
   * @property {string} dir The video folder.
   * @property {string} channelDir
   * @property {string} projectDir `<dir>/output/<folder name>.hf`, not yet checked.
   */

  /**
   * @param {string} userId
   * @param {unknown} videoId
   * @returns {Promise<Location>}
   */
  async function locate(userId, videoId) {
    const found = await library.videoByWireId(userId, videoId);
    return {
      key: found.key,
      videoId: `${found.channel.id}/${found.folderName}`,
      ownerId: userId,
      dir: found.dir,
      channelDir: found.channelDir,
      projectDir: path.join(found.dir, "output", `${found.folderName}.hf`),
    };
  }

  /** @param {string} videoKey @returns {Promise<Location>} */
  async function locateKey(videoKey) {
    const described = library.describeKey(videoKey);
    if (!described) throw notFound("This video does not exist any more.");
    return locate(described.userId, described.videoId);
  }

  /**
   * After a job the project may have new media: lets the preview copies look again (not awaited,
   * never fails).
   * @param {string} videoKey
   */
  async function ensureCopies(videoKey) {
    if (!deps.previewCopies) return;
    try {
      const loc = await locateKey(videoKey);
      await deps.previewCopies.ensureFor(
        videoKey,
        await resolveProject(loc),
        {
          videoDir: loc.dir,
          channelDir: loc.channelDir,
          videoId: loc.videoId,
          userId: loc.ownerId,
        },
        {},
      );
    } catch {
      // The video is gone or has no project yet: nothing to prepare.
    }
  }

  /**
   * The project's real folder: inside the real video folder and with an `index.html`.
   * @param {Location} loc
   * @returns {Promise<string>}
   * @throws {AppError} `notFound`.
   */
  async function resolveProject(loc) {
    try {
      const real = await fsp.realpath(loc.projectDir);
      const videoReal = await fsp.realpath(loc.dir);
      const inside = path.relative(videoReal, real);
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error();
      if (!(await fsp.stat(path.join(real, "index.html"))).isFile()) throw new Error();
      return real;
    } catch {
      throw notFound(NO_PROJECT);
    }
  }

  /** @param {string} videoKey @returns {import("../../../src/lib/wire/timeline.ts").TimelineLock | null} */
  function lockOf(videoKey) {
    const job = activeJob(videoKey);
    return job ? { jobId: job.id, kind: job.kind } : null;
  }

  /** @param {string} videoKey */
  function refuseWhenLocked(videoKey) {
    if (lockOf(videoKey)) {
      throw conflict(
        "The video is being edited right now, so the timeline cannot be changed by hand until that edit ends.",
      );
    }
  }

  /** @param {Location} loc @param {number} revision */
  function emitChanged(loc, revision) {
    events.emit({
      event: "timeline-changed",
      payload: { videoId: loc.videoId, revision },
      userId: loc.ownerId,
      admins: false,
    });
  }

  /**
   * @param {string} videoKey
   * @param {NoteRecord} note
   * @param {boolean} removed
   */
  function emitNote(videoKey, note, removed) {
    const owner = library.describeKey(videoKey);
    if (!owner) return;
    events.emit({
      event: "note-updated",
      payload: { videoId: owner.videoId, note: toNoteView(note), removed },
      userId: owner.userId,
      admins: false,
    });
  }

  /**
   * Saves a baseline revision when the project's files are not those of the current revision (or
   * there is no revision yet), unless a job holds the project.
   * @param {Location} loc
   * @param {string} projectDir
   */
  async function syncBaseline(loc, projectDir) {
    if (lockOf(loc.key)) return;
    const same = await revisions.matchesCurrent(loc.key, projectDir);
    if (same === true) return;
    const label = same === null ? "Existing project" : "Changed outside VidAI";
    const saved = await revisions.save(loc.key, projectDir, { label, userId: null, jobId: null });
    if (same === false) emitChanged(loc, saved.n);
  }

  /** @param {string} videoKey @returns {TimelineNote[]} */
  const notesOf = (videoKey) => notesRepo.listForVideo(videoKey).map(toNoteView);

  /**
   * The timeline of the project as it is on disk now, with its violations; `timeline` is null when
   * the project cannot be read at all.
   * @param {Location} loc
   * @param {string} projectDir
   * @returns {Promise<{ timeline: Timeline | null, violations: ProjectViolation[] }>}
   */
  async function readView(loc, projectDir) {
    const loaded = await loadProject(projectDir);
    if (!loaded.parsed?.root || !loaded.facts) {
      return { timeline: null, violations: loaded.violations };
    }
    const { current, canUndo, canRedo } = revisions.state(loc.key);
    return {
      timeline: toTimeline(loaded.parsed, loaded.facts, {
        revision: current?.n ?? 0,
        notes: notesOf(loc.key),
        canUndo,
        canRedo,
        locked: lockOf(loc.key),
      }),
      violations: loaded.violations,
    };
  }

  /** @param {Location} loc @param {string} projectDir @returns {Promise<Timeline>} */
  async function timelineOrThrow(loc, projectDir) {
    const { timeline, violations } = await readView(loc, projectDir);
    if (!timeline) {
      throw notReady(
        `The project cannot be shown: ${violations[0]?.message ?? "it has no usable index.html."}`,
      );
    }
    return timeline;
  }

  /**
   * Runs one operation on the project of a video: queued, the project found, the baseline saved.
   * @template T
   * @param {Location} loc
   * @param {(projectDir: string) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  function inProject(loc, operation) {
    return queue.run(loc.key, async () => {
      const projectDir = await resolveProject(loc);
      await syncBaseline(loc, projectDir);
      return operation(projectDir);
    });
  }

  /** @param {Location} loc @param {RevisionRecord} saved */
  const finished = (loc, saved) => emitChanged(loc, saved.n);

  /**
   * @param {string} videoKey
   * @param {RevisionRecord[]} rows
   * @returns {RevisionView[]}
   */
  function revisionViews(videoKey, rows) {
    const currentN = revisions.state(videoKey).current?.n ?? null;
    /** @type {Map<string, string | null>} */
    const emails = new Map();
    /** @param {string | null} userId */
    const emailOf = (userId) => {
      if (userId === null) return null;
      if (!emails.has(userId)) emails.set(userId, users.byId(userId)?.email ?? null);
      return emails.get(userId) ?? null;
    };
    return rows
      .map((row) => ({
        n: row.n,
        label: row.label,
        userEmail: emailOf(row.userId),
        jobId: row.jobId,
        createdAt: row.createdAt,
        current: row.n === currentN,
        undone: row.undone,
      }))
      .reverse();
  }

  /**
   * Asks for an edit job for the pending requests of a video; what the job manager refuses with
   * (not ready, queue full) passes through.
   * @param {string} videoKey
   * @param {string} userId
   */
  async function requestEdit(videoKey, userId) {
    await deps.requestTimelineEdit({ videoKey, userId });
  }

  const service = {
    /**
     * @param {string} userId
     * @param {string} videoId
     * @returns {Promise<Timeline>}
     */
    async getTimeline(userId, videoId) {
      const loc = await locate(userId, videoId);
      return inProject(loc, (projectDir) => timelineOrThrow(loc, projectDir));
    },

    /**
     * @param {{ userId: string, sessionId: string }} who
     * @param {string} videoId
     * @returns {Promise<OpenTimelineResult>}
     */
    async openTimeline(who, videoId) {
      const loc = await locate(who.userId, videoId);
      const { projectDir, view } = await inProject(loc, async (dir) => ({
        projectDir: dir,
        view: await readView(loc, dir),
      }));
      const opened = deps.preview
        ? await deps.preview.open({
            sessionId: who.sessionId,
            userId: who.userId,
            videoKey: loc.key,
            projectDir,
            videoDir: loc.dir,
            channelDir: loc.channelDir,
          })
        : null;
      const copies = deps.previewCopies ?? null;
      if (copies) {
        void copies
          .ensureFor(
            loc.key,
            projectDir,
            {
              videoDir: loc.dir,
              channelDir: loc.channelDir,
              videoId: loc.videoId,
              userId: loc.ownerId,
            },
            { first: true },
          )
          .catch(() => {});
      }
      return {
        timeline: view.timeline,
        previewUrl: opened?.url ?? null,
        violations: view.violations,
        previewCopies: copies ? copies.state(loc.key) : { total: 0, done: 0, running: false },
      };
    },

    /**
     * One hand edit (SPEC section 11): checked against the profile before anything is written.
     * @param {string} userId
     * @param {string} videoId
     * @param {number} revision The revision the page has.
     * @param {TimelineOp} op
     * @returns {Promise<Timeline>}
     */
    async editTimeline(userId, videoId, revision, op) {
      const loc = await locate(userId, videoId);
      return inProject(loc, async (projectDir) => {
        refuseWhenLocked(loc.key);
        const { current } = revisions.state(loc.key);
        if (!current || current.n !== revision) throw conflict(STALE);
        const loaded = await loadProject(projectDir);
        if (loaded.html === null || !loaded.facts) {
          throw invalidInput(
            `The project cannot be edited by hand: ${loaded.violations[0]?.message ?? "index.html is missing."}`,
          );
        }
        const { html, label, files, facts } = applyOp(loaded.html, op, loaded.facts);
        // applyOp checks its own result; this is the last gate before a write.
        const broken = checkDocument(parseProject(html), facts);
        if (broken.length > 0) {
          throw new AppError(
            "internal",
            `The edit would have broken the project's rules (${broken[0]?.message ?? ""}); nothing was changed.`,
          );
        }
        const file = path.join(projectDir, "index.html");
        // The composition files of a B-roll with motion first, then the root.
        const undoFiles = await writeEditFiles(projectDir, files);
        let saved;
        try {
          await writeFileSafely(file, html);
          saved = await revisions.save(loc.key, projectDir, { label, userId, jobId: null });
        } catch (error) {
          await writeFileSafely(file, loaded.html).catch(() => {});
          await undoFiles();
          throw error;
        }
        finished(loc, saved);
        return timelineOrThrow(loc, projectDir);
      });
    },

    /**
     * @param {string} userId
     * @param {string} videoId
     * @returns {Promise<Timeline>}
     */
    async undoTimeline(userId, videoId) {
      const loc = await locate(userId, videoId);
      return inProject(loc, async (projectDir) => {
        refuseWhenLocked(loc.key);
        const now = await revisions.undo(loc.key, projectDir);
        if (!now) throw conflict("There is nothing to undo.");
        finished(loc, now);
        return timelineOrThrow(loc, projectDir);
      });
    },

    /**
     * @param {string} userId
     * @param {string} videoId
     * @returns {Promise<Timeline>}
     */
    async redoTimeline(userId, videoId) {
      const loc = await locate(userId, videoId);
      return inProject(loc, async (projectDir) => {
        refuseWhenLocked(loc.key);
        const now = await revisions.redo(loc.key, projectDir);
        if (!now) throw conflict("There is nothing to redo.");
        finished(loc, now);
        return timelineOrThrow(loc, projectDir);
      });
    },

    /**
     * The revisions of a video, newest first.
     * @param {string} userId
     * @param {string} videoId
     * @returns {Promise<RevisionView[]>}
     */
    async listRevisions(userId, videoId) {
      const loc = await locate(userId, videoId);
      await resolveProject(loc);
      return revisionViews(loc.key, revisionsRepo.list(loc.key));
    },

    /**
     * Puts revision `n` back and saves that as a new revision "Restored revision n".
     * @param {string} userId
     * @param {string} videoId
     * @param {number} n
     * @returns {Promise<Timeline>}
     */
    async restoreRevision(userId, videoId, n) {
      const loc = await locate(userId, videoId);
      return inProject(loc, async (projectDir) => {
        refuseWhenLocked(loc.key);
        const row = revisionsRepo.get(loc.key, n);
        if (!row) throw notFound(`Revision ${n} does not exist; it may have been removed.`);
        if (revisions.state(loc.key).current?.n === n) {
          throw invalidInput(`Revision ${n} is the one the video is at now.`);
        }
        await revisions.restoreFiles(loc.key, n, projectDir);
        const saved = await revisions.save(loc.key, projectDir, {
          label: `Restored revision ${n}`,
          userId,
          jobId: null,
        });
        finished(loc, saved);
        return timelineOrThrow(loc, projectDir);
      });
    },

    /**
     * @param {string} userId
     * @param {string} videoId
     * @param {unknown} input `{ frame, shape, elementId, prompt }`
     * @returns {Promise<TimelineNote>}
     */
    async addNote(userId, videoId, input) {
      const loc = await locate(userId, videoId);
      const projectDir = await resolveProject(loc);
      const loaded = await loadProject(projectDir);
      const duration = loaded.parsed?.root?.duration ?? null;
      if (!loaded.parsed || duration === null) {
        throw notReady(
          `The project cannot be read, so a change request cannot be placed: ${loaded.violations[0]?.message ?? ""}`,
        );
      }
      const clipIds = new Set(loaded.parsed.clips.flatMap((clip) => (clip.id ? [clip.id] : [])));
      const checked = validateNote(input, { duration, clipIds });
      const note = notesRepo.insert({ videoKey: loc.key, userId, ...checked });
      if (!activeJob(loc.key)) {
        try {
          await requestEdit(loc.key, userId);
        } catch (error) {
          notesRepo.remove(note.id);
          throw error;
        }
      }
      emitNote(loc.key, note, false);
      return toNoteView(note);
    },

    /**
     * Deletes a pending request.
     * @param {string} userId
     * @param {string} videoId
     * @param {string} noteId
     * @returns {Promise<void>}
     */
    async deleteNote(userId, videoId, noteId) {
      const loc = await locate(userId, videoId);
      const note = notesRepo.byId(noteId);
      if (!note || note.videoKey !== loc.key) throw notFound("This change request does not exist.");
      if (note.state !== "pending") {
        throw conflict("Only a request that has not started yet can be deleted.");
      }
      notesRepo.remove(note.id);
      emitNote(loc.key, note, true);
    },

    /**
     * Sends a failed request again.
     * @param {string} userId
     * @param {string} videoId
     * @param {string} noteId
     * @returns {Promise<TimelineNote>}
     */
    async retryNote(userId, videoId, noteId) {
      const loc = await locate(userId, videoId);
      const note = notesRepo.byId(noteId);
      if (!note || note.videoKey !== loc.key) throw notFound("This change request does not exist.");
      if (note.state !== "failed") throw conflict("Only a failed request can be sent again.");
      notesRepo.requeue(note.id);
      if (!activeJob(loc.key)) {
        try {
          await requestEdit(loc.key, userId);
        } catch (error) {
          // Back to failed with the sentence it had before this retry.
          notesRepo.setState(note.id, "failed", note.error);
          throw error;
        }
      }
      const again = { ...note, state: /** @type {const} */ ("pending"), jobId: null, error: null };
      emitNote(loc.key, again, false);
      return toNoteView(again);
    },

    /**
     * What the job manager (written later) uses; plain functions on video keys, no user checks.
     */
    api: {
      /**
       * The project folder of a video (it may not exist yet).
       * @param {string} videoKey
       * @returns {Promise<string>}
       */
      async projectDir(videoKey) {
        return (await locateKey(videoKey)).projectDir;
      },

      /**
       * Whether the video has a project (an `index.html` inside the video's folder).
       * @param {string} videoKey
       * @returns {Promise<boolean>}
       */
      async projectExists(videoKey) {
        try {
          await resolveProject(await locateKey(videoKey));
          return true;
        } catch {
          return false;
        }
      },

      /**
       * The whole check of SPEC section 10: the profile plus `hyperframes lint`. A lint that could
       * not run is logged, never a violation.
       * @param {string} videoKey
       * @returns {Promise<{ violations: string[] }>}
       */
      async check(videoKey) {
        const loc = await locateKey(videoKey);
        const result = await deps.check(loc.projectDir);
        if (result.lintProblem !== null)
          log.warn(`Lint did not run for ${videoKey}: ${result.lintProblem}`);
        return { violations: result.violations };
      },

      /**
       * Saves the project as a new revision (a job's end). With `onlyIfChanged` nothing is saved
       * when the files are those of the current revision, and the current revision is returned.
       * @param {string} videoKey
       * @param {{ label: string, userId: string | null, jobId: string | null, onlyIfChanged?: boolean }} meta
       * @returns {Promise<RevisionRecord>}
       */
      async saveRevision(videoKey, { label, userId, jobId, onlyIfChanged = false }) {
        const loc = await locateKey(videoKey);
        return queue.run(loc.key, async () => {
          const projectDir = await resolveProject(loc);
          if (onlyIfChanged && (await revisions.matchesCurrent(loc.key, projectDir)) === true) {
            const { current } = revisions.state(loc.key);
            if (current) return current;
          }
          const saved = await revisions.save(loc.key, projectDir, { label, userId, jobId });
          emitChanged(loc, saved.n);
          return saved;
        });
      },

      /**
       * Puts revision `n` back and saves that as a new baseline revision (no user, no job); for a
       * job that failed or was stopped. No lock check: the job manager calls it when the job is over.
       * @param {string} videoKey
       * @param {number} n
       * @returns {Promise<RevisionRecord>}
       */
      async restoreTo(videoKey, n) {
        const loc = await locateKey(videoKey);
        return queue.run(loc.key, async () => {
          const projectDir = await resolveProject(loc);
          if (!revisionsRepo.get(loc.key, n)) throw notFound(`Revision ${n} does not exist.`);
          await revisions.restoreFiles(loc.key, n, projectDir);
          const saved = await revisions.save(loc.key, projectDir, {
            label: `Restored revision ${n}`,
            userId: null,
            jobId: null,
          });
          emitChanged(loc, saved.n);
          return saved;
        });
      },

      /**
       * The revision the project is at (the newest not undone), or null when none was saved.
       * @param {string} videoKey
       * @returns {RevisionRecord | null}
       */
      latestRevision(videoKey) {
        return revisions.state(videoKey).current;
      },

      /** @param {string} videoKey @returns {TimelineNote[]} */
      pendingNotes(videoKey) {
        return notesRepo.pending(videoKey).map(toNoteView);
      },

      /**
       * A job takes every pending request of its video: they become `running` and belong to it.
       * @param {string} videoKey
       * @param {string} jobId
       * @returns {Promise<PromptNote[]>}
       */
      async takeNotes(videoKey, jobId) {
        const taken = notesRepo.take(videoKey, jobId);
        for (const note of taken) emitNote(videoKey, note, false);
        /** @type {import("./frames.js").Fps | null} */
        let fps = null;
        if (taken.length > 0) {
          try {
            fps = (await loadProject((await locateKey(videoKey)).projectDir)).facts?.fps ?? null;
          } catch {
            fps = null;
          }
        }
        const emails = new Map(
          taken.map((note) => [note.userId, users.byId(note.userId)?.email ?? null]),
        );
        return taken.map((note) => ({
          id: note.id,
          frame: note.frame,
          seconds: fps ? framesToSeconds(note.frame, fps) : null,
          shape: note.shape,
          elementId: note.elementId,
          prompt: note.prompt,
          author: emails.get(note.userId) ?? null,
          createdAt: note.createdAt,
          folder: service.api.noteDir(videoKey, note.id),
        }));
      },

      /**
       * The running requests of a job end; a failed one keeps `error`, the sentence of the job.
       * @param {string} jobId
       * @param {"done" | "failed"} state
       * @param {string | null} [error]
       * @returns {TimelineNote[]}
       */
      finishNotes(jobId, state, error = null) {
        const changed = notesRepo.finish(jobId, state, error);
        for (const note of changed) emitNote(note.videoKey, note, false);
        return changed.map(toNoteView);
      },

      /**
       * A job of the video ended: when requests are waiting, asks for an edit job for them.
       * @param {string} videoKey
       * @returns {Promise<void>}
       */
      async videoFreed(videoKey) {
        void ensureCopies(videoKey);
        const waiting = notesRepo.pending(videoKey);
        const first = waiting[0];
        if (!first || activeJob(videoKey)) return;
        try {
          await requestEdit(videoKey, first.userId);
        } catch (error) {
          log.warn(`Could not queue the change requests of ${videoKey}: ${error}`);
        }
      },

      /**
       * The clips under a frame, from the top track down (pictures first, sound last).
       * @param {string} videoKey
       * @param {number} frame
       * @returns {Promise<ClipAt[]>} Empty when the project cannot be read.
       */
      async clipsAt(videoKey, frame) {
        try {
          const loc = await locateKey(videoKey);
          const loaded = await loadProject(await resolveProject(loc));
          return loaded.parsed ? clipsAtFrame(loaded.parsed, frame) : [];
        } catch {
          return [];
        }
      },

      /**
       * Where the frame pictures of a request go: `projects/<videoKey>/notes/<id>/` (the pictures
       * themselves are written by the job manager).
       * @param {string} videoKey
       * @param {string} noteId
       * @returns {string}
       */
      noteDir(videoKey, noteId) {
        return path.join(revisions.videoDir(videoKey), "notes", noteId);
      },

      /**
       * Forgets a video: its revisions, request pictures and requests.
       * @param {string} videoKey
       * @returns {Promise<void>}
       */
      removeVideo(videoKey) {
        return queue.run(videoKey, async () => {
          notesRepo.removeAll(videoKey);
          await revisions.removeVideo(videoKey);
        });
      },
    },
  };
  return service;
}

/** @typedef {ReturnType<typeof createTimelineService>} TimelineService */
