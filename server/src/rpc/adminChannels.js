// The admin's channel functions of SPEC section 14: list every user's channels, make one for a
// user, change its name, owner, folder or video type, and remove it. Users have none of these.

import { object, oneOf, optional, string } from "./validate.js";

const VIDEO_TYPE = oneOf(/** @type {const} */ (["auto", "long", "short"]));
const ID = string({ min: 1, max: 64 });

/**
 * A field of the form, named by its own input in every error whether it is sent flat or in `update`.
 * @template T
 * @param {string} field
 * @param {import("./validate.js").Validator<T>} inner
 * @returns {import("./validate.js").Validator<T>}
 */
const named = (field, inner) => (value) => inner(value, field);

// The length of a name is the service's rule (1 to 60 characters, trimmed); a path is checked there.
const NAME = named("name", string({ max: 1000 }));
const USER_ID = named("userId", string({ min: 1, max: 64 }));
const DIR = named("dir", string({ min: 1, max: 4096 }));

/**
 * @param {{ channels: ReturnType<typeof import("../channels.js").createChannelsService> }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function adminChannelFunctions({ channels }) {
  return [
    {
      name: "adminListChannels",
      access: "admin",
      handler: () => channels.adminList(),
    },

    {
      name: "adminCreateChannel",
      access: "admin",
      handler(input) {
        const clean = object({ name: NAME, userId: USER_ID, dir: DIR, videoType: VIDEO_TYPE })(
          input,
        );
        return channels.adminCreate(clean);
      },
    },

    {
      name: "adminUpdateChannel",
      access: "admin",
      handler(input) {
        const { id, update } = object({
          id: ID,
          update: object({
            name: optional(NAME),
            userId: optional(USER_ID),
            dir: optional(DIR),
            videoType: optional(VIDEO_TYPE),
          }),
        })(input);
        return channels.adminUpdate(id, {
          name: update.name ?? null,
          userId: update.userId ?? null,
          dir: update.dir ?? null,
          videoType: update.videoType ?? null,
        });
      },
    },

    {
      name: "adminRemoveChannel",
      access: "admin",
      async handler(input) {
        const { id } = object({ id: ID })(input);
        await channels.remove(id);
        return null;
      },
    },
  ];
}
