// Channel rules (docs/SPEC.md section 6, "Channels" and "Videos"): the service functions for the
// admin's channel management (`adminList`, `adminCreate`, `adminUpdate`, `remove`,
// `checkChannelDir`; the admin RPCs are built on them), the owner's own changes (`update`: video type, prompts and styles), reorder, export and
// import (which only updates channels of the same name) and the default prompt.
//
// Directory rules (`checkChannelDir`): the real path of an existing directory, not the data
// directory nor anything around or inside it, and not the same as, inside, or around the
// directory of another channel.

import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createUsersRepo } from "./db/users.js";
import { AppError, conflict, invalidInput, notFound } from "./errors.js";
import { scanChannelDirectory } from "./library/scan.js";
import { pathApi } from "./platform/fsnames.js";
import { profileWithDefaults, sanitizeProfile, MAX_SLOT_TEXT_CHARS } from "./channelProfile.js";
import { DATA_DIR_MESSAGE, TAKEN_MESSAGE } from "./storage/paths.js";

/** @typedef {import("../../src/lib/wire/channels.ts").AdminChannel} AdminChannel */
/** @typedef {import("../../src/lib/wire/channels.ts").AdminChannelUpdate} AdminChannelUpdate */
/** @typedef {import("../../src/lib/wire/channels.ts").Channel} Channel */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelUpdate} ChannelUpdate */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelsDocument} ChannelsDocument */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelVideoType} ChannelVideoType */
/** @typedef {import("../../src/lib/wire/channels.ts").ImportResult} ImportResult */
/** @typedef {import("./db/channels.js").ChannelRecord} ChannelRecord */

export const MAX_CHANNEL_NAME_CHARS = 60;
/** Most channels one import file may carry. */
const MAX_IMPORTED_CHANNELS = 100;
const VIDEO_TYPES = ["auto", "long", "short"];
const DOCUMENT_FORMAT = "vidai-channels";
const NEWEST_DOCUMENT_VERSION = 1;

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Where the default prompt for new channels is read from: `default_prompt.md` of the toolkit
 * folder of the repository (it stays there, the installed toolkit does not carry it).
 * @returns {string[]}
 */
export function defaultPromptPaths() {
  const api = pathApi();
  return [api.join(REPO_ROOT, "toolkit", "default_prompt.md")];
}

/** Case-blind order of two texts, for the admin's list. @param {string} a @param {string} b */
const compareText = (a, b) => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A channel name: trimmed, 1 to 60 characters, no control characters.
 * @param {unknown} value
 * @returns {string}
 * @throws {AppError} `invalidInput`
 */
export function cleanChannelName(value) {
  if (typeof value !== "string") throw invalidInput("A channel name must be text.", "name");
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_CHANNEL_NAME_CHARS) {
    throw invalidInput(
      `A channel name must have 1 to ${MAX_CHANNEL_NAME_CHARS} characters.`,
      "name",
    );
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw invalidInput("A channel name cannot contain control characters.", "name");
  }
  return name;
}

/**
 * @param {{
 *   db: import("./db/open.js").Database,
 *   channels: import("./db/channels.js").ChannelsRepo,
 *   guard: import("./storage/paths.js").PathGuard,
 *   uploads: { cancelAllForChannel(channelId: string): Promise<void> },
 *   events: { emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void },
 *   clock: import("./db/open.js").Clock,
 *   hasActiveJobs?: (channelId: string) => boolean,
 *   onRemoved?: (channelId: string) => unknown,
 *   defaultPromptPaths?: string[],
 *   platform?: string,
 * }} deps
 */
export function createChannelsService({
  db,
  channels,
  guard,
  uploads,
  events,
  clock,
  hasActiveJobs = () => false,
  onRemoved = () => undefined,
  defaultPromptPaths: promptPaths = defaultPromptPaths(),
  platform = process.platform,
}) {
  const api = pathApi(platform);
  const users = createUsersRepo(db, { clock });

  /** @param {string} userId */
  function libraryChanged(userId) {
    events.emit({ event: "library-changed", payload: null, userId, admins: false });
  }

  /**
   * An admin made or removed one of the user's channels: their pages ask for the workspace again,
   * and for the library.
   * @param {string} userId
   */
  function workspaceChanged(userId) {
    events.emit({ event: "workspace-changed", payload: null, userId, admins: false });
    libraryChanged(userId);
  }

  /**
   * @param {string} userId
   * @param {string} channelId
   * @returns {ChannelRecord}
   */
  function requireOwn(userId, channelId) {
    const channel =
      typeof channelId === "string" ? channels.byIdForUser(channelId, userId) : undefined;
    if (!channel) throw notFound("That channel was not found.");
    return channel;
  }

  /** Whether the directory can be used now: reachable and unchanged. @param {ChannelRecord} channel */
  async function isAvailable(channel) {
    try {
      const real = await guard.resolve(channel.dir);
      return guard.isSame(real, channel.dir) && (await fsp.stat(real)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * @param {ChannelRecord} channel
   * @returns {Promise<Channel>}
   */
  async function toWire(channel) {
    return {
      id: channel.id,
      name: channel.name,
      dir: channel.dir,
      videoType: channel.videoType,
      long: channel.long,
      short: channel.short,
      available: await isAvailable(channel),
    };
  }

  /**
   * The admin's view of a channel: its owner, whether its folder can be reached, the video
   * folders in it (archived ones included) and whether a job of its videos is active.
   * @param {ChannelRecord} channel
   * @param {string} [ownerEmail] When the caller knows it already.
   * @returns {Promise<AdminChannel>}
   */
  async function toAdminWire(channel, ownerEmail) {
    const available = await isAvailable(channel);
    // `skip` keeps the scan to a directory listing: only the folder names are wanted.
    const videoCount = available
      ? (await scanChannelDirectory(channel.dir, { skip: () => true })).folderNames.length
      : 0;
    return {
      id: channel.id,
      name: channel.name,
      dir: channel.dir,
      userId: channel.userId,
      userEmail: ownerEmail ?? users.byId(channel.userId)?.email ?? "",
      videoType: channel.videoType,
      available,
      videoCount,
      busy: hasActiveJobs(channel.id),
    };
  }

  /**
   * @param {unknown} userId
   * @returns {{ id: string, email: string }}
   * @throws {AppError} `notFound` (`field: "userId"`)
   */
  function requireUser(userId) {
    const user = typeof userId === "string" ? users.byId(userId) : undefined;
    if (!user) throw new AppError("notFound", "That user was not found.", { field: "userId" });
    return user;
  }

  /**
   * The unique-name rule: 1 to 60 characters, unique for the user without regard to letter case.
   * @param {string} userId
   * @param {string} name
   * @param {string | null} exceptId
   */
  function assertNameFree(userId, name, exceptId) {
    const wanted = name.toLowerCase();
    const taken = channels
      .listForUser(userId)
      .some((channel) => channel.id !== exceptId && channel.name.toLowerCase() === wanted);
    if (taken) throw conflict("This user already has a channel with that name.", "name");
  }

  /**
   * The overlap rule against every channel of every user.
   * @param {string} real
   * @param {string | null} [exceptChannelId]
   * @throws {AppError} `conflict`
   */
  function assertNoChannelConflict(real, exceptChannelId = null) {
    for (const channel of channels.listAll()) {
      if (channel.id === exceptChannelId) continue;
      if (guard.isInside(channel.dir, real) || guard.isInside(real, channel.dir)) {
        throw conflict(TAKEN_MESSAGE);
      }
    }
  }

  /**
   * The directory rule of SPEC section 6, for a new channel and for a later change of its folder.
   * @param {unknown} dir A full path; links are followed.
   * @param {{ exceptChannelId?: string | null }} [options] A channel whose own directory is not
   *   an overlap (the one being changed).
   * @returns {Promise<string>} The real path to store.
   * @throws {AppError} `invalidInput` (with `field: "dir"`) for text that is no full path, a
   *   directory that does not exist, a file, or the data directory's own area; `conflict` for a
   *   directory that is, lies inside or holds another channel's.
   */
  async function checkChannelDir(dir, { exceptChannelId = null } = {}) {
    /** @type {string} */
    let real;
    try {
      real = await guard.resolve(dir);
    } catch (error) {
      if (error instanceof AppError && error.code === "invalidInput" && error.field === null) {
        throw invalidInput(error.message, "dir");
      }
      throw error;
    }
    let stat;
    try {
      stat = await fsp.stat(real);
    } catch {
      throw invalidInput("This folder does not exist.", "dir");
    }
    if (!stat.isDirectory()) throw invalidInput("A channel needs a folder, not a file.", "dir");
    if (await guard.touchesData(real)) throw invalidInput(DATA_DIR_MESSAGE, "dir");
    assertNoChannelConflict(real, exceptChannelId);
    return real;
  }

  /**
   * The default prompt of new channels.
   * @returns {Promise<string>}
   * @throws {AppError} `notFound` when no copy of the file exists.
   */
  async function defaultPrompt() {
    for (const file of promptPaths) {
      try {
        return await fsp.readFile(file, "utf8");
      } catch (error) {
        if (/** @type {{ code?: string }} */ (error).code !== "ENOENT") {
          throw new AppError("io", "The default prompt could not be read.", { cause: error });
        }
      }
    }
    throw notFound("The default prompt file is missing from this installation.");
  }

  /**
   * `<channel>/Style/STYLE.md`, when it exists, becomes style slot 0 once (the file is only read).
   * @param {string} dir
   * @returns {Promise<string>}
   */
  async function existingStyle(dir) {
    const file = api.join(dir, "Style", "STYLE.md");
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.size > MAX_SLOT_TEXT_CHARS) return "";
      return await fsp.readFile(file, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * Checks the name and the directory and adds the row with the default profiles; tells the owner.
   * @param {{ name: unknown, userId: string, dir: unknown, videoType: ChannelVideoType }} input
   * @returns {Promise<ChannelRecord>}
   */
  async function createRecord({ name: wanted, userId, dir, videoType }) {
    const name = cleanChannelName(wanted);
    assertNameFree(userId, name, null);
    const real = await checkChannelDir(dir);
    const style = await existingStyle(real);
    const profile = profileWithDefaults(await defaultPrompt(), style);
    const record = db.transaction(() => {
      assertNameFree(userId, name, null);
      assertNoChannelConflict(real);
      return channels.create({
        userId,
        name,
        dir: real,
        videoType,
        long: structuredClone(profile),
        short: structuredClone(profile),
      });
    });
    workspaceChanged(userId);
    return record;
  }

  const service = {
    defaultPrompt,

    /**
     * The user's channels in their order.
     * @param {string} userId
     * @returns {Promise<Channel[]>}
     */
    async list(userId) {
      return Promise.all(channels.listForUser(userId).map(toWire));
    },

    checkChannelDir,
    assertNameFree,

    /**
     * The admin's list: every user's channels ordered by owner email, then name.
     * @returns {Promise<AdminChannel[]>}
     */
    async adminList() {
      const emails = new Map(users.list().map((user) => [user.id, user.email]));
      const rows = await Promise.all(
        channels.listAll().map((channel) => toAdminWire(channel, emails.get(channel.userId) ?? "")),
      );
      return rows.sort(
        (a, b) =>
          compareText(a.userEmail, b.userEmail) ||
          compareText(a.name, b.name) ||
          compareText(a.id, b.id),
      );
    },

    /**
     * Makes a channel for a user around an existing directory (admin only; the user is not
     * checked here, `adminCreate` does). It goes last in the user's order. Tells the owner's pages.
     * @param {{ name: unknown, userId: string, dir: unknown, videoType: ChannelVideoType }} input
     * @returns {Promise<Channel>}
     * @throws {AppError} `invalidInput`, `conflict` (the name or the directory is taken)
     */
    async create(input) {
      return toWire(await createRecord(input));
    },

    /**
     * `create` for the admin's function: the owner must exist.
     * @param {{ name: unknown, userId: unknown, dir: unknown, videoType: ChannelVideoType }} input
     * @returns {Promise<AdminChannel>}
     * @throws {AppError} `notFound` (`field: "userId"`), `invalidInput`, `conflict`
     */
    async adminCreate(input) {
      const owner = requireUser(input.userId);
      return toAdminWire(await createRecord({ ...input, userId: owner.id }), owner.email);
    },

    /**
     * The admin's change of a channel (SPEC section 6). A `null` field stays as it is. A new owner
     * or a new folder is refused while a job of the channel's videos is active and ends the
     * unfinished uploads into the channel; the owner (and a previous owner) are told.
     * @param {string} channelId
     * @param {AdminChannelUpdate} patch
     * @returns {Promise<AdminChannel>}
     * @throws {AppError} `notFound`, `invalidInput`, `conflict`
     */
    async adminUpdate(channelId, patch) {
      const channel = typeof channelId === "string" ? channels.byId(channelId) : undefined;
      if (!channel) throw notFound("That channel was not found.");
      const name = patch.name === null ? channel.name : cleanChannelName(patch.name);
      const owner = patch.userId === null ? null : requireUser(patch.userId);
      const ownerId = owner?.id ?? channel.userId;
      const ownerChanged = ownerId !== channel.userId;
      const real =
        patch.dir === null
          ? channel.dir
          : await checkChannelDir(patch.dir, { exceptChannelId: channel.id });
      const dirChanged = !guard.isSame(real, channel.dir);
      const checkNow = () => {
        if (name !== channel.name || ownerChanged) assertNameFree(ownerId, name, channel.id);
        if (dirChanged) assertNoChannelConflict(real, channel.id);
        if ((ownerChanged || dirChanged) && hasActiveJobs(channel.id)) {
          throw conflict("Stop the running edits of this channel's videos first.");
        }
      };
      checkNow();
      // Part files are found through the channel's old row, so they go before it changes.
      if (ownerChanged || dirChanged) await uploads.cancelAllForChannel(channel.id);
      const updated = db.transaction(() => {
        checkNow();
        channels.adminUpdate(channel.id, {
          name,
          userId: ownerId,
          dir: dirChanged ? real : channel.dir,
          videoType: patch.videoType ?? channel.videoType,
        });
        const record = channels.byId(channel.id);
        if (!record) throw notFound("That channel was not found.");
        return record;
      });
      workspaceChanged(ownerId);
      if (ownerChanged) workspaceChanged(channel.userId);
      return toAdminWire(updated);
    },

    /**
     * The owner's own changes to a channel: video type, prompts and styles. Allowed while jobs
     * run: a job keeps the type and prompt it started with.
     * @param {string} userId
     * @param {string} channelId
     * @param {{ videoType?: ChannelVideoType | null, long?: import("../../src/lib/wire/channels.ts").ChannelProfile | null, short?: import("../../src/lib/wire/channels.ts").ChannelProfile | null }} patch
     *   Profiles must already be valid (`validateProfile`).
     * @returns {Promise<Channel>}
     */
    async update(userId, channelId, patch) {
      requireOwn(userId, channelId);
      const record = db.transaction(() => {
        channels.update(channelId, {
          ...(patch.videoType ? { videoType: patch.videoType } : {}),
          ...(patch.long ? { long: patch.long } : {}),
          ...(patch.short ? { short: patch.short } : {}),
        });
        return requireOwn(userId, channelId);
      });
      libraryChanged(userId);
      return toWire(record);
    },

    /**
     * Removes the channel's row and its videos' rows, then (through `onRemoved`) the server's own
     * folders of those videos; the directory and its files stay. Admin only. Tells the owner's pages.
     * @param {string} channelId
     * @throws {AppError} `notFound`; `conflict` while a job of its videos is active.
     */
    async remove(channelId) {
      const channel = typeof channelId === "string" ? channels.byId(channelId) : undefined;
      if (!channel) throw notFound("That channel was not found.");
      if (hasActiveJobs(channelId)) {
        throw conflict("Stop the running edits of this channel's videos first.");
      }
      // The rows of unfinished uploads go with the channel; their hidden part files must too.
      await uploads.cancelAllForChannel(channelId);
      channels.delete(channelId);
      workspaceChanged(channel.userId);
      await onRemoved(channelId);
    },

    /**
     * Gives the user's channels the order of `ids`.
     * @param {string} userId
     * @param {string[]} ids Every channel of the user exactly once.
     * @returns {Promise<Channel[]>}
     */
    async reorder(userId, ids) {
      const own = channels.listForUser(userId);
      for (const id of ids) requireOwn(userId, id);
      const unique = new Set(ids);
      if (unique.size !== ids.length || ids.length !== own.length) {
        throw invalidInput("The new order must list each of your channels exactly once.");
      }
      channels.setOrder(userId, ids);
      return service.list(userId);
    },

    /**
     * The user's channels' video types, prompts and styles as one document (never directories).
     * @param {string} userId
     * @returns {ChannelsDocument}
     */
    exportDocument(userId) {
      return {
        format: DOCUMENT_FORMAT,
        version: 1,
        exportedAt: new Date(clock.now()).toISOString(),
        channels: channels.listForUser(userId).map((channel) => ({
          name: channel.name,
          videoType: channel.videoType,
          long: channel.long,
          short: channel.short,
        })),
      };
    },

    /**
     * Applies a document made by `exportDocument`: a channel of the user's with the same name
     * (without regard to letter case) gets the video type, prompts and styles. No channel is
     * made; the names that match none come back in `skipped`, in the file's order. Everything
     * is checked first.
     * @param {{ id: string }} user
     * @param {unknown} document
     * @returns {Promise<ImportResult>}
     */
    async importDocument(user, document) {
      const entries = parseDocument(document);
      const result = db.transaction(() => {
        const own = new Map(
          channels.listForUser(user.id).map((channel) => [channel.name.toLowerCase(), channel]),
        );
        let updated = 0;
        /** @type {string[]} */
        const skipped = [];
        for (const entry of entries) {
          const current = own.get(entry.name.toLowerCase());
          if (!current) {
            skipped.push(entry.name);
            continue;
          }
          channels.update(current.id, {
            videoType: entry.videoType,
            long: entry.long,
            short: entry.short,
          });
          updated += 1;
        }
        return { updated, skipped };
      });
      libraryChanged(user.id);
      return result;
    },
  };
  return service;
}

/**
 * Reads and checks a channels document before anything changes.
 * @param {unknown} document
 * @returns {{ name: string, videoType: ChannelVideoType, long: import("../../src/lib/wire/channels.ts").ChannelProfile, short: import("../../src/lib/wire/channels.ts").ChannelProfile }[]}
 * @throws {AppError} `invalidInput`
 */
export function parseDocument(document) {
  if (!isRecord(document)) throw invalidInput("This is not a VidAI channels file.");
  if (document.format !== DOCUMENT_FORMAT) {
    throw invalidInput("This is not a VidAI channels file.");
  }
  if (
    typeof document.version !== "number" ||
    !Number.isInteger(document.version) ||
    document.version < 1
  ) {
    throw invalidInput("This channels file has no valid version.");
  }
  if (document.version > NEWEST_DOCUMENT_VERSION) {
    throw invalidInput("This file was made by a newer version of VidAI.");
  }
  if (!Array.isArray(document.channels)) throw invalidInput("This channels file has no channels.");
  if (document.channels.length > MAX_IMPORTED_CHANNELS) {
    throw invalidInput(`A channels file can have at most ${MAX_IMPORTED_CHANNELS} channels.`);
  }
  const seen = new Set();
  return document.channels.map((raw, index) => {
    if (!isRecord(raw)) throw invalidInput(`Channel ${index + 1} of the file is not valid.`);
    const name = cleanChannelName(raw.name);
    if (seen.has(name.toLowerCase())) {
      throw invalidInput(`The file has the channel "${name}" twice.`);
    }
    seen.add(name.toLowerCase());
    const videoType = VIDEO_TYPES.includes(/** @type {string} */ (raw.videoType))
      ? /** @type {ChannelVideoType} */ (raw.videoType)
      : "auto";
    return {
      name,
      videoType,
      long: sanitizeProfile(raw.long),
      short: sanitizeProfile(raw.short),
    };
  });
}
