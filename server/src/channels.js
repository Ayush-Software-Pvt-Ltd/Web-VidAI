// Channel rules (docs/SPEC.md section 6, "Channels" and "Videos"): create (a new folder or an
// existing directory), update, remove, reorder, export and import, the default prompt and new video
// folders. Names, slots and the default prompt are carried over from docs/SPEC-desktop.md section 4.
//
// Directory rules: a channel directory is a directory inside a storage folder, not a storage folder
// itself (nor a personal folder), not the data directory or anything around or inside it except
// under `media/`, and not the same as, inside, or around the directory of ANY user's channel.

import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AppError, conflict, invalidInput, notFound } from "./errors.js";
import { pathApi, nameProblem } from "./platform/fsnames.js";
import { profileWithDefaults, sanitizeProfile, MAX_SLOT_TEXT_CHARS } from "./channelProfile.js";
import { isReservedChannelEntry } from "./storage/names.js";
import { USER_ID_PATTERN } from "./storage/roots.js";

/** @typedef {import("../../src/lib/wire/channels.ts").Channel} Channel */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelCreate} ChannelCreate */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelUpdate} ChannelUpdate */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelsDocument} ChannelsDocument */
/** @typedef {import("../../src/lib/wire/channels.ts").ChannelVideoType} ChannelVideoType */
/** @typedef {import("../../src/lib/wire/channels.ts").ImportResult} ImportResult */
/** @typedef {import("../../src/lib/wire/channels.ts").VideoRef} VideoRef */
/** @typedef {import("./db/channels.js").ChannelRecord} ChannelRecord */

export const MAX_CHANNEL_NAME_CHARS = 60;
/** Most channels one import file may carry. */
const MAX_IMPORTED_CHANNELS = 100;
const TAKEN_MESSAGE = "This folder already belongs to a channel.";
const VIDEO_TYPES = ["auto", "long", "short"];
const DOCUMENT_FORMAT = "vidai-channels";
/** The desktop app's settings file, accepted so a team can bring its prompts along. */
const DESKTOP_FORMAT = "vidai-settings";

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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A channel name: trimmed, 1 to 60 characters, no control characters.
 * @param {unknown} value
 * @returns {string}
 * @throws {AppError} `invalidInput`
 */
export function cleanChannelName(value) {
  if (typeof value !== "string") throw invalidInput("A channel name must be text.");
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_CHANNEL_NAME_CHARS) {
    throw invalidInput(`A channel name must have 1 to ${MAX_CHANNEL_NAME_CHARS} characters.`);
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw invalidInput("A channel name cannot contain control characters.");
  }
  return name;
}

/**
 * The folder name a channel name makes when the user gave none: characters no folder can have
 * become dashes, dots and spaces at the ends go.
 * @param {string} name
 * @param {string} platform
 * @returns {string}
 */
export function folderNameFor(name, platform = process.platform) {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
  let text = name.replace(/[\u0000-\u001f\u007f-\u009f/\\\u202a-\u202e\u2066-\u2069]/g, "-");
  if (platform === "win32") text = text.replace(/[<>:"|?*]/g, "-");
  text = text
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  text = [...text].slice(0, 120).join("");
  return nameProblem(text, { platform, maxChars: 120 }) ? "Channel" : text;
}

/**
 * @param {{
 *   db: import("./db/open.js").Database,
 *   channels: import("./db/channels.js").ChannelsRepo,
 *   roots: import("./storage/roots.js").StorageRoots,
 *   guard: import("./storage/paths.js").PathGuard,
 *   folders: import("./storage/videoFolder.js").VideoFolders,
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
  roots,
  guard,
  folders,
  uploads,
  events,
  clock,
  hasActiveJobs = () => false,
  onRemoved = () => undefined,
  defaultPromptPaths: promptPaths = defaultPromptPaths(),
  platform = process.platform,
}) {
  const api = pathApi(platform);

  /** @param {string} userId */
  function libraryChanged(userId) {
    events.emit({ event: "library-changed", payload: null, userId, admins: false });
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

  /** Whether the directory can be used now: reachable, inside a storage folder, unchanged. @param {ChannelRecord} channel */
  async function isAvailable(channel) {
    try {
      const real = await guard.resolveFor(channel.dir, channel.userId);
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
    if (taken) throw conflict("You already have a channel with this name.");
  }

  /**
   * The directory rule against every channel of every user (SPEC section 6).
   * @param {string} real
   * @throws {AppError} `conflict`
   */
  function assertNoChannelConflict(real) {
    for (const channel of channels.listAll()) {
      if (guard.isInside(channel.dir, real) || guard.isInside(real, channel.dir)) {
        throw conflict(TAKEN_MESSAGE);
      }
    }
  }

  /**
   * Checks that a real path may become a channel directory.
   * @param {string} real
   * @throws {AppError} `invalidInput`, `conflict`
   */
  async function assertUsableDirectory(real) {
    let stat;
    try {
      stat = await fsp.stat(real);
    } catch {
      throw invalidInput("This folder does not exist.");
    }
    if (!stat.isDirectory()) throw invalidInput("A channel needs a folder, not a file.");

    const media = await roots.mediaPath();
    const data = await roots.dataPath();
    const storage = await roots.realPaths();
    const itself = invalidInput(
      "A storage folder cannot be a channel itself. Choose or make a folder inside it.",
    );
    if (storage.some((root) => guard.isSame(root, real) || guard.isInside(real, root)))
      throw itself;
    if (guard.isInside(media, real)) {
      // `media/<user id>` is somebody's personal folder: channels live inside it, not as it.
      const first = api.relative(media, real).split(/[\\/]/)[0] ?? "";
      if (USER_ID_PATTERN.test(first) && guard.isSame(api.join(media, first), real)) throw itself;
    } else if (guard.isInside(data, real) || guard.isInside(real, data)) {
      throw invalidInput("This folder is inside VidAI's own data folder.");
    }
    assertNoChannelConflict(real);
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
   * Makes a folder, adding " 2", " 3"... when the name is taken.
   * @param {string} parent
   * @param {string} base
   * @returns {Promise<string>} The path of the new folder.
   */
  async function makeUniqueFolder(parent, base) {
    for (let attempt = 1; attempt < 1000; attempt++) {
      const name = attempt === 1 ? base : `${base} ${attempt}`;
      const target = api.join(parent, name);
      try {
        await fsp.mkdir(target);
        return target;
      } catch (error) {
        if (/** @type {{ code?: string }} */ (error).code !== "EEXIST") {
          throw new AppError("io", "The server cannot make this folder.", { cause: error });
        }
      }
    }
    throw conflict("A folder for this channel could not be named.");
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

    /**
     * Makes a channel, with a new folder or around an existing directory.
     * @param {{ id: string }} user
     * @param {ChannelCreate} input
     * @returns {Promise<Channel>}
     */
    async create(user, input) {
      const name = cleanChannelName(input.name);
      assertNameFree(user.id, name, null);
      /** @type {string} */
      let real;
      /** @type {string} */
      let style = "";
      if (input.location.kind === "link") {
        real = await guard.resolveFor(input.location.dir, user.id);
        await assertUsableDirectory(real);
        style = await existingStyle(real);
      } else {
        const parent =
          input.location.parent === null
            ? await roots.personalFolder(user.id)
            : await guard.resolveFor(input.location.parent, user.id);
        const folderName = guard.safeName(
          input.location.folderName ?? folderNameFor(name, platform),
          {
            maxChars: 120,
          },
        );
        const target = api.join(parent, folderName);
        // Refuse before making anything: a folder inside a channel must not appear.
        assertNoChannelConflict(target);
        try {
          await fsp.mkdir(target);
        } catch (error) {
          const code = /** @type {{ code?: string }} */ (error).code;
          if (code === "EEXIST") throw conflict("A folder with this name already exists there.");
          if (code === "ENOENT" || code === "ENOTDIR") {
            throw invalidInput("The folder to put it in does not exist.");
          }
          throw new AppError("io", "The server cannot make this folder.", { cause: error });
        }
        real = await guard.resolveFor(target, user.id);
        await assertUsableDirectory(real);
      }
      const prompt = await defaultPrompt();
      const profile = profileWithDefaults(prompt, style);
      const record = db.transaction(() => {
        assertNameFree(user.id, name, null);
        assertNoChannelConflict(real);
        return channels.create({
          userId: user.id,
          name,
          dir: real,
          videoType: input.videoType,
          long: structuredClone(profile),
          short: structuredClone(profile),
        });
      });
      libraryChanged(user.id);
      return toWire(record);
    },

    /**
     * Changes a channel's name, video type or profiles. Allowed while jobs run: a job keeps the
     * type and prompt it started with.
     * @param {string} userId
     * @param {string} channelId
     * @param {{ name?: string | null, videoType?: ChannelVideoType | null, long?: import("../../src/lib/wire/channels.ts").ChannelProfile | null, short?: import("../../src/lib/wire/channels.ts").ChannelProfile | null }} patch
     *   Profiles must already be valid (`validateProfile`).
     * @returns {Promise<Channel>}
     */
    async update(userId, channelId, patch) {
      requireOwn(userId, channelId);
      const name =
        patch.name === null || patch.name === undefined ? undefined : cleanChannelName(patch.name);
      const record = db.transaction(() => {
        if (name !== undefined) assertNameFree(userId, name, channelId);
        channels.update(channelId, {
          ...(name !== undefined ? { name } : {}),
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
     * folders of those videos; the directory and its files stay.
     * @param {string} userId
     * @param {string} channelId
     * @throws {AppError} `conflict` while a job of its videos is active.
     */
    async remove(userId, channelId) {
      requireOwn(userId, channelId);
      if (hasActiveJobs(channelId)) {
        throw conflict("Stop the running edits of this channel's videos first.");
      }
      // The rows of unfinished uploads go with the channel; their hidden part files must too.
      await uploads.cancelAllForChannel(channelId);
      channels.delete(channelId);
      libraryChanged(userId);
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
     * Applies a document made by `exportDocument` (or the desktop app's settings file): a channel of
     * the same name (without regard to letter case) gets the video type, prompts and styles; the
     * others are made with a new folder in the personal folder. Everything is checked first.
     * @param {{ id: string }} user
     * @param {unknown} document
     * @returns {Promise<ImportResult>}
     */
    async importDocument(user, document) {
      const entries = parseDocument(document);
      const existing = new Map(
        channels.listForUser(user.id).map((channel) => [channel.name.toLowerCase(), channel]),
      );
      const fresh = entries.filter((entry) => !existing.has(entry.name.toLowerCase()));
      /** @type {Map<string, string>} */
      const made = new Map();
      if (fresh.length > 0) {
        const personal = await roots.personalFolder(user.id);
        for (const entry of fresh) {
          const target = await makeUniqueFolder(personal, folderNameFor(entry.name, platform));
          made.set(entry.name.toLowerCase(), await guard.resolveFor(target, user.id));
        }
      }
      const result = db.transaction(() => {
        let updated = 0;
        let created = 0;
        for (const entry of entries) {
          const key = entry.name.toLowerCase();
          const current = channels.listForUser(user.id).find((c) => c.name.toLowerCase() === key);
          if (current) {
            channels.update(current.id, {
              videoType: entry.videoType,
              long: entry.long,
              short: entry.short,
            });
            updated += 1;
            continue;
          }
          const dir = made.get(key);
          if (dir === undefined) throw new Error("A new channel has no folder.");
          assertNoChannelConflict(dir);
          channels.create({ userId: user.id, name: entry.name, dir, ...pick(entry) });
          created += 1;
        }
        return { updated, created };
      });
      libraryChanged(user.id);
      return result;
    },

    /**
     * Makes a new video folder in one of the user's channels.
     * @param {string} userId
     * @param {string} channelId
     * @param {unknown} name 1 to 120 characters, one path segment, not a reserved name.
     * @returns {Promise<VideoRef>}
     */
    async createVideo(userId, channelId, name) {
      const { channel, dir } = await folders.channelDir(userId, channelId);
      const folderName = guard.safeName(typeof name === "string" ? name.trim() : name, {
        maxChars: 120,
      });
      if (isReservedChannelEntry(folderName)) {
        throw invalidInput("This name is reserved. Choose another name for the video.");
      }
      try {
        await fsp.mkdir(api.join(dir, folderName));
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code === "EEXIST")
          throw conflict("A video with this name already exists in this channel.");
        throw new AppError("io", "The server cannot make this folder.", { cause: error });
      }
      libraryChanged(userId);
      return { id: `${channel.id}/${folderName}`, channelId: channel.id, folderName };
    },
  };
  return service;
}

/**
 * @param {{ videoType: ChannelVideoType, long: import("../../src/lib/wire/channels.ts").ChannelProfile, short: import("../../src/lib/wire/channels.ts").ChannelProfile }} entry
 */
function pick({ videoType, long, short }) {
  return { videoType, long, short };
}

/**
 * Reads and checks a channels document before anything changes.
 * @param {unknown} document
 * @returns {{ name: string, videoType: ChannelVideoType, long: import("../../src/lib/wire/channels.ts").ChannelProfile, short: import("../../src/lib/wire/channels.ts").ChannelProfile }[]}
 * @throws {AppError} `invalidInput`
 */
export function parseDocument(document) {
  if (!isRecord(document)) throw invalidInput("This is not a VidAI channels file.");
  const desktop = document.format === DESKTOP_FORMAT;
  if (document.format !== DOCUMENT_FORMAT && !desktop) {
    throw invalidInput("This is not a VidAI channels file.");
  }
  const newest = desktop ? 2 : 1;
  if (
    typeof document.version !== "number" ||
    !Number.isInteger(document.version) ||
    document.version < 1
  ) {
    throw invalidInput("This channels file has no valid version.");
  }
  if (document.version > newest) {
    throw invalidInput("This file was made by a newer version of VidAI.");
  }
  if (!Array.isArray(document.channels)) throw invalidInput("This channels file has no channels.");
  if (document.channels.length > MAX_IMPORTED_CHANNELS) {
    throw invalidInput(`A channels file can have at most ${MAX_IMPORTED_CHANNELS} channels.`);
  }
  const seen = new Set();
  return document.channels.map((raw, index) => {
    if (!isRecord(raw)) throw invalidInput(`Channel ${index + 1} of the file is not valid.`);
    // The desktop file names a channel by its folder; that name may be longer than a channel name allows.
    const text = desktop && typeof raw.folderName === "string" ? raw.folderName.trim() : raw.name;
    const name = cleanChannelName(
      desktop && typeof text === "string"
        ? [...text].slice(0, MAX_CHANNEL_NAME_CHARS).join("")
        : text,
    );
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
