/**
 * The jobs area: start, re-edit, render, pause, continue, stop and the log, plus the simulated
 * runs. A run is a script (`scripts.ts`) played one step per tick (`speed` steps per tick when
 * faster); it logs, reports progress and cost, and ends completed, failed (`world.failJobsWith`)
 * or stopped. `enqueue`, `kick` and `advance` are shared with the queue area. Events: `job-updated`
 * to the owner and admins, `job-log` likewise, `queue-changed` to everybody signed in and
 * `library-changed` to the owner (the video row shows the job).
 */
import type { Api } from "../../api";
import type {
  JobKind,
  JobLog,
  JobQueue,
  JobState,
  JobView,
  LogEntry,
  VideoType,
} from "../../types";
import { makeVideoId, splitVideoId } from "../../videoId";
import type { MockCtx } from "../ctx";
import { QUEUES, jobsOf, planOf, queueOfKind, viewOf, viewsOf, type QueueClock } from "../queue";
import { CHANNEL_UNREACHABLE, RE_EDIT_MAX_CHARS, ensureReady, isActiveState } from "../rules";
import { DONE_PROGRESS, progressAfter, scriptFor, stepDetail } from "../scripts";
import type { TimelineSim } from "../timelineEngine";
import {
  nextId,
  outputFile,
  type MockJob,
  type MockUser,
  type MockVideo,
  type World,
} from "../world";
import { emitLibrary, ownVideo, videoViewOf } from "./library";

/** The sentences of `renderFinal` in `server/src/rpc/render.js`. */
const RENDER_NOT_READY =
  "Rendering is not ready on this server yet: Prepare on the System page has not finished fetching the render browser and testing it. Ask an admin.";
const RENDER_BUSY =
  "This video already has a job running or waiting. Wait for it to finish, or stop it, before rendering.";
const RENDER_PENDING_NOTES =
  "This video has change requests that are not applied yet. Wait until they are applied, or delete them, before rendering.";
const RENDER_NO_PROJECT = "This video has no project yet. Start an edit first.";
const RENDER_NAMED_ERRORS = 3;

/** What a refused action says, by what stands in the way. */
const STATE_WORDS: Record<JobState, string> = {
  queued: "waiting to start",
  running: "running",
  pausing: "being paused",
  paused: "paused",
  stopping: "being stopped",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
};

const COST_PER_STEP = 0.04;
const FAIL_AFTER_STEPS = 3;

const clockOf = (ctx: MockCtx): QueueClock => ({
  now: ctx.clock.now(),
  minuteMs: ctx.clock.minuteMs,
});

function jobById(world: World, jobId: string): MockJob | undefined {
  return world.jobs.find((job) => job.view.id === jobId);
}

/** The job when the user may act on it: the owner, an admin or the owner of the video. */
function access(ctx: MockCtx, user: MockUser, jobId: string): MockJob {
  const job = jobById(ctx.world, jobId);
  if (!job) throw ctx.errors.notFound("This job does not exist.");
  if (job.view.userId === user.id || user.role === "admin") return job;
  const { channelId } = splitVideoId(job.view.videoId) ?? {
    channelId: "",
    folderName: job.view.videoId,
  };
  if (ctx.world.channels.find((c) => c.id === channelId)?.userId === user.id) return job;
  throw ctx.errors.notFound("This job does not exist.");
}

function videoOfJob(world: World, job: MockJob): MockVideo | undefined {
  return world.videos.find((v) => makeVideoId(v.channelId, v.folderName) === job.view.videoId);
}

/** What a new job runs on: the current setup, or the one a Re-Edit's session was made on. */
export function launchFor(world: World): Pick<JobView, "setup" | "harness" | "model" | "effort"> {
  const { setup, program, claude, options } = world.harness;
  if (setup === "claudeSubscription") {
    return { setup, harness: program, model: claude.model, effort: claude.effort };
  }
  const option = options[setup];
  const model = option.model;
  return {
    setup,
    harness: program,
    model,
    effort: model === null ? null : (option.efforts[model] ?? null),
  };
}

function log(ctx: MockCtx, job: MockJob, entry: Omit<LogEntry, "seq" | "ts">): void {
  const full: LogEntry = {
    ...entry,
    seq: job.sim.seq,
    ts: new Date(ctx.clock.now()).toISOString(),
  };
  job.sim.seq += 1;
  (ctx.world.jobLogs[job.view.id] ??= []).push(full);
  const payload: JobLog = { videoId: job.view.videoId, jobId: job.view.id, entries: [full] };
  ctx.emit("job-log", payload, { userId: job.view.userId, admins: false });
}

/** The server's name of a program in edit log lines. */
function programName(job: MockJob): string {
  return job.view.harness === "opencode2" ? "OpenCode 2" : "Claude Code";
}

/** The edit log line of a job's first start, as the server's `logStart` writes it. */
function startLine(job: MockJob): string {
  switch (job.view.kind) {
    case "render":
      return "Render started";
    case "timelineEdit":
      return `Change request started (${programName(job)})`;
    case "reEdit":
      return `Re-Edit started (${programName(job)})`;
    case "edit":
      return `Started (${programName(job)})`;
  }
}

/** Jobs whose next start is a Continue: the Continue already wrote its line, the start writes none. */
const justContinued = new WeakSet<MockJob>();

/**
 * Jobs whose launch failed before the program started (the server's `failLaunch`): they never ran,
 * so a change request leaves its notes pending (the server's `takeNotes` comes after the launch).
 */
const failedAtLaunch = new WeakSet<MockJob>();

/** Whether this job ended at its launch, before any program ran. */
export function didFailAtLaunch(job: MockJob): boolean {
  return failedAtLaunch.has(job);
}

function editLog(ctx: MockCtx, job: MockJob, event: string, message: string): void {
  const { world } = ctx;
  const { channelId, folderName } = splitVideoId(job.view.videoId) ?? {
    channelId: "",
    folderName: job.view.videoId,
  };
  const channel = world.channels.find((c) => c.id === channelId);
  const user = world.users.find((u) => u.id === job.view.userId);
  world.editLog.push({
    id: (world.editLog.at(-1)?.id ?? 0) + 1,
    at: ctx.clock.now(),
    userId: job.view.userId,
    userEmail: user?.email ?? "",
    videoLabel: `${channel?.name ?? ""} / ${folderName}`,
    event,
    message,
  });
}

/** Tells the browsers what changed: the job, its queue, and the owners' library rows. */
function changed(ctx: MockCtx, jobs: MockJob[], queues: Iterable<JobQueue>): void {
  const { world } = ctx;
  const clock = clockOf(ctx);
  const views = viewsOf(world, clock);
  const owners = new Set<string>();
  for (const job of jobs) {
    const view = views.get(job.view.id) ?? job.view;
    ctx.emit("job-updated", view, { userId: view.userId, admins: true });
    owners.add(view.userId);
  }
  for (const queue of new Set(queues)) {
    ctx.emit("queue-changed", { queue });
    for (const other of world.jobs) {
      if (other.view.queue === queue && isActiveState(other.view.state))
        owners.add(other.view.userId);
    }
  }
  for (const owner of owners) emitLibrary(ctx, owner);
}

function settle(job: MockJob, now: number, state: JobState): void {
  const { view } = job;
  if (view.runningSince !== null) view.activeMs += Math.max(0, now - view.runningSince);
  view.runningSince = null;
  view.state = state;
  if (state === "stopped" || state === "failed" || state === "completed") view.endedAt = now;
}

function complete(ctx: MockCtx, job: MockJob, now: number): void {
  const video = videoOfJob(ctx.world, job);
  if (video) {
    if (job.view.kind === "render") {
      const request = job.request as { resolution?: number } | null;
      const res = request?.resolution ?? 1080;
      // The server's name: the smallest free `<folder>_final_v<n>.mp4`, never overwriting one.
      const taken = new Set(video.output.finals.map((f) => f.name));
      let n = 1;
      while (taken.has(`${video.folderName}_final_v${n}.mp4`)) n += 1;
      const name = `${video.folderName}_final_v${n}.mp4`;
      const path = `output/${name}`;
      video.output.finals.push(outputFile(name, path, res === 2160 ? 3.1e9 : 900e6, now));
      video.output.newestFinal = path;
      video.finalRendered = true;
    } else {
      // One HyperFrames project per video, changed in place (its revisions live on the server).
      video.output.project = { path: `output/${video.folderName}.hf/index.html`, modifiedAt: now };
      video.edited = true;
      video.workingFiles = true;
    }
  }
  settle(job, now, "completed");
  job.view.progress = { ...DONE_PROGRESS };
  job.view.lastActivity = null;
  editLog(
    ctx,
    job,
    "completed",
    job.view.kind === "render" ? "Render finished" : `Finished (${programName(job)})`,
  );
}

/**
 * What the server's launch finds out before an agent or a render starts (`resolveVideo` in
 * `managerLaunch.js`): the video must still be there and its channel's folder reachable. The
 * sentence of the refusal, or `null` when the job can run.
 */
function launchRefusal(world: World, job: MockJob): string | null {
  const video = videoOfJob(world, job);
  if (!video) return null;
  const channel = world.channels.find((c) => c.id === video.channelId);
  return channel && !channel.available ? CHANNEL_UNREACHABLE : null;
}

/** Moves waiting jobs into free slots, as the scheduler does after every change. */
export function kick(ctx: MockCtx): void {
  const { world } = ctx;
  const now = ctx.clock.now();
  const clock = clockOf(ctx);
  const started: MockJob[] = [];
  const queues = new Set<JobQueue>();
  let refused = false;
  for (const queue of QUEUES) {
    const { start } = planOf(world, queue, clock);
    for (const id of start) {
      const job = jobById(world, id);
      if (!job || job.view.state !== "queued") continue;
      job.view.state = "running";
      job.view.startedAt ??= now;
      job.view.runningSince = now;
      job.view.lastActivity = null;
      if (queue === "edits" && !job.sim.resume) (world.launches[queue] ??= []).push(now);
      job.sim.startNow = false;
      queues.add(queue);
      if (!justContinued.delete(job)) editLog(ctx, job, "started", startLine(job));
      const refusal = launchRefusal(world, job);
      if (refusal === null) {
        started.push(job);
        continue;
      }
      // The launch failed before the program started: the job was told it runs, then it ends as
      // failed with the sentence, without a log entry, and its slot goes to the next one.
      changed(ctx, [job], [queue]);
      settle(job, now, "failed");
      job.view.error = refusal;
      failedAtLaunch.add(job);
      job.view.lastActivity = null;
      editLog(ctx, job, "failed", `Needs attention: ${refusal}`);
      changed(ctx, [job], [queue]);
      refused = true;
    }
  }
  if (started.length > 0) changed(ctx, started, queues);
  if (refused) kick(ctx);
}

function performStep(ctx: MockCtx, job: MockJob, now: number): void {
  const script = scriptFor(job.view.kind);
  const step = script[job.sim.step];
  if (!step) return;
  const video = videoOfJob(ctx.world, job);
  const channel = ctx.world.channels.find((c) => c.id === video?.channelId);
  const paths = {
    channelDir: channel?.dir ?? "",
    videoDir: `${channel?.dir ?? ""}/${video?.folderName ?? ""}`,
  };
  log(ctx, job, {
    kind: step.kind,
    text: step.text,
    detail: stepDetail(step, paths),
    nested: step.nested ?? false,
  });
  job.sim.step += 1;
  job.view.progress = progressAfter(job.view.kind, job.sim.step);
  if (step.activity !== undefined) job.view.lastActivity = step.activity;
  job.view.costUsd = Math.round(((job.view.costUsd ?? 0) + COST_PER_STEP) * 100) / 100;
  if (job.sim.failAt !== null && job.sim.step >= job.sim.failAt) {
    const message = job.sim.failMessage ?? "The editing program stopped with an error.";
    settle(job, now, "failed");
    job.view.error = message;
    job.view.lastActivity = null;
    log(ctx, job, { kind: "error", text: message, detail: null, nested: false });
    editLog(ctx, job, "failed", `Needs attention: ${message}`);
  } else if (job.sim.step >= script.length) {
    complete(ctx, job, now);
  }
}

/** One tick of every run: finish pauses and stops, play steps, then fill free slots. */
export function advance(ctx: MockCtx, now: number): void {
  const { world } = ctx;
  const touched: MockJob[] = [];
  const queues = new Set<JobQueue>();
  for (const job of [...world.jobs]) {
    const before = job.view.state;
    if (before === "pausing") settle(job, now, "paused");
    else if (before === "stopping") settle(job, now, "stopped");
    else if (before === "running") {
      job.sim.carry += ctx.clock.speed;
      while (job.sim.carry >= 1 && job.view.state === "running") {
        job.sim.carry -= 1;
        performStep(ctx, job, now);
      }
    } else continue;
    if (job.view.state === "stopped") editLog(ctx, job, "stopped", "Stopped");
    if (job.view.state === "paused") editLog(ctx, job, "paused", "Paused");
    touched.push(job);
    if (job.view.state !== before || before !== "running") queues.add(job.view.queue);
  }
  if (touched.length > 0) changed(ctx, touched, queues);
  kick(ctx);
}

export interface EnqueueInput {
  user: MockUser;
  videoId: string;
  kind: JobKind;
  urgent: boolean;
  request: unknown;
  videoType: VideoType;
  launch: Pick<JobView, "setup" | "harness" | "model" | "effort">;
}

/** Puts a new job in its queue and runs the scheduler once (as `queues.enqueue`). */
export function enqueue(ctx: MockCtx, input: EnqueueInput): JobView {
  const { world } = ctx;
  const { user, videoId, kind } = input;
  if (input.urgent && !user.mayMarkUrgent && user.role !== "admin") {
    throw ctx.errors.forbidden("You are not allowed to mark an edit as urgent.");
  }
  if (world.jobs.some((job) => job.view.videoId === videoId && isActiveState(job.view.state))) {
    throw ctx.errors.conflict("This video already has an edit in progress.");
  }
  const queue = queueOfKind(kind);
  const failing = world.failJobsWith !== null;
  const job: MockJob = {
    view: {
      id: nextId(world, "job"),
      videoId,
      userId: user.id,
      kind,
      queue,
      state: "queued",
      urgent: queue === "edits" && input.urgent,
      position: null,
      joinedAt: ctx.clock.now(),
      startedAt: null,
      endedAt: null,
      activeMs: 0,
      runningSince: null,
      startsAt: null,
      lastActivity: null,
      error: null,
      progress: null,
      videoType: input.videoType,
      ...input.launch,
      costUsd: null,
    },
    request: input.request,
    sim: {
      step: 0,
      carry: 0,
      resume: false,
      startNow: false,
      failAt: failing ? FAIL_AFTER_STEPS : null,
      failMessage: world.failJobsWith,
      seq: 1,
    },
  };
  world.jobs.push(job);
  world.jobLogs[job.view.id] = [];
  changed(ctx, [job], [queue]);
  kick(ctx);
  return viewOf(world, job, clockOf(ctx));
}

/** An admin marks a waiting edit Urgent or not (`adminSetJobUrgent`). */
export function setJobUrgent(ctx: MockCtx, jobId: string, urgent: boolean): JobView {
  const job = jobById(ctx.world, jobId);
  if (!job) throw ctx.errors.notFound("This job does not exist.");
  if (job.view.queue !== "edits" || job.view.state !== "queued") {
    throw ctx.errors.conflict("Only an edit that is waiting in the line can be marked as urgent.");
  }
  if (job.view.urgent !== urgent) {
    job.view.urgent = urgent;
    changed(ctx, [job], [job.view.queue]);
    kick(ctx);
  }
  return viewOf(ctx.world, job, clockOf(ctx));
}

/** An admin lets a job held by the start delay start now (`adminStartJobNow`). */
export function startJobNow(ctx: MockCtx, jobId: string): JobView {
  const job = jobById(ctx.world, jobId);
  if (!job) throw ctx.errors.notFound("This job does not exist.");
  const held =
    job.view.queue === "edits" &&
    job.view.state === "queued" &&
    planOf(ctx.world, "edits", clockOf(ctx)).startsAt.has(jobId);
  if (!held) throw ctx.errors.conflict("This edit is not waiting for the start delay.");
  job.sim.startNow = true;
  kick(ctx);
  return viewOf(ctx.world, job, clockOf(ctx));
}

export function jobsArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  ctx.ticks.register("jobs", (now) => advance(ctx, now));

  /** The video of a new job with the library's own answer whether the action is offered. */
  const offered = (user: MockUser, videoId: string, action: "startEdit" | "reEdit") => {
    const video = ownVideo(ctx, user.id, videoId);
    const view = videoViewOf(world, video, user, viewsOf(world, clockOf(ctx)));
    if (view.actions.includes(action)) {
      if (action === "startEdit" && view.arollCount === 0) throw noAroll();
      return { video, view };
    }
    if (view.job !== null && isActiveState(view.job.state)) {
      throw ctx.errors.conflict("This video already has an edit in progress.");
    }
    if (view.uploading)
      throw ctx.errors.conflict("Wait until the upload of this video has finished.");
    if (action === "startEdit" && view.edited) {
      throw ctx.errors.conflict("This video already has an edit. Use Re-Edit to change it.");
    }
    if (action === "reEdit") {
      throw ctx.errors.conflict("This video has no edit to change yet. Start an edit first.");
    }
    throw noAroll();
  };
  const noAroll = () =>
    ctx.errors.invalidInput("This video has no A-roll yet. Add the video file first.");

  return {
    startEdit: ({ videoId, urgent }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const { video, view } = offered(user, videoId, "startEdit");
        ensureReady(ctx);
        const channel = world.channels.find((c) => c.id === video.channelId);
        const slot = channel?.[view.videoType].prompts[video.inputs.promptSlot];
        if ((slot?.text ?? "").trim() === "") {
          throw ctx.errors.invalidInput(
            `Prompt ${video.inputs.promptSlot + 1} of this channel is empty. Write it in the channel settings or choose another prompt.`,
          );
        }
        return enqueue(ctx, {
          user,
          videoId,
          kind: "edit",
          urgent,
          request: {},
          videoType: view.videoType,
          launch: launchFor(world),
        });
      }),

    reEdit: ({ videoId, text, urgent }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const changes = text.trim();
        if (changes === "") throw ctx.errors.invalidInput("Write what should change.");
        if (changes.length > RE_EDIT_MAX_CHARS) {
          throw ctx.errors.invalidInput(`Keep the text under ${RE_EDIT_MAX_CHARS} characters.`);
        }
        const { view } = offered(user, videoId, "reEdit");
        ensureReady(ctx);
        return enqueue(ctx, {
          user,
          videoId,
          kind: "reEdit",
          urgent,
          request: { text: changes },
          videoType: view.videoType,
          launch: launchFor(world),
        });
      }),

    // The order and the sentences of `server/src/rpc/render.js`: render readiness first, then the
    // video (notFound, unreachable), a job that holds it, change requests not applied yet, no
    // project, a project with errors; an agent program is not needed, so no `ensureReady`.
    renderFinal: ({ videoId, resolution }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        if (!world.system.prepare.renderReady) throw ctx.errors.notReady(RENDER_NOT_READY);
        const video = ownVideo(ctx, user.id, videoId);
        const view = videoViewOf(world, video, user, viewsOf(world, clockOf(ctx)));
        if (world.jobs.some((j) => j.view.videoId === videoId && isActiveState(j.view.state))) {
          throw ctx.errors.conflict(RENDER_BUSY);
        }
        const sim = world.timelines[videoId] as TimelineSim | undefined;
        if (sim?.notes.some((n) => n.state === "pending")) {
          throw ctx.errors.conflict(RENDER_PENDING_NOTES);
        }
        if (!video.edited && !sim) throw ctx.errors.notReady(RENDER_NO_PROJECT);
        const problems = sim ? sim.violations.map((v) => v.message) : [];
        if (sim?.unreadable && problems.length === 0) problems.push("index.html is missing.");
        if (problems.length > 0) {
          const named = problems.slice(0, RENDER_NAMED_ERRORS).join(" ");
          const more = problems.length - RENDER_NAMED_ERRORS;
          throw ctx.errors.invalidInput(
            `The project has errors, so it cannot be rendered: ${named}${more > 0 ? ` (and ${more} more)` : ""}`,
          );
        }
        return enqueue(ctx, {
          user,
          videoId,
          kind: "render",
          urgent: false,
          request: { resolution },
          videoType: view.videoType,
          launch: launchFor(world),
        });
      }),

    pauseJob: ({ jobId }) =>
      ctx.run(() => {
        const job = access(ctx, ctx.requireUser(), jobId);
        if (job.view.kind === "render") {
          throw ctx.errors.conflict("A final render cannot be paused. You can stop it instead.");
        }
        if (job.view.state !== "running") {
          throw ctx.errors.conflict(
            `This job cannot be paused: it is ${STATE_WORDS[job.view.state]}.`,
          );
        }
        job.view.state = "pausing";
        changed(ctx, [job], [job.view.queue]);
        return viewOf(world, job, clockOf(ctx));
      }),

    continueJob: ({ jobId }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const job = access(ctx, user, jobId);
        const { state } = job.view;
        if (state !== "paused" && state !== "failed") {
          throw ctx.errors.conflict(`This job cannot be continued: it is ${STATE_WORDS[state]}.`);
        }
        ensureReady(ctx);
        const render = job.view.kind === "render";
        job.view.state = "queued";
        job.view.error = null;
        job.view.endedAt = null;
        job.view.lastActivity = null;
        job.sim.startNow = false;
        job.sim.failAt = null;
        if (render) {
          job.sim.step = 0;
          job.sim.carry = 0;
          job.view.progress = null;
        }
        job.sim.resume = !render;
        justContinued.add(job);
        editLog(ctx, job, "continued", "Continued");
        changed(ctx, [job], [job.view.queue]);
        kick(ctx);
        return viewOf(world, job, clockOf(ctx));
      }),

    stopJob: ({ jobId }) =>
      ctx.run(() => {
        const job = access(ctx, ctx.requireUser(), jobId);
        const now = ctx.clock.now();
        switch (job.view.state) {
          case "queued":
          case "paused":
            settle(job, now, "stopped");
            job.view.error = null;
            job.view.lastActivity = null;
            editLog(ctx, job, "stopped", "Stopped");
            changed(ctx, [job], [job.view.queue]);
            kick(ctx);
            break;
          case "running":
          case "pausing":
            job.view.state = "stopping";
            changed(ctx, [job], [job.view.queue]);
            break;
          case "stopping":
            break;
          default:
            throw ctx.errors.conflict(
              `This job cannot be stopped: it is ${STATE_WORDS[job.view.state]}.`,
            );
        }
        return viewOf(world, job, clockOf(ctx));
      }),

    getJobLog: ({ jobId, after }) =>
      ctx.run((): JobLog => {
        const job = access(ctx, ctx.requireUser(), jobId);
        const entries = (world.jobLogs[jobId] ?? []).filter((e) => after === null || e.seq > after);
        return { videoId: job.view.videoId, jobId, entries };
      }),
  };
}

export { jobsOf };
