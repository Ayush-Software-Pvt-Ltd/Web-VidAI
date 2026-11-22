// The three queues as a service (docs/SPEC.md section 8): decides which waiting job starts next,
// hands it to the injected `launch(job)`, keeps the start delay timer, recovers after a restart and
// tells the pages what changed. It never runs a job itself; the manager and the runner (a later
// task) do that and report back with `released`, `changed` and `setLive`.
//
// Scheduling is one synchronous pass at a time. A pass plans each queue with the pure rules of
// `schedule.js`, marks every chosen job `running` with a guarded transition BEFORE calling
// `launch`, announces the changes and only then calls `launch` (not awaited: the job itself
// runs on its own). A request that arrives during a pass (a `launch` that calls back, a failing
// launch) causes exactly one more pass.

import { AppError, conflict, forbidden, notFound } from "../errors.js";
import { systemClock } from "../db/open.js";
import { plan, QUEUES, SLOT_STATES } from "./schedule.js";

/** @typedef {import("../../../src/lib/wire/jobs.ts").JobView} JobView */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobQueue} JobQueue */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobState} JobState */
/** @typedef {import("../../../src/lib/wire/jobs.ts").QueueSummary} QueueSummary */
/** @typedef {import("../db/jobs.js").JobRecord} JobRecord */
/** @typedef {import("../db/jobs.js").NewJob} NewJob */
/** @typedef {import("./schedule.js").Plan} Plan */

/**
 * @typedef {object} Timers
 * @property {(callback: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/**
 * @typedef {object} VideoDescription What the service needs to know about a video row.
 * @property {string} videoId `<channelId>/<folder name>`.
 */

/**
 * @typedef {object} Live What the runner pushes while a job runs and the table does not hold.
 * @property {string | null} lastActivity One short line, for example "Running ffmpeg".
 * @property {number | null} costUsd
 */

/**
 * @typedef {object} Recovered
 * @property {JobRecord} job The job after recovery.
 * @property {JobState} previousState `running`, `pausing` or `stopping`; the caller ends any
 *   process tree the job left behind.
 */

/** @type {Timers} */
const realTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    // A waiting timer must not keep a closing server alive.
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
};

/**
 * The delay is measured on the wall clock while a timer runs on a clock that stands still when
 * the computer sleeps, so the plan is looked at again at least this often.
 */
export const MAX_WAIT_MS = 60_000;

const MINUTE_MS = 60_000;

const NO_SUCH_JOB = "This job does not exist.";

/**
 * @param {unknown} error
 * @returns {string}
 */
function sentenceOf(error) {
  if (error instanceof AppError || error instanceof Error) {
    const message = error.message.trim();
    if (message !== "") return message;
  }
  return "The job could not be started.";
}

/**
 * @param {import("../../../src/lib/wire.ts").AdminSettings} settings
 * @param {JobQueue} queue
 * @returns {import("./schedule.js").Limits}
 */
function limitsOf(settings, queue) {
  switch (queue) {
    case "edits":
      return {
        slots: settings.maxEdits,
        perUser: settings.maxEditsPerUser,
        startDelayMs: settings.startDelayMinutes * MINUTE_MS,
      };
    case "timeline":
      return { slots: settings.maxTimelineEdits, perUser: 0, startDelayMs: 0 };
    case "renders":
      return { slots: settings.maxRenders, perUser: 0, startDelayMs: 0 };
  }
}

/**
 * Lets `settings-changed` events reach the queue service without editing the code that emits them:
 * hand the RPC layer the returned bus instead of the plain one.
 * @template {{ emit(event: { event: string }): void }} Bus
 * @param {Bus} events
 * @param {() => void} onSettingsChanged Usually `queues.kick`.
 * @returns {Bus}
 */
export function eventsKickingOnSettings(events, onSettingsChanged) {
  return {
    ...events,
    emit(event) {
      events.emit(event);
      if (event.event === "settings-changed") onSettingsChanged();
    },
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import("../db/jobs.js").createJobsRepo>} deps.jobs
 * @param {ReturnType<typeof import("../db/launches.js").createLaunchesRepo>} deps.launches
 * @param {{ getAll(): import("../../../src/lib/wire.ts").AdminSettings }} deps.settings
 * @param {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} deps.events
 * @param {(job: JobRecord) => void | Promise<unknown>} deps.launch What runs a job that got a slot.
 *   It receives the job already `running` (`resume` says whether it continues a session) and
 *   returns, or returns a promise that settles, once the job has started: a throw or a
 *   rejection before that fails the job. It must not wait for the job to end.
 * @param {(videoKey: string) => VideoDescription | undefined} deps.describeVideo
 * @param {import("../db/open.js").Clock} [deps.clock]
 * @param {Timers} [deps.timers]
 * @param {Partial<import("../log.js").Logger>} [deps.log]
 * @param {(userId: string) => boolean} [deps.usersMayMarkUrgent] When given, an Urgent job of a
 *   user who may not is refused.
 * @param {(videoKey: string) => string | null | undefined} [deps.sessionOf] The video's session
 *   id; recovery pauses an agent job only when there is one.
 * @param {(jobIds: string[]) => void} [deps.removeLogs] Called with the ids of ended jobs that
 *   were pruned from the table, so their log files can go too.
 * @param {number} [deps.maxWaitMs]
 */
export function createQueueService({
  jobs,
  launches,
  settings,
  events,
  launch,
  describeVideo,
  clock = systemClock,
  timers = realTimers,
  log = {},
  usersMayMarkUrgent,
  sessionOf = () => null,
  removeLogs = () => {},
  maxWaitMs = MAX_WAIT_MS,
}) {
  /** @param {"warn" | "error"} level @param {string} message @param {unknown} [detail] */
  const note = (level, message, detail) => log[level]?.(message, detail);

  let stopped = false;
  let inPass = false;
  let again = false;
  /** @type {unknown} */
  let timer = null;
  /** Jobs whose row changed since the last announcement (announced once, then cleared). @type {Set<string>} */
  const pending = new Set();
  /** What the pages were last told about each waiting job. @type {Map<string, { queue: JobQueue, sig: string }>} */
  let published = new Map();
  /** @type {Map<string, Live>} */
  const live = new Map();

  /**
   * @param {JobQueue} queue
   * @param {import("../../../src/lib/wire.ts").AdminSettings} s
   * @param {number} now
   */
  function snapshot(queue, s, now) {
    const waiting = jobs.waiting(queue);
    const holding = jobs.running(queue);
    const result = plan({
      queue,
      waiting,
      running: holding,
      limits: limitsOf(s, queue),
      lastLaunchAt: queue === "edits" ? launches.last("edits") : null,
      now,
    });
    return { plan: result, waiting, holding };
  }

  /**
   * A way to get the plan of a queue at most once while views are built.
   * @returns {(queue: JobQueue) => Plan}
   */
  function planCache() {
    const s = settings.getAll();
    const now = clock.now();
    /** @type {Map<JobQueue, Plan>} */
    const cache = new Map();
    return (queue) => {
      let found = cache.get(queue);
      if (!found) {
        found = snapshot(queue, s, now).plan;
        cache.set(queue, found);
      }
      return found;
    };
  }

  /**
   * @param {JobRecord} row
   * @param {(queue: JobQueue) => Plan} planOf
   * @returns {JobView}
   */
  function buildView(row, planOf) {
    const waiting = row.state === "queued" ? planOf(row.queue) : null;
    const startsAt = waiting?.startsAt.get(row.id) ?? null;
    const entry = live.get(row.id);
    /** @type {string | null} */
    let lastActivity = entry?.lastActivity ?? null;
    if (waiting && lastActivity === null) {
      lastActivity =
        startsAt !== null
          ? "Waiting for the start delay"
          : row.resume
            ? "Waiting to continue"
            : "Waiting for a free slot";
    }
    return {
      id: row.id,
      videoId: describeVideo(row.videoKey)?.videoId ?? row.videoKey,
      userId: row.userId,
      kind: row.kind,
      queue: row.queue,
      state: row.state,
      urgent: row.queue === "edits" && row.urgent,
      position: waiting?.positions.get(row.id) ?? null,
      joinedAt: row.joinedAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      activeMs: row.activeMs,
      runningSince: row.runningSince,
      startsAt,
      lastActivity,
      error: row.error,
      progress: row.progress,
      videoType: row.videoType,
      setup: row.setup,
      harness: row.harness,
      model: row.model,
      effort: row.effort,
      costUsd: entry?.costUsd ?? row.costUsd,
    };
  }

  /** @param {JobView} view */
  function sendUpdated(view) {
    events.emit({ event: "job-updated", payload: view, userId: view.userId, admins: true });
  }

  /** @param {number | null} wakeAt */
  function arm(wakeAt) {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (stopped || wakeAt === null) return;
    const delay = Math.min(Math.max(0, wakeAt - clock.now()), maxWaitMs);
    timer = timers.setTimeout(() => {
      timer = null;
      kick();
    }, delay);
  }

  /**
   * Tells the pages what changed since the last time and re-arms the delay timer: one
   * `job-updated` per changed job (also for a waiting job whose place or start time moved), one
   * `queue-changed` per line whose waiting jobs or counts may have moved.
   */
  function flush() {
    const s = settings.getAll();
    const now = clock.now();
    /** @type {Map<JobQueue, Plan>} */
    const plans = new Map();
    /** @type {Map<string, JobRecord>} */
    const waitingRows = new Map();
    /** @type {Map<string, { queue: JobQueue, sig: string }>} */
    const next = new Map();
    for (const queue of QUEUES) {
      const snap = snapshot(queue, s, now);
      plans.set(queue, snap.plan);
      for (const job of snap.waiting) {
        waitingRows.set(job.id, job);
        const position = snap.plan.positions.get(job.id) ?? 0;
        const startsAt = snap.plan.startsAt.get(job.id) ?? "";
        next.set(job.id, { queue, sig: `${position}|${startsAt}|${job.urgent}` });
      }
    }

    const toSend = new Set(pending);
    /** @type {Set<JobQueue>} */
    const queuesChanged = new Set();
    for (const id of pending) {
      const row = waitingRows.get(id) ?? jobs.get(id);
      if (row) queuesChanged.add(row.queue);
    }
    pending.clear();
    for (const [id, entry] of next) {
      const before = published.get(id);
      if (!before || before.sig !== entry.sig) {
        toSend.add(id);
        queuesChanged.add(entry.queue);
      }
    }
    for (const [id, before] of published) if (!next.has(id)) queuesChanged.add(before.queue);
    published = next;

    /** @param {JobQueue} queue */
    const planOf = (queue) => /** @type {Plan} */ (plans.get(queue));
    for (const id of toSend) {
      const row = waitingRows.get(id) ?? jobs.get(id);
      if (row) sendUpdated(buildView(row, planOf));
    }
    for (const queue of QUEUES) {
      if (queuesChanged.has(queue)) {
        events.emit({ event: "queue-changed", payload: { queue }, userId: null, admins: false });
      }
    }
    arm(planOf("edits").wakeAt);
  }

  /**
   * A launch that threw or rejected: the job fails with the error's sentence and frees its slot.
   * @param {JobRecord} job
   * @param {unknown} error
   */
  function launchFailed(job, error) {
    note("warn", `Launching job ${job.id} failed`, error);
    // Only a job that is still `running` fails here: if the runner already moved it, that wins.
    if (!jobs.transition(job.id, ["running"], "failed", { error: sentenceOf(error) })) return;
    live.delete(job.id);
    pending.add(job.id);
    kick();
  }

  /** @param {JobRecord} job */
  function runLaunch(job) {
    /** @type {void | Promise<unknown>} */
    let result;
    try {
      result = launch(job);
    } catch (error) {
      launchFailed(job, error);
      return;
    }
    if (result && typeof result.then === "function") {
      result.then(undefined, (/** @type {unknown} */ error) => launchFailed(job, error));
    }
  }

  /** One scheduling pass over the three queues. */
  function pass() {
    const s = settings.getAll();
    const now = clock.now();
    /** @type {JobRecord[]} */
    const started = [];
    for (const queue of QUEUES) {
      const { plan: chosen, waiting } = snapshot(queue, s, now);
      for (const id of chosen.start) {
        // Guarded: a Stop that got in first wins and the job is simply not started.
        if (!jobs.transition(id, ["queued"], "running", { startNow: false })) continue;
        const before = waiting.find((job) => job.id === id);
        if (queue === "edits" && !before?.resume) launches.record("edits", now);
        pending.add(id);
        const record = jobs.get(id);
        if (record) started.push(record);
      }
    }
    flush();
    for (const job of started) runLaunch(job);
  }

  function kick() {
    if (stopped) return;
    if (inPass) {
      again = true;
      return;
    }
    inPass = true;
    try {
      do {
        again = false;
        try {
          pass();
        } catch (error) {
          note("error", "The queue could not be scheduled", error);
        }
      } while (again && !stopped);
    } finally {
      inPass = false;
    }
  }

  /**
   * SPEC "Recovery": jobs that were running, pausing or stopping become paused (agent jobs whose
   * video has a session) or stopped (the rest, and every render). Queued jobs keep their place.
   * @returns {Recovered[]}
   */
  function recover() {
    /** @type {Recovered[]} */
    const result = [];
    for (const row of jobs.active()) {
      if (!(/** @type {readonly string[]} */ (SLOT_STATES).includes(row.state))) continue;
      const resumable = row.kind !== "render" && Boolean(sessionOf(row.videoKey));
      const to = resumable ? "paused" : "stopped";
      // The time since the job last started running is not counted: the server may have been
      // down for hours and nothing worked in that time.
      if (!jobs.transition(row.id, [row.state], to, {}, { countTime: false })) continue;
      const job = jobs.get(row.id);
      if (!job) continue;
      pending.add(job.id);
      result.push({ job, previousState: row.state });
    }
    return result;
  }

  /**
   * Announces a job whose row changed in a way that does not move the queue.
   * @param {string} jobId
   */
  function changed(jobId) {
    const row = jobs.get(jobId);
    if (row) sendUpdated(buildView(row, planCache()));
  }

  /** @param {string} jobId @returns {JobRecord} */
  function mustGet(jobId) {
    const row = jobs.get(jobId);
    if (!row) throw notFound(NO_SUCH_JOB);
    return row;
  }

  /** @param {string} jobId @returns {JobView} */
  function viewById(jobId) {
    return buildView(mustGet(jobId), planCache());
  }

  return {
    /**
     * A new job joins its line (Start Editing, Re-Edit, a change request, Render Final) and is
     * scheduled at once.
     * @param {Omit<NewJob, "state">} newJob
     * @returns {JobView} The job as it is after the first pass: usually `running` or `queued`.
     * @throws {AppError} `conflict` when the video already has an active job; `forbidden` for
     *   Urgent from a user who may not.
     */
    enqueue(newJob) {
      if (newJob.urgent && usersMayMarkUrgent && !usersMayMarkUrgent(newJob.userId)) {
        throw forbidden("You are not allowed to mark an edit as urgent.");
      }
      const created = jobs.create({ ...newJob, state: "queued" });
      pending.add(created.id);
      kick();
      return viewById(created.id);
    },

    /**
     * Continue: a paused (or failed) job goes back to `queued` with its original place.
     * @param {string} jobId
     * @param {{ resume?: boolean }} [options] `resume: false` when the video has no session to
     *   resume: the job then starts its request again, which is a launch (default: true).
     * @returns {JobView}
     * @throws {AppError} `conflict` when the job is not paused or failed, or the video already
     *   has another active job.
     */
    requeue(jobId, { resume = true } = {}) {
      mustGet(jobId);
      const moved = jobs.transition(jobId, ["paused", "failed"], "queued", {
        resume,
        startNow: false,
        endedAt: null,
        error: null,
      });
      if (!moved) throw conflict("This job cannot be continued right now.");
      pending.add(jobId);
      kick();
      return viewById(jobId);
    },

    /**
     * A job left the running states (paused, stopped, failed, completed): its slot is free, so
     * schedule again. Also keeps the cost the runner pushed and prunes old ended jobs.
     * @param {string} jobId
     */
    released(jobId) {
      const row = jobs.get(jobId);
      if (row) {
        const entry = live.get(jobId);
        live.delete(jobId);
        if (
          entry?.costUsd !== undefined &&
          entry.costUsd !== null &&
          entry.costUsd !== row.costUsd
        ) {
          jobs.setCost(jobId, entry.costUsd);
        }
        if (row.state === "stopped" || row.state === "failed" || row.state === "completed") {
          const removed = jobs.pruneEnded(row.videoKey);
          if (removed.length > 0) removeLogs(removed);
        }
        pending.add(jobId);
      }
      kick();
    },

    /** Look at the queues again (settings changed, a job was removed, a timer, ...). */
    kick,

    /** The admin changed a setting: more slots take effect at once, fewer never stop a job. */
    settingsChanged: kick,

    /**
     * Announces a job whose row changed in a way that does not move the queue (progress, an error
     * line, a retry): one `job-updated`.
     * @param {string} jobId
     */
    changed,

    /**
     * The runner pushes what is not in the table: the last activity line and the cost so far.
     * Announces once when something changed.
     * @param {string} jobId
     * @param {Partial<Live>} patch
     */
    setLive(jobId, patch) {
      const before = live.get(jobId) ?? { lastActivity: null, costUsd: null };
      const after = { ...before, ...patch };
      if (after.lastActivity === before.lastActivity && after.costUsd === before.costUsd) return;
      live.set(jobId, after);
      changed(jobId);
    },

    /** Forget the pushed values of a job (it ended). @param {string} jobId */
    clearLive(jobId) {
      live.delete(jobId);
    },

    /**
     * An admin switches Urgent on or off for a waiting edit.
     * @param {string} jobId
     * @param {boolean} urgent
     * @returns {JobView}
     * @throws {AppError} `conflict` unless the job is an edit waiting in the line.
     */
    setUrgent(jobId, urgent) {
      const row = mustGet(jobId);
      if (row.queue !== "edits" || row.state !== "queued") {
        throw conflict("Only an edit that is waiting in the line can be marked as urgent.");
      }
      if (row.urgent !== urgent) {
        jobs.setUrgent(jobId, urgent);
        pending.add(jobId);
        kick();
      }
      return viewById(jobId);
    },

    /**
     * An admin skips the start delay for the edit that is next in line and held by nothing else.
     * @param {string} jobId
     * @returns {JobView}
     * @throws {AppError} `conflict` unless the delay is all that holds this edit back.
     */
    startNow(jobId) {
      const row = mustGet(jobId);
      const held =
        row.queue === "edits" &&
        row.state === "queued" &&
        snapshot("edits", settings.getAll(), clock.now()).plan.startsAt.has(jobId);
      if (!held) throw conflict("This edit is not waiting for the start delay.");
      jobs.setStartNow(jobId, true);
      pending.add(jobId);
      kick();
      return viewById(jobId);
    },

    /**
     * The full view of a job: position and start time from the current plan.
     * @param {JobRecord} row
     * @returns {JobView}
     */
    view(row) {
      return buildView(row, planCache());
    },

    /**
     * Views of several jobs with one plan per queue (the library, the queue pages).
     * @param {readonly JobRecord[]} rows
     * @returns {JobView[]}
     */
    viewMany(rows) {
      const planOf = planCache();
      return rows.map((row) => buildView(row, planOf));
    },

    /**
     * The totals of every line, for the queue pages.
     * @returns {QueueSummary[]}
     */
    summaries() {
      const s = settings.getAll();
      return QUEUES.map((queue) => ({
        queue,
        running: jobs.running(queue).length,
        waiting: jobs.waiting(queue).length,
        slots: limitsOf(s, queue).slots,
      }));
    },

    /**
     * Recovery, then the first scheduling pass.
     * @returns {Recovered[]} The jobs recovery changed; the caller ends leftover process trees.
     */
    start() {
      stopped = false;
      const recovered = recover();
      kick();
      return recovered;
    },

    /** Stops scheduling and the delay timer; running jobs are not touched. */
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

/** @typedef {ReturnType<typeof createQueueService>} QueueService */
