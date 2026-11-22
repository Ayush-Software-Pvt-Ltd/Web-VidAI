// Storage functions of SPEC section 14: the admin's folder picker (`fsPlaces`, `fsList`,
// `fsCreateFolder`, admin only) and `listUploads`, `createUpload`, `cancelUpload`.
// The bytes of an upload are not RPC: they go to `PUT /api/upload/<id>` (storage/routes.js).

import { invalidInput } from "../errors.js";
import { requireSession } from "./context.js";
import { integer, object, oneOf, optional, string } from "./validate.js";

/** A path as the picker sends it back: long enough for any real one. */
const PATH = string({ min: 1, max: 4096 });

/**
 * The folder an upload goes to: `{ kind: "video", videoId }` or `{ kind: "channel", channelId }`.
 * @type {import("./validate.js").Validator<import("../../../src/lib/wire/storage.ts").UploadTarget>}
 */
function TARGET(value, field = "target") {
  const { kind } = object(
    { kind: oneOf(/** @type {const} */ (["video", "channel"])) },
    { allowUnknown: true },
  )(value, field);
  if (kind === "video") {
    const { videoId } = object({ kind: oneOf(["video"]), videoId: string({ min: 1, max: 600 }) })(
      value,
      field,
    );
    return { kind: "video", videoId };
  }
  const { channelId } = object({
    kind: oneOf(["channel"]),
    channelId: string({ min: 1, max: 64 }),
  })(value, field);
  return { kind: "channel", channelId };
}

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
      access: "admin",
      handler: () => browser.fsPlaces(),
    },

    {
      name: "fsList",
      access: "admin",
      handler(input) {
        const { path } = object({ path: optional(PATH) })(input);
        return browser.fsList(path ?? null);
      },
    },

    {
      name: "fsCreateFolder",
      access: "admin",
      handler(input) {
        const { parent, name } = object({ parent: PATH, name: string({ min: 1, max: 255 }) })(
          input,
        );
        return browser.fsCreateFolder(parent, name);
      },
    },

    {
      name: "listUploads",
      access: "user",
      handler(input, ctx) {
        const { target } = object({ target: TARGET })(input);
        return uploads.list(requireSession(ctx).user, target);
      },
    },

    {
      name: "createUpload",
      access: "user",
      handler(input, ctx) {
        const { target, name, size } = object({
          target: TARGET,
          name: string({ min: 1, max: 255 }),
          size: integer({ min: 0 }),
        })(input);
        if (size < 1) throw invalidInput("That file is empty.");
        return uploads.create(requireSession(ctx).user, { target, name, size });
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
