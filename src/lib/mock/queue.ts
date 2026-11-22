/**
 * The three queues (edits, timeline, renders) as pure functions over the `World`: the plan (a
 * port of `server/src/jobs/schedule.js`), the views of jobs with their line position and start
 * delay, the summaries and the admin's Urgent and Start now. The jobs area runs the jobs; this
 * file says which of them may start and what the browser sees.
 */
import type {
  ActiveJobState,
  AdminQueueView,
  JobKind,
  JobQueue,
  JobView,
  QueueSummary,
  QueueView,
} from "../types";
import { splitVideoId } from "../videoId";
import { isActiveState } from "./rules";
import type { MockJob, MockUser, World } from "./world";

export const QUEUES: readonly JobQueue[] = ["edits", "timeline", "renders"];

/** States that hold one of a queue's slots (a paused job holds none). */
export const SLOT_STATES = ["running", "pausing", "stopping"] as const;

export function queueOfKind(kind: JobKind): JobQueue {
  switch (kind) {
    case "edit":
    case "reEdit":
      return "edits";
    case "timelineEdit":
      return "timeline";
    case "render":
      return "renders";
  }
}

export interface Waiting {
  id: string;
  userId: string;
  urgent: boolean;
  joinedAt: number;
  resume: boolean;
  startNow: boolean;
}

export interface Limits {
  slots: number;
  /** 0 is no limit. */
  perUser: number;
  startDelayMs: number;
}

export interface Plan {
  start: string[];
  /** 1..n without holes; a job skipped by the per-user limit keeps its number. */
  positions: Map<string, number>;
  startsAt: Map<string, number>;
  wakeAt: number | null;
}

/** The order of the line: Urgent first (edits only), then who joined first, then the id. */
export function lineOrder<T extends Pick<Waiting, "id" | "urgent" | "joinedAt">>(
  queue: JobQueue,
  waiting: readonly T[],
): T[] {
  const urgentFirst = queue === "edits";
  return [...waiting].sort((a, b) => {
    if (urgentFirst && a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Which waiting jobs start now, and what the others wait for (port of `schedule.plan`). */
export function plan(input: {
  queue: JobQueue;
  waiting: readonly Waiting[];
  running: readonly { userId: string }[];
  limits: Limits;
  lastLaunchAt: number | null;
  now: number;
}): Plan {
  const { queue, waiting, running, limits, lastLaunchAt, now } = input;
  const ordered = lineOrder(queue, waiting);
  const positions = new Map<string, number>();
  ordered.forEach((job, index) => positions.set(job.id, index + 1));

  const edits = queue === "edits";
  const perUser = edits ? Math.max(0, limits.perUser) : 0;
  const delay = edits ? Math.max(0, limits.startDelayMs) : 0;
  let free = Math.max(0, limits.slots - running.length);
  let holding = running.length;
  const perUserCount = new Map<string, number>();
  for (const job of running) perUserCount.set(job.userId, (perUserCount.get(job.userId) ?? 0) + 1);
  let last = lastLaunchAt === null ? null : Math.min(lastLaunchAt, now);

  const atLimit = (job: Waiting) => perUser > 0 && (perUserCount.get(job.userId) ?? 0) >= perUser;
  const delayOpen = (at: number | null) =>
    delay === 0 || holding === 0 || at === null || now >= at + delay;

  const start: string[] = [];
  const started = new Set<string>();
  let blocked = false;
  for (const job of ordered) {
    if (free === 0) break;
    if (atLimit(job)) continue;
    let go: boolean;
    if (!edits || job.resume || job.startNow) go = true;
    else if (blocked) go = false;
    else {
      go = delayOpen(last);
      if (!go) blocked = true;
    }
    if (!go) continue;
    start.push(job.id);
    started.add(job.id);
    free -= 1;
    holding += 1;
    perUserCount.set(job.userId, (perUserCount.get(job.userId) ?? 0) + 1);
    if (edits && !job.resume) last = now;
  }

  const startsAt = new Map<string, number>();
  let wakeAt: number | null = null;
  if (edits && free > 0 && delay > 0 && holding > 0 && last !== null && last + delay > now) {
    const next = ordered.find((job) => !started.has(job.id) && !atLimit(job));
    if (next) {
      startsAt.set(next.id, last + delay);
      wakeAt = last + delay;
    }
  }
  return { start, positions, startsAt, wakeAt };
}

/** What the queues need from the clock. */
export interface QueueClock {
  now: number;
  minuteMs: number;
}

export function limitsOf(world: World, queue: JobQueue, clock: { minuteMs: number }): Limits {
  const s = world.adminSettings;
  switch (queue) {
    case "edits":
      return {
        slots: s.maxEdits,
        perUser: s.maxEditsPerUser,
        startDelayMs: s.startDelayMinutes * clock.minuteMs,
      };
    case "timeline":
      return { slots: s.maxTimelineEdits, perUser: 0, startDelayMs: 0 };
    case "renders":
      return { slots: s.maxRenders, perUser: 0, startDelayMs: 0 };
  }
}

export const holdsSlot = (job: MockJob): boolean =>
  (SLOT_STATES as readonly string[]).includes(job.view.state);

/** The jobs of one queue in a state. */
export function jobsOf(world: World, queue: JobQueue, state: "queued" | "slot"): MockJob[] {
  return world.jobs.filter(
    (job) =>
      job.view.queue === queue &&
      (state === "queued" ? job.view.state === "queued" : holdsSlot(job)),
  );
}

export function lastLaunchAt(world: World, queue: JobQueue): number | null {
  const list = world.launches[queue] ?? [];
  return list.length === 0 ? null : Math.max(...list);
}

/** The plan of one queue now. */
export function planOf(world: World, queue: JobQueue, clock: QueueClock): Plan {
  const waiting: Waiting[] = jobsOf(world, queue, "queued").map((job) => ({
    id: job.view.id,
    userId: job.view.userId,
    urgent: queue === "edits" && job.view.urgent,
    joinedAt: job.view.joinedAt,
    resume: job.sim.resume,
    startNow: job.sim.startNow,
  }));
  return plan({
    queue,
    waiting,
    running: jobsOf(world, queue, "slot").map((job) => ({ userId: job.view.userId })),
    limits: limitsOf(world, queue, clock),
    lastLaunchAt: queue === "edits" ? lastLaunchAt(world, queue) : null,
    now: clock.now,
  });
}

/** The jobs as the browser sees them: stored view plus line position, start delay and the wait line. */
export function viewsOf(world: World, clock: QueueClock): Map<string, JobView> {
  const plans = new Map<JobQueue, Plan>();
  const planFor = (queue: JobQueue) => {
    let found = plans.get(queue);
    if (!found) {
      found = planOf(world, queue, clock);
      plans.set(queue, found);
    }
    return found;
  };
  const out = new Map<string, JobView>();
  for (const job of world.jobs) {
    const view = job.view;
    if (view.state !== "queued") {
      out.set(view.id, { ...view, position: null, startsAt: null });
      continue;
    }
    const current = planFor(view.queue);
    const startsAt = current.startsAt.get(view.id) ?? null;
    let lastActivity = view.lastActivity;
    if (lastActivity === null) {
      lastActivity =
        startsAt !== null
          ? "Waiting for the start delay"
          : job.sim.resume
            ? "Waiting to continue"
            : "Waiting for a free slot";
    }
    out.set(view.id, {
      ...view,
      urgent: view.queue === "edits" && view.urgent,
      position: current.positions.get(view.id) ?? null,
      startsAt,
      lastActivity,
    });
  }
  return out;
}

export function viewOf(world: World, job: MockJob, clock: QueueClock): JobView {
  return viewsOf(world, clock).get(job.view.id) ?? job.view;
}

export function summaries(world: World, clock: { minuteMs: number }): QueueSummary[] {
  return QUEUES.map((queue) => ({
    queue,
    running: jobsOf(world, queue, "slot").length,
    waiting: jobsOf(world, queue, "queued").length,
    slots: limitsOf(world, queue, clock).slots,
  }));
}

function labelsOf(world: World, videoId: string): { channelName: string; folderName: string } {
  const { channelId, folderName } = splitVideoId(videoId) ?? { channelId: "", folderName: videoId };
  const channel = world.channels.find((c) => c.id === channelId);
  return { channelName: channel?.name ?? "", folderName };
}

/** The queue as one user sees it: their own jobs that have not ended. */
export function queueViewFor(world: World, user: MockUser, clock: QueueClock): QueueView {
  const views = viewsOf(world, clock);
  const jobs = world.jobs
    .filter((job) => job.view.userId === user.id && isActiveState(job.view.state))
    .map((job) => views.get(job.view.id) as JobView)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((job) => ({
      job,
      ...labelsOf(world, job.videoId),
      ahead: job.position === null ? null : job.position - 1,
    }));
  return { queues: summaries(world, clock), jobs };
}

/** The admin's queue: everybody's jobs that have not ended, each queue in its order. */
export function adminQueueView(world: World, clock: QueueClock): AdminQueueView {
  const views = viewsOf(world, clock);
  const jobs = world.jobs
    .filter((job) => isActiveState(job.view.state))
    .map((job) => views.get(job.view.id) as JobView)
    .sort(
      (a, b) =>
        QUEUES.indexOf(a.queue) - QUEUES.indexOf(b.queue) ||
        (a.position ?? 0) - (b.position ?? 0) ||
        a.joinedAt - b.joinedAt,
    )
    .map((job) => ({
      jobId: job.id,
      queue: job.queue,
      kind: job.kind,
      state: job.state as ActiveJobState,
      urgent: job.urgent,
      position: job.position,
      startsAt: job.startsAt,
      joinedAt: job.joinedAt,
      userId: job.userId,
      userEmail: world.users.find((u) => u.id === job.userId)?.email ?? "",
      ...labelsOf(world, job.videoId),
      videoId: job.videoId,
    }));
  return { queues: summaries(world, clock), jobs };
}
