// Shared set-up for the queue service tests: an in-memory database, a fake clock, fake timers,
// a recording event bus and a fake `launch`. Not a test file itself.

import { createJobsRepo } from "../../src/db/jobs.js";
import { createLaunchesRepo } from "../../src/db/launches.js";
import { createSettingsRepo } from "../../src/db/settings.js";
import { createSettings } from "../../src/settings.js";
import { createQueueService } from "../../src/jobs/queueService.js";
import { createClock, createJobsDb, ownerOf } from "../db/jobsSupport.js";

export const MIN = 60_000;

/**
 * @param {{
 *   settings?: Record<string, unknown>,
 *   videos?: number,
 *   launch?: (job: import("../../src/db/jobs.js").JobRecord) => void | Promise<unknown>,
 *   sessionOf?: (videoKey: string) => string | null,
 *   usersMayMarkUrgent?: (userId: string) => boolean,
 *   maxWaitMs?: number,
 *   start?: boolean,
 *   clock?: { now(): number, advance(ms: number): void },
 *   db?: import("../../src/db/open.js").Database,
 * }} [options] `db` and `clock` let a test share the database of another set-up (it must have
 *   the users and videos the jobs refer to).
 */
export function createQueueHarness({
  settings: initial = {},
  videos = 12,
  launch,
  clock = createClock(),
  db: given,
  ...rest
} = {}) {
  const db = given ?? createJobsDb({ clock, videos }).db;
  const jobs = createJobsRepo(db, { clock });
  const launches = createLaunchesRepo(db);
  const settings = createSettings({ repo: createSettingsRepo(db) });
  settings.update(initial);

  /** @type {{ event: string, payload: any, userId: string | null, admins: boolean }[]} */
  const emitted = [];
  const events = { emit: (/** @type {(typeof emitted)[number]} */ e) => void emitted.push(e) };

  /** @type {Map<number, { callback: () => void, ms: number }>} */
  const scheduled = new Map();
  let timerId = 0;
  const timers = {
    setTimeout(/** @type {() => void} */ callback, /** @type {number} */ ms) {
      timerId += 1;
      scheduled.set(timerId, { callback, ms });
      return timerId;
    },
    clearTimeout(/** @type {unknown} */ id) {
      scheduled.delete(/** @type {number} */ (id));
    },
  };

  /** @type {import("../../src/db/jobs.js").JobRecord[]} */
  const launched = [];
  /** @type {string[][]} */
  const removedLogs = [];
  const warnings = /** @type {string[]} */ ([]);
  const harness = {
    clock,
    db,
    jobs,
    launches,
    settings,
    emitted,
    scheduled,
    launched,
    removedLogs,
    warnings,
    launch: launch ?? (() => {}),
    /** @type {ReturnType<typeof createQueueService>} */
    service: /** @type {never} */ (null),
    /** The one armed timer, if any. */
    armed() {
      return [...scheduled.values()].at(-1) ?? null;
    },
    /** Runs the armed timer like the clock reaching it. */
    fireTimer() {
      const entry = [...scheduled.entries()].at(-1);
      if (!entry) throw new Error("no timer is armed");
      scheduled.delete(entry[0]);
      entry[1].callback();
    },
    /** @param {string} event @param {string} [id] */
    events(event, id) {
      return emitted.filter((e) => e.event === event && (id === undefined || e.payload?.id === id));
    },
    /**
     * A new edit for video `vN` owned by its owner, unless told otherwise.
     * @param {number} n
     * @param {Partial<Omit<import("../../src/db/jobs.js").NewJob, "state">>} [fields]
     */
    enqueue(n, fields = {}) {
      const view = harness.service.enqueue({
        videoKey: `v${n}`,
        userId: ownerOf(`v${n}`),
        kind: "edit",
        videoType: "long",
        joinedAt: clock.now(),
        ...fields,
      });
      // Jobs that join in the same millisecond would be ordered by their random ids.
      clock.advance(1);
      return view;
    },
    /** A job ends: its state changes first, then the service hears of it. @param {string} id @param {import("../../../src/lib/wire/jobs.ts").JobState} [to] */
    end(id, to = "completed") {
      const from = /** @type {never[]} */ (["running", "pausing", "stopping"]);
      if (!jobs.transition(id, from, to)) throw new Error(`job ${id} was not running`);
      harness.service.released(id);
    },
  };

  harness.service = createQueueService({
    jobs,
    launches,
    settings,
    events,
    clock,
    timers,
    log: {
      warn: (message) => void warnings.push(message),
      error: (message) => void warnings.push(message),
    },
    launch: (job) => {
      launched.push(job);
      return harness.launch(job);
    },
    describeVideo: (key) => ({ videoId: `c-${ownerOf(key)}/${key}` }),
    removeLogs: (ids) => void removedLogs.push(ids),
    ...rest,
  });
  return harness;
}
