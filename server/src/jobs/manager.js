// The job manager (docs/SPEC.md section 8): owns a job's life from the click to its end and ties
// the queue, the driver, the harness, the limits, the library and the timeline together. The parts
// are `managerLaunch.js` (a launch), `managerOutcome.js` (an end), `managerSession.js` (which setup
// and session), `managerRecovery.js` (start-up and shutdown) and `managerRuns.js`.

import { AppError, conflict, invalidInput, notFound } from "../errors.js";
import { bounded } from "./managerRuns.js";
import { createLauncher } from "./managerLaunch.js";
import { createOutcomes } from "./managerOutcome.js";
import { createRecovery } from "./managerRecovery.js";
import { ensureLaunchable } from "./managerSession.js";
import { selectSlots } from "./prompt.js";

/** @typedef {import("./managerTypes.js").JobRecord} JobRecord */
/** @typedef {{ id: string, role: "admin" | "user" }} Actor */

export const RE_EDIT_MAX_CHARS = 8000;

/** What a refused action says, by what stands in the way (the library's actions are the rule). */
const STATE_WORDS = {
  queued: "waiting to start",
  running: "running",
  pausing: "being paused",
  paused: "paused",
  stopping: "being stopped",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
};

const noAroll = () => invalidInput("This video has no A-roll yet. Add the video file first.");

/**
 * @param {import("./managerDeps.js").ManagerDeps} d
 */
export function createJobManager(d) {
  const { jobs, videos, queues, limits, library, timeline, harness, runs } = d;
  const outcomes = createOutcomes(d);
  // Jobs a Continue just put back in the queue: their start is logged as "continued", not "started".
  /** @type {Set<string>} */
  const justContinued = new Set();
  const launcher = createLauncher(d, outcomes, justContinued);
  const recovery = createRecovery(d, outcomes);

  /** @param {string} jobId */
  const viewOf = (jobId) => {
    const row = jobs.get(jobId);
    if (!row) throw notFound("This job does not exist.");
    return queues.view(row);
  };

  /**
   * The job when the user may act on it: the owner, an admin, or the owner of the video.
   * @param {Actor} user
   * @param {string} jobId
   * @returns {JobRecord}
   */
  function access(user, jobId) {
    const job = jobs.get(jobId);
    if (!job) throw notFound("This job does not exist.");
    if (job.userId === user.id || user.role === "admin") return job;
    if (library.describeKey(job.videoKey)?.userId === user.id) return job;
    throw notFound("This job does not exist.");
  }

  /**
   * The video of a new job, with the library's own answer whether the action is offered.
   * @param {Actor} user
   * @param {string} videoId
   * @param {"startEdit" | "reEdit"} action
   */
  async function offered(user, videoId, action) {
    const view = await library.videoView(user.id, user.role, videoId);
    if (view.actions.includes(action)) {
      // The library's actions do not look for the A-roll; an edit cannot start without it.
      if (action === "startEdit" && view.arollCount === 0) throw noAroll();
      return view;
    }
    if (view.job !== null) throw conflict("This video already has an edit in progress.");
    if (view.uploading) throw conflict("Wait until the upload of this video has finished.");
    if (action === "startEdit" && view.edited) {
      throw conflict("This video already has an edit. Use Re-Edit to change it.");
    }
    if (action === "reEdit")
      throw conflict("This video has no edit to change yet. Start an edit first.");
    throw noAroll();
  }

  /**
   * Disk Cleanup deletes the working files of a video (SPEC section 13): no job may start on them.
   * @param {string} videoKey
   */
  function refuseWhileBusy(videoKey) {
    if (d.isBusy?.(videoKey)) {
      throw conflict("The working files of this video are being deleted. Try again in a moment.");
    }
  }

  /**
   * @param {Actor} user
   * @param {{ videoId: string, urgent: boolean }} input
   */
  async function startEdit(user, { videoId, urgent }) {
    await offered(user, videoId, "startEdit");
    await harness.ensureReady({});
    const video = await library.videoByWireId(user.id, videoId);
    refuseWhileBusy(video.key);
    const { videoType } = await library.resolveVideoType(user.id, videoId);
    const inputs = video.row.inputs;
    // An empty prompt is refused at the click, not after the wait in the queue.
    selectSlots(video.channel[videoType], inputs.promptSlot, inputs.styleSlot, videoType);
    const launch = harness.launchFor();
    // A new edit never reuses a session (SPEC section 8).
    videos.clearSession(video.key);
    return queues.enqueue({
      videoKey: video.key,
      userId: user.id,
      kind: "edit",
      urgent,
      setup: launch.setup,
      harness: launch.program,
      model: launch.model,
      effort: launch.effort,
      videoType,
      request: {},
    });
  }

  /**
   * @param {Actor} user
   * @param {{ videoId: string, text: string, urgent: boolean }} input
   */
  async function reEdit(user, { videoId, text, urgent }) {
    const changes = text.trim();
    if (changes === "") throw invalidInput("Write what should change.");
    if (changes.length > RE_EDIT_MAX_CHARS) {
      throw invalidInput(`Keep the text under ${RE_EDIT_MAX_CHARS} characters.`);
    }
    await offered(user, videoId, "reEdit");
    await harness.ensureReady({});
    const video = await library.videoByWireId(user.id, videoId);
    refuseWhileBusy(video.key);
    const { videoType } = await library.resolveVideoType(user.id, videoId);
    // The video's session was made on some setup; go on there (the launch falls back when it
    // cannot), else on the current setup.
    const row = video.row;
    const last =
      row.sessionId === null
        ? undefined
        : jobs.history(video.key, 20).find((j) => j.harness === row.sessionHarness && j.setup);
    const launch = harness.launchFor(last?.setup ?? undefined);
    return queues.enqueue({
      videoKey: video.key,
      userId: user.id,
      kind: "reEdit",
      urgent,
      setup: launch.setup,
      harness: launch.program,
      model: last?.model ?? launch.model,
      effort: last?.effort ?? launch.effort,
      videoType,
      request: { text: changes },
    });
  }

  /**
   * A change request for a video of the timeline: a `timelineEdit` job unless the video has an
   * active job (the requests then wait for the next one).
   * @param {{ videoKey: string, userId: string }} request
   * @returns {Promise<import("../../../src/lib/wire/jobs.ts").JobView | null>}
   */
  async function requestTimelineEdit({ videoKey, userId }) {
    if (jobs.activeForVideo(videoKey)) return null;
    await harness.ensureReady({});
    const described = library.describeKey(videoKey);
    if (!described) throw notFound("This video does not exist.");
    const { videoType } = await library.resolveVideoType(described.userId, described.videoId);
    const launch = harness.launchFor();
    return queues.enqueue({
      videoKey,
      userId,
      kind: "timelineEdit",
      setup: launch.setup,
      harness: launch.program,
      model: launch.model,
      effort: launch.effort,
      videoType,
      request: {},
    });
  }

  /**
   * @param {Actor} user
   * @param {{ jobId: string }} input
   */
  function pauseJob(user, { jobId }) {
    const job = access(user, jobId);
    if (job.kind === "render") {
      throw conflict("A final render cannot be paused. You can stop it instead.");
    }
    if (job.state !== "running") {
      throw conflict(`This job cannot be paused: it is ${STATE_WORDS[job.state]}.`);
    }
    if (!jobs.transition(jobId, ["running"], "pausing")) {
      throw conflict("This job cannot be paused any more.");
    }
    limits.resumeAll(jobId);
    runs.get(jobId)?.pause();
    queues.changed(jobId);
    return viewOf(jobId);
  }

  /**
   * @param {Actor} user
   * @param {{ jobId: string }} input
   */
  async function continueJob(user, { jobId }) {
    const job = access(user, jobId);
    if (job.state !== "paused" && job.state !== "failed") {
      throw conflict(`This job cannot be continued: it is ${STATE_WORDS[job.state]}.`);
    }
    await ensureLaunchable(job, harness);
    const row = videos.byKey(job.videoKey);
    const resume = typeof row?.sessionId === "string" && row.sessionHarness === job.harness;
    if (job.state === "failed" && job.kind !== "render") {
      const request = typeof job.request === "object" && job.request ? job.request : {};
      jobs.setRequest(jobId, { ...request, afterFailure: job.kind });
    }
    // Marked BEFORE the requeue: the job can be launched inside it, and `logStart` must already
    // know that this start is a Continue (it logs "Continued", not a second "Started").
    justContinued.add(jobId);
    /** @type {ReturnType<typeof queues.requeue>} */
    let view;
    try {
      view = queues.requeue(jobId, { resume: job.kind === "render" ? false : resume });
    } catch (error) {
      justContinued.delete(jobId);
      throw error;
    }
    d.editLog?.record({
      userId: job.userId,
      videoKey: job.videoKey,
      event: "continued",
      message: "Continued",
    });
    return view;
  }

  /**
   * @param {Actor} user
   * @param {{ jobId: string }} input
   */
  async function stopJob(user, { jobId }) {
    const job = access(user, jobId);
    switch (job.state) {
      case "queued":
        if (jobs.transition(jobId, ["queued"], "stopped", { error: null })) {
          outcomes.logEnd(job, "stopped", null);
          queues.released(jobId);
          await outcomes.afterEnd(job, "stopped", null);
        }
        break;
      case "running":
      case "pausing":
        if (jobs.transition(jobId, ["running", "pausing"], "stopping")) {
          limits.resumeAll(jobId);
          runs.get(jobId)?.stop();
          queues.changed(jobId);
        }
        break;
      case "paused":
        await outcomes.endPaused(job);
        break;
      case "stopping":
        runs.get(jobId)?.stop();
        break;
      default:
        throw conflict(`This job cannot be stopped: it is ${STATE_WORDS[job.state]}.`);
    }
    return viewOf(jobId);
  }

  /**
   * @param {Actor} user
   * @param {{ jobId: string, after: number | null }} input
   * @returns {import("../../../src/lib/wire/log.ts").JobLog}
   */
  function getJobLog(user, { jobId, after }) {
    const job = access(user, jobId);
    d.sink.flush();
    const videoId = library.describeKey(job.videoKey)?.videoId ?? "";
    const entries = d.logStore.read(jobId).filter((e) => after === null || e.seq > after);
    return { videoId, jobId, entries };
  }

  /**
   * The active job of a video (for the timeline and the library).
   * @param {string} videoKey
   * @returns {{ id: string, kind: JobRecord["kind"] } | null}
   */
  function activeJob(videoKey) {
    const job = jobs.activeForVideo(videoKey);
    return job ? { id: job.id, kind: job.kind } : null;
  }

  /**
   * The latest job of each video, as the browser sees it.
   * @param {string[]} videoKeys
   */
  function jobsFor(videoKeys) {
    const latest = jobs.latestForVideos(videoKeys);
    /** @type {Map<string, import("../../../src/lib/wire/jobs.ts").JobView>} */
    const out = new Map();
    for (const [key, row] of latest) out.set(key, queues.view(row));
    return out;
  }

  /**
   * Stops every active job of a user and waits for the runs (a disabled or removed account).
   * @param {string} userId
   */
  async function stopJobsOf(userId) {
    const actor = { id: userId, role: /** @type {const} */ ("user") };
    for (const job of jobs.forUser(userId)) {
      try {
        await stopJob(actor, { jobId: job.id });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    await bounded(
      Promise.all(runs.all().map((r) => r.settled)),
      d.shutdownMs,
      d.timers ?? globalThis,
    );
  }

  return {
    launch: launcher.launch,
    startEdit,
    reEdit,
    requestTimelineEdit,
    pauseJob,
    continueJob,
    stopJob,
    getJobLog,
    activeJob,
    jobsFor,
    activeJobCount: (/** @type {string} */ userId) => jobs.forUser(userId).length,
    stopJobsOf,
    start: recovery.start,
    stop: recovery.stop,
    timeline,
  };
}
