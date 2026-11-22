// Job functions of SPEC section 8: `startEdit`, `reEdit`, `pauseJob`, `continueJob`, `stopJob` and
// `getJobLog`. Access is "user": the manager checks that the job or video is the caller's (an
// admin may act on anyone's job) and answers `notFound` otherwise.
//
// Inputs are flat objects: `{ videoId, urgent }`, `{ videoId, text, urgent }`, `{ jobId }` and
// `{ jobId, after }`. `urgent` may be left out (false); `after` may be left out (the whole log).

import { requireSession } from "./context.js";
import { boolean, integer, object, optional, string, withDefault } from "./validate.js";

const VIDEO_ID = string({ min: 3, max: 600 });
const JOB_ID = string({ min: 1, max: 100 });

/** @param {import("./index.js").RpcContext} ctx @returns {import("../jobs/manager.js").Actor} */
const actorOf = (ctx) => {
  const { user } = requireSession(ctx);
  return { id: user.id, role: user.role };
};

/**
 * @param {{ manager: Pick<ReturnType<typeof import("../jobs/manager.js").createJobManager>, "startEdit" | "reEdit" | "pauseJob" | "continueJob" | "stopJob" | "getJobLog"> }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function jobsFunctions({ manager }) {
  return [
    {
      name: "startEdit",
      access: "user",
      handler(input, ctx) {
        const { videoId, urgent } = object({
          videoId: VIDEO_ID,
          urgent: withDefault(boolean, false),
        })(input);
        return manager.startEdit(actorOf(ctx), { videoId, urgent });
      },
    },
    {
      name: "reEdit",
      access: "user",
      handler(input, ctx) {
        const { videoId, text, urgent } = object({
          videoId: VIDEO_ID,
          text: string({ min: 1, max: 8000 }),
          urgent: withDefault(boolean, false),
        })(input);
        return manager.reEdit(actorOf(ctx), { videoId, text, urgent });
      },
    },
    {
      name: "pauseJob",
      access: "user",
      handler(input, ctx) {
        const { jobId } = object({ jobId: JOB_ID })(input);
        return manager.pauseJob(actorOf(ctx), { jobId });
      },
    },
    {
      name: "continueJob",
      access: "user",
      handler(input, ctx) {
        const { jobId } = object({ jobId: JOB_ID })(input);
        return manager.continueJob(actorOf(ctx), { jobId });
      },
    },
    {
      name: "stopJob",
      access: "user",
      handler(input, ctx) {
        const { jobId } = object({ jobId: JOB_ID })(input);
        return manager.stopJob(actorOf(ctx), { jobId });
      },
    },
    {
      name: "getJobLog",
      access: "user",
      handler(input, ctx) {
        const { jobId, after } = object({
          jobId: JOB_ID,
          after: optional(integer({ min: 0 })),
        })(input);
        return manager.getJobLog(actorOf(ctx), { jobId, after: after ?? null });
      },
    },
  ];
}
