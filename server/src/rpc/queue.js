// The queue pages (docs/SPEC.md sections 8 and 14): `getQueue` for a user's own jobs and, for
// admins, `adminGetQueue`, `adminSetJobUrgent` and `adminStartJobNow`. The rules (who is next, what
// Urgent and Start now mean) live in `jobs/queueService.js`; this file only reads, filters and
// maps errors. A user never gets another user's jobs or video names.

import { requireSession } from "./context.js";
import { boolean, object, string } from "./validate.js";
import { QUEUES } from "../jobs/schedule.js";

/** @typedef {import("../../../src/lib/wire/jobs.ts").QueueView} QueueView */
/** @typedef {import("../../../src/lib/wire/jobs.ts").AdminQueueView} AdminQueueView */
/** @typedef {import("../../../src/lib/wire/jobs.ts").AdminQueueEntry} AdminQueueEntry */
/** @typedef {import("../../../src/lib/wire/jobs.ts").QueueEntry} QueueEntry */
/** @typedef {import("../db/jobs.js").JobRecord} JobRecord */

const QUEUE_RANK = new Map(QUEUES.map((queue, index) => [queue, index]));
const HOLDING = new Set(["running", "pausing", "stopping"]);

/**
 * Order of a list of jobs: line by line, jobs holding a slot first, then the waiting ones by
 * position, then the rest by the time they joined.
 * @param {JobRecord} a
 * @param {JobRecord} b
 * @param {Map<string, number | null>} positions
 */
function byLine(a, b, positions) {
  const queue = (QUEUE_RANK.get(a.queue) ?? 0) - (QUEUE_RANK.get(b.queue) ?? 0);
  if (queue !== 0) return queue;
  /** @param {JobRecord} job */
  const group = (job) => (HOLDING.has(job.state) ? 0 : job.state === "queued" ? 1 : 2);
  if (group(a) !== group(b)) return group(a) - group(b);
  const positionA = positions.get(a.id) ?? 0;
  const positionB = positions.get(b.id) ?? 0;
  if (positionA !== positionB) return positionA - positionB;
  return a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1);
}

/**
 * @param {object} deps
 * @param {import("../jobs/queueService.js").QueueService} deps.queues
 * @param {ReturnType<typeof import("../db/jobs.js").createJobsRepo>} deps.jobs
 * @param {{ byId(id: string): { email: string } | null | undefined }} deps.users
 * @param {(videoKey: string) => { videoId: string, channelName: string, folderName: string } | undefined} deps.describeVideo
 * @returns {import("./index.js").RpcFunction[]}
 */
export function queueFunctions({ queues, jobs, users, describeVideo }) {
  const jobInput = object({ jobId: string({ min: 1, max: 64 }) });
  return [
    {
      name: "getQueue",
      access: "user",
      handler(_input, ctx) {
        const { user } = requireSession(ctx);
        // Paused jobs neither wait nor run, so they are not part of the line.
        const rows = jobs.forUser(user.id).filter((row) => row.state !== "paused");
        const views = queues.viewMany(rows);
        const positions = new Map(views.map((view) => [view.id, view.position]));
        /** @type {QueueEntry[]} */
        const entries = rows
          .map((row, index) => ({ row, view: views[index] }))
          .sort((a, b) => byLine(a.row, b.row, positions))
          .map(({ row, view }) => {
            const video = describeVideo(row.videoKey);
            return {
              job: view,
              channelName: video?.channelName ?? "",
              folderName: video?.folderName ?? "",
              ahead: view.position === null ? null : view.position - 1,
            };
          });
        return /** @type {QueueView} */ ({ queues: queues.summaries(), jobs: entries });
      },
    },

    {
      name: "adminGetQueue",
      access: "admin",
      handler() {
        const rows = jobs.active();
        const views = queues.viewMany(rows);
        const positions = new Map(views.map((view) => [view.id, view.position]));
        /** @type {AdminQueueEntry[]} */
        const entries = rows
          .map((row, index) => ({ row, view: views[index] }))
          .sort((a, b) => byLine(a.row, b.row, positions))
          .map(({ row, view }) => {
            const video = describeVideo(row.videoKey);
            return {
              jobId: row.id,
              queue: row.queue,
              kind: row.kind,
              state: /** @type {AdminQueueEntry["state"]} */ (row.state),
              urgent: view.urgent,
              position: view.position,
              startsAt: view.startsAt,
              joinedAt: row.joinedAt,
              userId: row.userId,
              userEmail: users.byId(row.userId)?.email ?? "",
              channelName: video?.channelName ?? "",
              folderName: video?.folderName ?? "",
              videoId: view.videoId,
            };
          });
        return /** @type {AdminQueueView} */ ({ queues: queues.summaries(), jobs: entries });
      },
    },

    {
      name: "adminSetJobUrgent",
      access: "admin",
      handler(input) {
        const { jobId, urgent } = object({
          jobId: string({ min: 1, max: 64 }),
          urgent: boolean,
        })(input);
        return queues.setUrgent(jobId, urgent);
      },
    },

    {
      name: "adminStartJobNow",
      access: "admin",
      handler(input) {
        const { jobId } = jobInput(input);
        return queues.startNow(jobId);
      },
    },
  ];
}
