// Timeline functions of SPEC section 14: `openTimeline`, `getTimeline`, `editTimeline`,
// `undoTimeline`, `redoTimeline`, `listRevisions`, `restoreRevision`, `addTimelineNote`,
// `deleteTimelineNote`, `retryTimelineNote`. (`renderFinal` belongs to rendering.)
//
// Inputs are flat objects: `{ videoId }`, `{ videoId, revision, op }`, `{ videoId, n }`,
// `{ videoId, frame, shape, elementId, prompt }` and `{ videoId, noteId }`. Every video id is
// checked against the signed-in user's channels by the library: a foreign video answers `notFound`.

import { requireSession } from "./context.js";
import { integer, object, string } from "./validate.js";

const VIDEO_ID = string({ min: 3, max: 600 });

/** Passed on as it is; the service checks it with sentences about the field. @param {unknown} value */
const unchecked = (value) => value;

/**
 * @param {{ service: import("../timeline/service.js").TimelineService }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function timelineFunctions({ service }) {
  return [
    {
      name: "openTimeline",
      access: "user",
      handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        const { user, id } = requireSession(ctx);
        return service.openTimeline({ userId: user.id, sessionId: id }, videoId);
      },
    },
    {
      name: "getTimeline",
      access: "user",
      handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        return service.getTimeline(requireSession(ctx).user.id, videoId);
      },
    },
    {
      name: "editTimeline",
      access: "user",
      handler(input, ctx) {
        const { videoId, revision, op } = object({
          videoId: VIDEO_ID,
          revision: integer({ min: 0 }),
          op: unchecked,
        })(input);
        return service.editTimeline(
          requireSession(ctx).user.id,
          videoId,
          revision,
          /** @type {import("../../../src/lib/wire/timeline.ts").TimelineOp} */ (op),
        );
      },
    },
    {
      name: "undoTimeline",
      access: "user",
      handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        return service.undoTimeline(requireSession(ctx).user.id, videoId);
      },
    },
    {
      name: "redoTimeline",
      access: "user",
      handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        return service.redoTimeline(requireSession(ctx).user.id, videoId);
      },
    },
    {
      name: "listRevisions",
      access: "user",
      handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        return service.listRevisions(requireSession(ctx).user.id, videoId);
      },
    },
    {
      name: "restoreRevision",
      access: "user",
      handler(input, ctx) {
        const { videoId, n } = object({ videoId: VIDEO_ID, n: integer({ min: 1 }) })(input);
        return service.restoreRevision(requireSession(ctx).user.id, videoId, n);
      },
    },
    {
      name: "addTimelineNote",
      access: "user",
      handler(input, ctx) {
        const { videoId, frame, shape, elementId, prompt } = object({
          videoId: VIDEO_ID,
          frame: unchecked,
          shape: unchecked,
          elementId: unchecked,
          prompt: unchecked,
        })(input);
        return service.addNote(requireSession(ctx).user.id, videoId, {
          frame,
          shape,
          elementId,
          prompt,
        });
      },
    },
    {
      name: "deleteTimelineNote",
      access: "user",
      async handler(input, ctx) {
        const { videoId, noteId } = object({
          videoId: VIDEO_ID,
          noteId: string({ min: 1, max: 64 }),
        })(input);
        await service.deleteNote(requireSession(ctx).user.id, videoId, noteId);
        return null;
      },
    },
    {
      name: "retryTimelineNote",
      access: "user",
      handler(input, ctx) {
        const { videoId, noteId } = object({
          videoId: VIDEO_ID,
          noteId: string({ min: 1, max: 64 }),
        })(input);
        return service.retryNote(requireSession(ctx).user.id, videoId, noteId);
      },
    },
  ];
}
