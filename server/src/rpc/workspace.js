// Workspace functions of SPEC section 14: the user's channels and the public settings
// (`getWorkspace`), the owner's changes to a channel (`updateChannel`: video type, prompts and
// styles), the order, the default prompt, and channels export and import. Making, renaming and
// removing channels is the admin's (`adminCreateChannel` and its siblings).

import { validateProfile } from "../channelProfile.js";
import { adminChannelFunctions } from "./adminChannels.js";
import { requireSession } from "./context.js";
import { array, object, oneOf, optional, string } from "./validate.js";

const VIDEO_TYPE = oneOf(/** @type {const} */ (["auto", "long", "short"]));
const ID = string({ min: 1, max: 64 });

/** @type {import("./validate.js").Validator<import("../../../src/lib/wire/channels.ts").ChannelProfile>} */
const profile = (value, field = "profile") => validateProfile(value, field);

/**
 * @param {{
 *   channels: ReturnType<typeof import("../channels.js").createChannelsService>,
 *   settings: { publicView(): import("../../../src/lib/wire.ts").PublicSettings },
 * }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function workspaceFunctions({ channels, settings }) {
  return [
    ...adminChannelFunctions({ channels }),

    {
      name: "getWorkspace",
      access: "user",
      async handler(_input, ctx) {
        /** @type {import("../../../src/lib/wire/channels.ts").Workspace} */
        const workspace = {
          channels: await channels.list(requireSession(ctx).user.id),
          settings: settings.publicView(),
          // The agents module (SPEC section 7) fills this with what new edits need on this computer.
          readiness: null,
        };
        return workspace;
      },
    },

    {
      name: "updateChannel",
      access: "user",
      handler(input, ctx) {
        const { id, update } = object({
          id: ID,
          update: object({
            videoType: optional(VIDEO_TYPE),
            long: optional(profile),
            short: optional(profile),
          }),
        })(input);
        return channels.update(requireSession(ctx).user.id, id, update);
      },
    },

    {
      name: "reorderChannels",
      access: "user",
      handler(input, ctx) {
        const { ids } = object({ ids: array(ID, { max: 1000 }) })(input);
        return channels.reorder(requireSession(ctx).user.id, ids);
      },
    },

    {
      name: "getDefaultPrompt",
      access: "user",
      handler: () => channels.defaultPrompt(),
    },

    {
      name: "exportChannels",
      access: "user",
      handler: (_input, ctx) => channels.exportDocument(requireSession(ctx).user.id),
    },

    {
      name: "importChannels",
      access: "user",
      handler(input, ctx) {
        const { document } = object({ document: (value) => value })(input);
        return channels.importDocument(requireSession(ctx).user, document);
      },
    },
  ];
}
