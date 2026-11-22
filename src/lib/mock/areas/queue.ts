/**
 * The queue area: the signed-in user's own jobs and the totals of the three queues. The admin's
 * view and its two actions are exported for the admin area (`adminQueue`, `adminSetJobUrgent`,
 * `adminStartJobNow`), which wraps them in its functions.
 */
import type { Api } from "../../api";
import type { AdminQueueView, JobView } from "../../types";
import type { MockCtx } from "../ctx";
import { adminQueueView, queueViewFor } from "../queue";
import { setJobUrgent, startJobNow } from "./jobs";

/** The admin's queue (everybody's jobs); the caller has checked `requireAdmin`. */
export function adminQueue(ctx: MockCtx): AdminQueueView {
  return adminQueueView(ctx.world, { now: ctx.clock.now(), minuteMs: ctx.clock.minuteMs });
}

/** Marks a waiting edit Urgent; the caller has checked `requireAdmin`. */
export function adminSetJobUrgent(ctx: MockCtx, jobId: string, urgent: boolean): JobView {
  return setJobUrgent(ctx, jobId, urgent);
}

/** Lets an edit held by the start delay start now; the caller has checked `requireAdmin`. */
export function adminStartJobNow(ctx: MockCtx, jobId: string): JobView {
  return startJobNow(ctx, jobId);
}

export function queueArea(ctx: MockCtx): Partial<Api> {
  return {
    getQueue: () =>
      ctx.run(() =>
        queueViewFor(ctx.world, ctx.requireUser(), {
          now: ctx.clock.now(),
          minuteMs: ctx.clock.minuteMs,
        }),
      ),
  };
}
