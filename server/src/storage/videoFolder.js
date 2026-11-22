// From a video id to its folder on disk (docs/SPEC.md section 6, "Videos"): the id is
// `<channel id>/<folder name>`; the folder is found through the caller's own channel row and must be
// a real folder directly inside the channel directory. Uploads and file serving both use this, so
// a foreign or made-up id answers `notFound` the same way everywhere.

import fsp from "node:fs/promises";
import { AppError, conflict, notFound } from "../errors.js";
import { pathApi, segmentProblem } from "../platform/fsnames.js";
import { isReservedChannelEntry } from "./names.js";

/**
 * @typedef {object} ResolvedVideo
 * @property {import("../db/channels.js").ChannelRecord} channel
 * @property {string} channelDir Real path of the channel directory.
 * @property {string} folderName
 * @property {string} dir Real path of the video folder.
 */

/**
 * @param {{
 *   channels: import("../db/channels.js").ChannelsRepo,
 *   guard: import("./paths.js").PathGuard,
 *   platform?: string,
 * }} deps
 */
export function createVideoFolders({ channels, guard, platform = process.platform }) {
  const api = pathApi(platform);

  const missingVideo = () => notFound("That video was not found.");

  const folders = {
    /**
     * Splits `<channel id>/<folder name>`.
     * @param {unknown} id
     * @returns {{ channelId: string, folderName: string }}
     * @throws {AppError} `notFound` for anything that is not shaped like one.
     */
    parseVideoId(id) {
      if (typeof id !== "string") throw missingVideo();
      const slash = id.indexOf("/");
      if (slash < 1) throw missingVideo();
      return { channelId: id.slice(0, slash), folderName: id.slice(slash + 1) };
    },

    /**
     * The real directory of a channel of this user, checked to be reachable and unchanged.
     * @param {string} userId
     * @param {string} channelId
     * @returns {Promise<{ channel: import("../db/channels.js").ChannelRecord, dir: string }>}
     * @throws {AppError} `notFound` for a missing or foreign channel, `conflict` when its
     *   directory cannot be reached right now.
     */
    async channelDir(userId, channelId) {
      const channel = channels.byIdForUser(channelId, userId);
      if (!channel) throw notFound("That channel was not found.");
      const unreachable = () => conflict("This channel's folder cannot be reached right now.");
      /** @type {string} */
      let dir;
      try {
        dir = await guard.resolveFor(channel.dir, userId);
        if (!(await fsp.stat(dir)).isDirectory()) throw unreachable();
      } catch (error) {
        if (error instanceof AppError && error.code === "conflict") throw error;
        throw unreachable();
      }
      if (!guard.isSame(dir, channel.dir)) throw unreachable();
      return { channel, dir };
    },

    /**
     * The folder of one of the user's videos; it must exist.
     * @param {string} userId
     * @param {unknown} videoId
     * @returns {Promise<ResolvedVideo>}
     * @throws {AppError} `notFound` for a foreign, missing or odd video.
     */
    async resolveVideo(userId, videoId) {
      const { channelId, folderName } = folders.parseVideoId(videoId);
      if (!channels.byIdForUser(channelId, userId)) throw missingVideo();
      if (segmentProblem(folderName, platform) || isReservedChannelEntry(folderName)) {
        throw missingVideo();
      }
      const { channel, dir: channelDir } = await folders.channelDir(userId, channelId);
      /** @type {string} */
      let dir;
      try {
        dir = await guard.resolveInside(api.join(channelDir, folderName));
        if (!(await fsp.stat(dir)).isDirectory()) throw missingVideo();
      } catch {
        throw missingVideo();
      }
      // A video folder that is a link to somewhere else is not a video of this channel.
      if (!guard.isSame(api.dirname(dir), channelDir)) throw missingVideo();
      return { channel, channelDir, folderName, dir };
    },
  };
  return folders;
}

/** @typedef {ReturnType<typeof createVideoFolders>} VideoFolders */
