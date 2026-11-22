// Library functions of SPEC section 14: `getLibrary`, `setVideoTypeOverride`, `getVideoInputs`,
// `setVideoInputs`, `archiveVideo`, `unarchiveVideo`, `getArchived`. Every video id is checked
// against the signed-in user's channels by the service: another user's video answers `notFound`
// with the same message as one that does not exist. (`createVideo` is a storage function.)

import { requireSession } from "./context.js";
import { object, oneOf, string, withDefault } from "./validate.js";

/** A video id as the page sends it: `<channel id>/<folder name>`; the folder name has up to 255 characters. */
const VIDEO_ID = string({ min: 3, max: 600 });

/**
 * @param {{ service: import("../library/service.js").LibraryService }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function libraryFunctions({ service }) {
  return [
    {
      name: "getLibrary",
      access: "user",
      handler(_input, ctx) {
        const { user } = requireSession(ctx);
        return service.getLibrary(user.id, user.role);
      },
    },

    {
      name: "setVideoTypeOverride",
      access: "user",
      handler(input, ctx) {
        const { videoId, videoType } = object({
          videoId: VIDEO_ID,
          videoType: withDefault(oneOf(/** @type {const} */ (["long", "short"])), null),
        })(input);
        const { user } = requireSession(ctx);
        return service.setTypeOverride(user.id, user.role, videoId, videoType);
      },
    },

    {
      name: "getVideoInputs",
      access: "user",
      handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        return service.getInputs(requireSession(ctx).user.id, videoId);
      },
    },

    {
      name: "setVideoInputs",
      access: "user",
      handler(input, ctx) {
        // The inputs are checked field by field where they are stored (`db/videos.js`).
        const { videoId, inputs } = object({
          videoId: VIDEO_ID,
          inputs: (/** @type {unknown} */ value) => value,
        })(input);
        return service.setInputs(requireSession(ctx).user.id, videoId, inputs);
      },
    },

    {
      name: "archiveVideo",
      access: "user",
      async handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        await service.archive(requireSession(ctx).user.id, videoId);
        return null;
      },
    },

    {
      name: "unarchiveVideo",
      access: "user",
      async handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        await service.unarchive(requireSession(ctx).user.id, videoId);
        return null;
      },
    },

    {
      name: "getArchived",
      access: "user",
      handler: (_input, ctx) => service.getArchived(requireSession(ctx).user.id),
    },
  ];
}
