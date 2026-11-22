// Disk Cleanup functions of SPEC section 14: `getDiskUse` and `cleanWorkingFiles`. The service
// checks that the video is the signed-in user's own (an admin may clean anybody's).

import { requireSession } from "./context.js";
import { object, string } from "./validate.js";

/** A video id as the page sends it: `<channel id>/<folder name>`. */
const VIDEO_ID = string({ min: 3, max: 600 });

/**
 * @param {{ service: import("../disk/service.js").DiskService }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function diskFunctions({ service }) {
  return [
    {
      name: "getDiskUse",
      access: "user",
      handler(input, ctx) {
        object({})(input);
        return service.getDiskUse(requireSession(ctx).user.id);
      },
    },

    {
      name: "cleanWorkingFiles",
      access: "user",
      handler(input, ctx) {
        const { videoId } = object({ videoId: VIDEO_ID })(input);
        return service.cleanWorkingFiles(requireSession(ctx).user, videoId);
      },
    },
  ];
}
