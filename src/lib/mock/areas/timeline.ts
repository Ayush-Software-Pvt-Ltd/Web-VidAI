/**
 * The timeline area: opening a video's project as a timeline, hand edits with undo, redo and the
 * revision list, and change requests, behaving as `server/src/timeline/service.js` does.
 *
 * - A video's project is a `TimelineSim` in `world.timelines` (seeds: `seed/timeline.ts`); the rules
 *   (ripple, limits, revisions, the note check) are in `../timelineEngine.ts`.
 * - Only the owner reaches a video (an admin gets no exception: another user's video is `notFound`).
 * - The lock: while a job is active on the video (queued, running, paused, ...), hand edits, undo,
 *   redo and restore answer `conflict`; `locked` on the timeline names the job.
 * - A change request is `pending` until a timeline job of the video starts (`jobs` area, kind
 *   `timelineEdit`); the tick after the job left the queue it is `running` and holds that job's id. The
 *   server does the same: the queue sets the job `running` first, and `takeNotes` runs a moment later in
 *   the launch, so a request is `pending` while its job waits for a slot (the screen then shows the job's
 *   "Waiting, position N") and for the short launch step after it. When the job completes the clip under the request's frame has changed
 *   (SPEC section 11), a "Change request" revision is saved and the request is `done`; when it fails
 *   or is stopped the request is `failed` (the project is as it was) and `error` holds the job's
 *   sentence, or the stopped sentence when the job has none; every other state has `error: null`,
 *   also a retried one. `world.failJobsWith` makes every run fail. A job stopped while it still
 *   waited leaves its requests `pending` and a new job is asked for. Requests added or retried
 *   while a job works wait and get a new job when it ends.
 * - Preview copies: a seeded video may start with `copies.running`; one copy finishes per tick.
 * - Events: `timeline-changed` and `note-updated` and `preview-copies-changed` go to the owner only.
 * - Not mirrored: clips at a different speed (the wire has no rate), so "plays at a different speed"
 *   is never refused here.
 */
import type { Api } from "../../api";
import type { TimelineNote } from "../../types";
import { makeVideoId } from "../../videoId";
import type { MockCtx } from "../ctx";
import { ensureChannelReachable, ensureReady, isActiveState } from "../rules";
import {
  LOCKED,
  NOTE_STOPPED,
  NO_PROJECT,
  STALE,
  applyChange,
  applyOp,
  clipIds,
  clone,
  currentRevision,
  redoRevision,
  restoreRevision,
  saveRevision,
  undoRevision,
  validateNote,
  viewOf,
  type TimelineSim,
} from "../timelineEngine";
import { nextId, type MockUser } from "../world";
import { ownVideo } from "./library";
import { didFailAtLaunch, enqueue, launchFor } from "./jobs";

export function timelineArea(ctx: MockCtx): Partial<Api> {
  const { world, errors } = ctx;

  const lockOf = (videoId: string) => {
    const job = world.jobs.find((j) => j.view.videoId === videoId && isActiveState(j.view.state));
    return job ? { jobId: job.view.id, kind: job.view.kind } : null;
  };

  /** The project of one of the user's videos (`notFound` for another user's video or no project). */
  function locate(user: MockUser, videoId: string): TimelineSim {
    ownVideo(ctx, user.id, videoId);
    const sim = world.timelines[videoId] as TimelineSim | undefined;
    if (!sim) throw errors.notFound(NO_PROJECT);
    return sim;
  }

  const refuseWhenLocked = (videoId: string) => {
    if (lockOf(videoId)) throw errors.conflict(LOCKED);
  };

  const firstProblem = (sim: TimelineSim) => sim.violations[0]?.message ?? "";

  const emitChanged = (sim: TimelineSim, videoId: string) =>
    ctx.emit(
      "timeline-changed",
      { videoId, revision: sim.timeline.revision },
      { userId: sim.ownerId },
    );

  const emitNote = (sim: TimelineSim, videoId: string, note: TimelineNote, removed: boolean) =>
    ctx.emit("note-updated", { videoId, note: clone(note), removed }, { userId: sim.ownerId });

  const emailOf = (user: MockUser) => user.email;

  /** Asks the job queue for a timeline job for the pending requests (what the server does). */
  function requestEdit(sim: TimelineSim, videoId: string, user: MockUser): void {
    ensureReady(ctx);
    const video = world.videos.find((v) => makeVideoId(v.channelId, v.folderName) === videoId);
    // the server reads the video type through `resolveVideo`, which refuses a lost folder
    if (video) ensureChannelReachable(ctx, video.channelId);
    const job = enqueue(ctx, {
      user,
      videoId,
      kind: "timelineEdit",
      urgent: false,
      request: { noteIds: sim.notes.filter((n) => n.state === "pending").map((n) => n.id) },
      videoType: video?.typeOverride ?? video?.detectedType ?? "long",
      launch: launchFor(world),
    });
    sim.requestedJobId = job.id;
  }

  /**
   * The requested job has left the queue: it takes every pending request (the server's `takeNotes`,
   * called by the job's launch). A job stopped before it ever started, or whose launch failed,
   * takes nothing.
   */
  function takeNotes(sim: TimelineSim, videoId: string): void {
    if (sim.requestedJobId === null) return;
    const job = world.jobs.find((j) => j.view.id === sim.requestedJobId);
    if (!job) {
      sim.requestedJobId = null;
      return;
    }
    if (job.view.state === "queued") return;
    sim.requestedJobId = null;
    if (job.view.startedAt === null || didFailAtLaunch(job)) return;
    for (const note of sim.notes) {
      if (note.state !== "pending") continue;
      note.state = "running";
      note.jobId = job.view.id;
      note.error = null;
      emitNote(sim, videoId, note, false);
    }
  }

  // ---- what the jobs do to the project, one tick behind them ----
  function followJobs(now: number): void {
    for (const [videoId, entry] of Object.entries(world.timelines)) {
      const sim = entry as TimelineSim;
      // A requested job has started since the last tick: it takes every pending request.
      takeNotes(sim, videoId);
      // A job ended: its requests are done or failed.
      const jobIds = new Set(
        sim.notes.filter((n) => n.state === "running" && n.jobId !== null).map((n) => n.jobId),
      );
      for (const jobId of jobIds) {
        const job = world.jobs.find((j) => j.view.id === jobId);
        const state = job?.view.state ?? "failed";
        if (state !== "completed" && state !== "failed" && state !== "stopped") continue;
        const notes = sim.notes.filter((n) => n.state === "running" && n.jobId === jobId);
        if (state === "completed") {
          for (const note of notes) applyChange(sim, note, errors);
          saveRevision(sim, { label: "Change request", userEmail: null, jobId }, now);
          emitChanged(sim, videoId);
        }
        for (const note of notes) {
          note.state = state === "completed" ? "done" : "failed";
          note.error = state === "completed" ? null : (job?.view.error ?? NOTE_STOPPED);
          emitNote(sim, videoId, note, false);
        }
      }
      // The video is free and requests wait: ask for a job again.
      const owner = world.users.find((u) => u.id === sim.ownerId);
      if (
        owner &&
        sim.requestedJobId === null &&
        !lockOf(videoId) &&
        sim.notes.some((n) => n.state === "pending")
      ) {
        try {
          requestEdit(sim, videoId, owner);
        } catch {
          // as the server: logged, the requests stay pending
        }
      }
      // One preview copy per tick.
      if (sim.copies.running && sim.copies.done < sim.copies.total) {
        sim.copies.done += 1;
        if (sim.copies.done >= sim.copies.total) sim.copies.running = false;
        ctx.emit(
          "preview-copies-changed",
          { videoId, copies: { ...sim.copies } },
          { userId: sim.ownerId },
        );
      }
    }
  }
  ctx.ticks.register("timeline", followJobs);

  return {
    openTimeline: ({ videoId }) =>
      ctx.run(() => {
        const sim = locate(ctx.requireUser(), videoId);
        return {
          timeline: sim.unreadable ? null : viewOf(sim, lockOf(videoId)),
          previewUrl: sim.previewUrl,
          violations: clone(sim.violations),
          previewCopies: { ...sim.copies },
        };
      }),

    getTimeline: ({ videoId }) =>
      ctx.run(() => {
        const sim = locate(ctx.requireUser(), videoId);
        if (sim.unreadable) {
          throw errors.notReady(
            `The project cannot be shown: ${firstProblem(sim) || "it has no usable index.html."}`,
          );
        }
        return viewOf(sim, lockOf(videoId));
      }),

    editTimeline: ({ videoId, revision, op }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const sim = locate(user, videoId);
        refuseWhenLocked(videoId);
        if (currentRevision(sim)?.n !== revision) throw errors.conflict(STALE);
        if (sim.unreadable) {
          throw errors.invalidInput(
            `The project cannot be edited by hand: ${firstProblem(sim) || "index.html is missing."}`,
          );
        }
        if (sim.violations.length > 0) {
          throw errors.invalidInput(
            `The project does not follow VidAI's rules yet, so it cannot be edited by hand: ${firstProblem(sim)}`,
          );
        }
        const result = applyOp(sim.timeline, op, errors);
        sim.timeline.tracks = result.tracks;
        sim.timeline.duration = result.duration;
        saveRevision(
          sim,
          { label: result.label, userEmail: emailOf(user), jobId: null },
          ctx.clock.now(),
        );
        emitChanged(sim, videoId);
        return viewOf(sim, null);
      }),

    undoTimeline: ({ videoId }) =>
      ctx.run(() => {
        const sim = locate(ctx.requireUser(), videoId);
        refuseWhenLocked(videoId);
        if (!undoRevision(sim)) throw errors.conflict("There is nothing to undo.");
        emitChanged(sim, videoId);
        return viewOf(sim, null);
      }),

    redoTimeline: ({ videoId }) =>
      ctx.run(() => {
        const sim = locate(ctx.requireUser(), videoId);
        refuseWhenLocked(videoId);
        if (!redoRevision(sim)) throw errors.conflict("There is nothing to redo.");
        emitChanged(sim, videoId);
        return viewOf(sim, null);
      }),

    listRevisions: ({ videoId }) =>
      ctx.run(() => clone(locate(ctx.requireUser(), videoId).revisions).reverse()),

    restoreRevision: ({ videoId, n }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const sim = locate(user, videoId);
        refuseWhenLocked(videoId);
        restoreRevision(sim, n, emailOf(user), ctx.clock.now(), errors);
        emitChanged(sim, videoId);
        return viewOf(sim, null);
      }),

    addTimelineNote: ({ videoId, ...input }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const sim = locate(user, videoId);
        if (sim.unreadable) {
          throw errors.notReady(
            `The project cannot be read, so a change request cannot be placed: ${firstProblem(sim)}`,
          );
        }
        const checked = validateNote(
          input,
          { duration: sim.timeline.duration, clipIds: clipIds(sim.timeline) },
          errors,
        );
        const note: TimelineNote = {
          id: nextId(world, "note"),
          ...checked,
          state: "pending",
          jobId: null,
          error: null,
          createdAt: ctx.clock.now(),
        };
        sim.notes.push(note);
        if (!lockOf(videoId)) {
          try {
            requestEdit(sim, videoId, user);
          } catch (error) {
            sim.notes.pop();
            throw error;
          }
        }
        emitNote(sim, videoId, note, false);
        return clone(note);
      }),

    deleteTimelineNote: ({ videoId, noteId }) =>
      ctx.run(() => {
        const sim = locate(ctx.requireUser(), videoId);
        const note = sim.notes.find((n) => n.id === noteId);
        if (!note) throw errors.notFound("This change request does not exist.");
        if (note.state !== "pending") {
          throw errors.conflict("Only a request that has not started yet can be deleted.");
        }
        sim.notes = sim.notes.filter((n) => n !== note);
        emitNote(sim, videoId, note, true);
        return null;
      }),

    retryTimelineNote: ({ videoId, noteId }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const sim = locate(user, videoId);
        const note = sim.notes.find((n) => n.id === noteId);
        if (!note) throw errors.notFound("This change request does not exist.");
        if (note.state !== "failed")
          throw errors.conflict("Only a failed request can be sent again.");
        const failedWith = { jobId: note.jobId, error: note.error };
        note.state = "pending";
        note.jobId = null;
        note.error = null;
        if (!lockOf(videoId)) {
          try {
            requestEdit(sim, videoId, user);
          } catch (error) {
            // back to failed with the sentence it had before this retry
            note.state = "failed";
            note.jobId = failedWith.jobId;
            note.error = failedWith.error;
            throw error;
          }
        }
        emitNote(sim, videoId, note, false);
        return clone(note);
      }),
  };
}
