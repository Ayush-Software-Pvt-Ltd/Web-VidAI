// Storage functions of SPEC section 14: the in-page folder picker (`fsPlaces`, `fsList`,
// `fsCreateFolder`) and `createUpload`, `cancelUpload`. The bytes of an upload are not RPC: they go
// to `PUT /api/upload/<id>` (storage/routes.js).

import { invalidInput } from "../errors.js";
import { requireSession } from "./context.js";
import { integer, object, oneOf, optional, string } from "./validate.js";

/** A path as the picker sends it back: long enough for any real one. */
const PATH = string({ min: 1, max: 4096 });

/**
 * @param {{
 *   browser: import("../storage/browse.js").Browser,
 *   uploads: import("../storage/uploads.js").Uploads,
 * }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function storageFunctions({ browser, uploads }) {
  return [
    {
      name: "fsPlaces",
      access: "user",
      handler: (_input, ctx) => browser.fsPlaces(requireSession(ctx).user),
    },

    {
      name: "fsList",
      access: "user",
      handler(input, ctx) {
        const { path } = object({ path: optional(PATH) })(input);
        return browser.fsList(path ?? null, requireSession(ctx).user);
      },
    },

    {
      name: "fsCreateFolder",
      access: "user",
      handler(input, ctx) {
        const { parent, name } = object({ parent: PATH, name: string({ min: 1, max: 255 }) })(
          input,
        );
        return browser.fsCreateFolder(parent, name, requireSession(ctx).user);
      },
    },

    {
      name: "createUpload",
      access: "user",
      handler(input, ctx) {
        const shape = object({
          videoId: string({ min: 1, max: 600 }),
          folder: oneOf(/** @type {const} */ (["video", "broll"])),
          name: string({ min: 1, max: 255 }),
          size: integer({ min: 0 }),
        });
        const { videoId, folder, name, size } = shape(input);
        if (size < 1) throw invalidInput("That file is empty.");
        return uploads.create(requireSession(ctx).user, { videoId, folder, name, size });
      },
    },

    {
      name: "cancelUpload",
      access: "user",
      async handler(input, ctx) {
        const { id } = object({ id: string({ min: 1, max: 64 }) })(input);
        await uploads.cancel(requireSession(ctx).user.id, id);
        return null;
      },
    },
  ];
}
