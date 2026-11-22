// Workspace functions of SPEC section 14: the user's channels and the public settings
// (`getWorkspace`), channel management, the default prompt, channels export and import, and
// `createVideo` (a new video folder in a channel).

import { invalidInput } from "../errors.js";
import { validateProfile } from "../channelProfile.js";
import { requireSession } from "./context.js";
import { array, object, oneOf, optional, string } from "./validate.js";

const VIDEO_TYPE = oneOf(/** @type {const} */ (["auto", "long", "short"]));
const ID = string({ min: 1, max: 64 });
const PATH = string({ min: 1, max: 4096 });

/** @type {import("./validate.js").Validator<import("../../../src/lib/wire/channels.ts").ChannelProfile>} */
const profile = (value, field = "profile") => validateProfile(value, field);

/**
 * Where a new channel's directory comes from: a new folder or an existing directory.
 * @type {import("./validate.js").Validator<import("../../../src/lib/wire/channels.ts").ChannelLocation>}
 */
function location(value, field = "location") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput(`The field "${field}" must be an object.`);
  }
  const kind = oneOf(/** @type {const} */ (["new", "link"]))(
    /** @type {{ kind?: unknown }} */ (value).kind,
    `${field}.kind`,
  );
  if (kind === "link") {
    const { dir } = object({ kind: oneOf(["link"]), dir: PATH })(value, field);
    return { kind: "link", dir };
  }
  const shape = object({
    kind: oneOf(["new"]),
    parent: optional(PATH),
    folderName: optional(string({ min: 1, max: 255 })),
  })(value, field);
  return { kind: "new", parent: shape.parent ?? null, folderName: shape.folderName ?? null };
}

/**
 * @param {{
 *   channels: ReturnType<typeof import("../channels.js").createChannelsService>,
 *   settings: { publicView(): import("../../../src/lib/wire.ts").PublicSettings },
 * }} deps
 * @returns {import("./index.js").RpcFunction[]}
 */
export function workspaceFunctions({ channels, settings }) {
  return [
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
      name: "createChannel",
      access: "user",
      handler(input, ctx) {
        const {
          name,
          videoType,
          location: where,
        } = object({
          name: string({ min: 1, max: 200 }),
          videoType: VIDEO_TYPE,
          location,
        })(input);
        return channels.create(requireSession(ctx).user, { name, videoType, location: where });
      },
    },

    {
      name: "updateChannel",
      access: "user",
      handler(input, ctx) {
        const { id, update } = object({
          id: ID,
          update: object({
            name: optional(string({ min: 1, max: 200 })),
            videoType: optional(VIDEO_TYPE),
            long: optional(profile),
            short: optional(profile),
          }),
        })(input);
        return channels.update(requireSession(ctx).user.id, id, update);
      },
    },

    {
      name: "removeChannel",
      access: "user",
      async handler(input, ctx) {
        const { id } = object({ id: ID })(input);
        await channels.remove(requireSession(ctx).user.id, id);
        return null;
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

    {
      name: "createVideo",
      access: "user",
      handler(input, ctx) {
        const { channelId, name } = object({ channelId: ID, name: string({ min: 1, max: 400 }) })(
          input,
        );
        return channels.createVideo(requireSession(ctx).user.id, channelId, name);
      },
    },
  ];
}
