// Uploads (docs/SPEC.md section 6, "Uploads"). A user uploads files into a video folder or its
// B-roll folder. `create` checks the name, the size and that no such file exists; the browser then
// sends the bytes in order with `PUT /api/upload/<id>?offset=<n>`. Bytes go to the hidden
// `.<name>.<id>.part` file of the target folder (hidden from the scanner); when the last byte has
// arrived the file gets its name by a link that fails if the name is taken, so an existing file
// is never overwritten, not even one that appeared while the upload ran.
//
// What the browser can count on: the part file's size is the truth (the row only mirrors it), a
// request that breaks off keeps what arrived, a wrong offset changes nothing, and one upload has
// at most one writer at a time.

import { constants } from "node:fs";
import fsp from "node:fs/promises";
import { AppError, conflict, invalidInput, notFound } from "../errors.js";
import { foldName, pathApi } from "../platform/fsnames.js";
import { brollFolderName } from "./names.js";

/** @typedef {import("../../../src/lib/wire/storage.ts").UploadTicket} UploadTicket */
/** @typedef {import("../../../src/lib/wire/storage.ts").UploadState} UploadState */
/** @typedef {import("../../../src/lib/wire/storage.ts").UploadProgress} UploadProgress */
/** @typedef {import("../db/uploads.js").UploadRecord} UploadRecord */

export const GB = 1024 ** 3;
/** At most this many bytes in one `PUT`. */
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
/** Free disk space that must remain after the upload. */
export const FREE_SPACE_MARGIN = GB;
export const STALE_MS = 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** A body that sends nothing for this long counts as broken off (the HTTP layer sets no request timeout for uploads). */
export const IDLE_MS = 60 * 1000;

/** Video, audio, pictures, text (SPEC section 6). */
export const ALLOWED_EXTENSIONS = [
  "mp4",
  "mov",
  "m4v",
  "mkv",
  "mts",
  "m2ts",
  "avi",
  "webm",
  "wav",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "txt",
  "md",
  "srt",
];

/** A `PUT` whose offset is not where the upload is; `received` is where it is. */
export class OffsetConflict extends AppError {
  /** @param {number} received */
  constructor(received) {
    super("conflict", `The upload is at byte ${received}, so it must continue from there.`);
    this.name = "OffsetConflict";
    this.received = received;
  }
}

/**
 * @typedef {object} UploadHooks Test seams.
 * @property {(info: { part: string, final: string }) => void | Promise<void>} [beforeFinalize]
 *   Runs after the last byte is written and before the file gets its name.
 */

/**
 * @param {{
 *   repo: import("../db/uploads.js").UploadsRepo,
 *   folders: import("./videoFolder.js").VideoFolders,
 *   guard: import("./paths.js").PathGuard,
 *   settings: { getAll(): { maxUploadGb: number } },
 *   events: { emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void },
 *   clock: import("../db/open.js").Clock,
 *   log: import("../log.js").Logger,
 *   platform?: string,
 *   statfs?: (path: string) => Promise<{ bavail: number | bigint, bsize: number | bigint }>,
 *   hooks?: UploadHooks,
 *   maxChunkBytes?: number,
 *   staleMs?: number,
 *   cleanupIntervalMs?: number,
 *   idleMs?: number,
 *   timers?: Pick<typeof globalThis, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">,
 * }} deps
 */
export function createUploads({
  repo,
  folders,
  guard,
  settings,
  events,
  clock,
  log,
  platform = process.platform,
  statfs = (target) => fsp.statfs(target),
  hooks = {},
  maxChunkBytes = MAX_CHUNK_BYTES,
  staleMs = STALE_MS,
  cleanupIntervalMs = CLEANUP_INTERVAL_MS,
  idleMs = IDLE_MS,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
}) {
  const api = pathApi(platform);
  /** One writer per upload: the body being received, and a flag set by a cancel. */
  /** @type {Map<string, { body: import("node:stream").Readable, cancelled: boolean, finished: Promise<void> }>} */
  const writers = new Map();
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  /** @param {string} userId */
  function libraryChanged(userId) {
    events.emit({ event: "library-changed", payload: null, userId, admins: false });
  }

  /** @param {unknown} error */
  const codeOf = (error) => /** @type {{ code?: string }} */ (error).code;

  /**
   * The folder an upload's bytes go to.
   * @param {import("./videoFolder.js").ResolvedVideo} video
   * @param {"video" | "broll"} folder
   * @param {boolean} create Make the B-roll folder when it is missing.
   * @returns {Promise<string>} A real path directly inside the video folder (or the video folder).
   */
  async function targetFolder(video, folder, create) {
    if (folder === "video") return video.dir;
    const items = await fsp.readdir(video.dir, { withFileTypes: true });
    const names = items.filter((item) => item.isDirectory()).map((item) => item.name);
    const name = brollFolderName(names);
    const wanted = api.join(video.dir, name);
    if (create && !names.includes(name)) {
      try {
        await fsp.mkdir(wanted);
      } catch (error) {
        if (codeOf(error) !== "EEXIST") {
          throw new AppError("io", "The server cannot make the B-roll folder.", { cause: error });
        }
      }
    }
    const real = await guard.resolveInside(wanted).catch(() => null);
    const unusable = conflict("The B-roll folder of this video cannot be used.");
    if (real === null) throw unusable;
    // A B-roll folder that is a link elsewhere is not inside this video.
    if (!guard.isSame(api.dirname(real), video.dir)) throw unusable;
    const stat = await fsp.stat(real).catch(() => null);
    if (!stat?.isDirectory()) {
      if (create || stat) throw unusable;
      throw notFound("The B-roll folder of this video was not found.");
    }
    return real;
  }

  /**
   * @param {UploadRecord} row
   * @param {boolean} [create]
   */
  async function locate(row, create = false) {
    const video = await folders.resolveVideo(row.userId, `${row.channelId}/${row.folderName}`);
    const target = await targetFolder(video, row.folder, create);
    return {
      target,
      part: api.join(target, `.${row.name}.${row.id}.part`),
      final: api.join(target, row.name),
    };
  }

  /** @param {string} file @returns {Promise<number | null>} Size of a regular file, else null. */
  async function sizeOf(file) {
    try {
      const stat = await fsp.lstat(file);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }

  /**
   * What the server really has of an upload: the part file's size; with no part file an upload that
   * had everything is finished and any other starts again from 0. The row is brought in line.
   * @param {UploadRecord} row
   * @param {string} part
   * @returns {Promise<{ received: number, finished: boolean }>}
   */
  async function reconcile(row, part) {
    const actual = await sizeOf(part);
    if (actual === null) {
      const finished = row.received === row.size;
      const received = finished ? row.size : 0;
      if (received !== row.received) repo.setReceived(row.id, received);
      return { received, finished };
    }
    if (actual > row.size) {
      throw conflict("This upload has more data than it should. Cancel it and start again.");
    }
    if (actual !== row.received) repo.setReceived(row.id, actual);
    return { received: actual, finished: false };
  }

  /**
   * The last byte is in: give the file its name without ever replacing a file.
   * @param {UploadRecord} row
   * @param {string} part
   * @param {string} final
   */
  async function finalize(row, part, final) {
    await hooks.beforeFinalize?.({ part, final });
    const taken = () =>
      conflict(
        "A file with this name appeared in the folder while it was uploading. Cancel this upload and upload the file again under another name.",
      );
    try {
      // A hard link fails when the name exists, on every system, and the part file stays
      // until the name is ours.
      await fsp.link(part, final);
    } catch (error) {
      if (codeOf(error) === "EEXIST") throw taken();
      // Some shares and disks have no links: look first, then rename. The window between the
      // two is the price of such a disk.
      if (
        (await sizeOf(final)) !== null ||
        (await fsp.lstat(final).then(
          () => true,
          () => false,
        ))
      ) {
        throw taken();
      }
      try {
        await fsp.rename(part, final);
      } catch (renameError) {
        throw new AppError("io", "The server cannot save the uploaded file.", {
          cause: renameError,
        });
      }
      libraryChanged(row.userId);
      return;
    }
    await fsp.unlink(part).catch((error) => {
      log.warn("An uploaded file's part file could not be removed.", error);
    });
    libraryChanged(row.userId);
  }

  /**
   * Cuts the part file back to `length` after a refused or failed request.
   * @param {string} part
   * @param {number} length
   */
  async function truncateTo(part, length) {
    await fsp.truncate(part, length).catch(() => {});
  }

  /**
   * Deletes an upload's row and its hidden part file; never the finished file.
   * @param {UploadRecord} row
   */
  async function cancelRow(row) {
    const writer = writers.get(row.id);
    if (writer) {
      writer.cancelled = true;
      writer.body.destroy();
      await writer.finished;
    }
    try {
      const { part } = await locate(row);
      if ((await sizeOf(part)) !== null) await fsp.unlink(part);
    } catch (error) {
      // The folder may be gone; the row goes either way.
      if (!(error instanceof AppError)) log.warn("A part file could not be removed.", error);
    }
    repo.delete(row.id);
    libraryChanged(row.userId);
  }

  const uploads = {
    /**
     * Starts an upload.
     * @param {{ id: string }} user
     * @param {{ videoId: string, folder: "video" | "broll", name: string, size: number }} input
     * @returns {Promise<UploadTicket>}
     */
    async create(user, { videoId, folder, name, size }) {
      const safe = guard.safeName(name);
      const extension = safe.includes(".")
        ? safe.slice(safe.lastIndexOf(".") + 1).toLowerCase()
        : "";
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        throw invalidInput(
          "This kind of file cannot be uploaded. Videos, audio, pictures and text files (txt, md, srt) can.",
        );
      }
      if (!Number.isSafeInteger(size) || size < 1) throw invalidInput("That file is empty.");
      const maxGb = settings.getAll().maxUploadGb;
      if (size > maxGb * GB) {
        throw new AppError("tooLarge", `A file can be at most ${maxGb} GB.`);
      }

      const video = await folders.resolveVideo(user.id, videoId);
      const target = await targetFolder(video, folder, true);
      const final = api.join(target, safe);
      if (
        await fsp.lstat(final).then(
          () => true,
          () => false,
        )
      ) {
        throw conflict("A file with this name already exists in this folder.");
      }
      const wanted = foldName(safe, platform);
      for (const other of repo.listForTarget(video.channel.id, video.folderName, folder)) {
        if (foldName(other.name, platform) !== wanted) continue;
        const { part } = await locate(other).catch(() => ({ part: null }));
        const unfinished =
          other.received < other.size || (part !== null && (await sizeOf(part)) !== null);
        if (unfinished) throw conflict("A file with this name is already being uploaded.");
        repo.delete(other.id);
      }

      try {
        const free = await statfs(target);
        const available = Number(free.bavail) * Number(free.bsize);
        if (size + FREE_SPACE_MARGIN > available) {
          throw new AppError(
            "tooLarge",
            "The server does not have enough free disk space for this file.",
          );
        }
      } catch (error) {
        // A disk that cannot report its free space is not a reason to refuse.
        if (error instanceof AppError) throw error;
      }

      const row = repo.create({
        userId: user.id,
        channelId: video.channel.id,
        folderName: video.folderName,
        folder,
        name: safe,
        size,
      });
      libraryChanged(user.id);
      return { id: row.id, name: row.name, size: row.size, maxChunkBytes };
    },

    /**
     * How far an upload got.
     * @param {string} userId
     * @param {string} id
     * @returns {Promise<UploadState>}
     */
    async state(userId, id) {
      const row = repo.byIdForUser(id, userId);
      if (!row) throw notFound("That upload was not found.");
      const { part } = await locate(row);
      const { received, finished } = await reconcile(row, part);
      return { received, size: row.size, done: finished };
    },

    /**
     * Appends the body of one `PUT` when `offset` is where the upload is.
     * @param {string} userId
     * @param {string} id
     * @param {number} offset
     * @param {import("node:stream").Readable} body
     * @param {{ contentLength: number | null }} info The declared body length, null when unknown.
     * @returns {Promise<UploadProgress>}
     * @throws {OffsetConflict} for a wrong offset; `tooLarge` for a body over the chunk limit;
     *   `invalidInput` for bytes beyond the declared size; `conflict` while another request
     *   writes the same upload or when the name was taken meanwhile.
     */
    async append(userId, id, offset, body, { contentLength }) {
      const row = repo.byIdForUser(id, userId);
      if (!row) {
        body.resume();
        throw notFound("That upload was not found.");
      }
      if (writers.has(id)) {
        body.resume();
        throw conflict("This upload is already receiving data from another request.");
      }
      /** @type {() => void} */
      let release = () => {};
      const finished = new Promise((resolve) => {
        release = () => resolve(undefined);
      });
      const writer = { body, cancelled: false, finished: /** @type {Promise<void>} */ (finished) };
      writers.set(id, writer);
      try {
        return await receive(row, offset, body, contentLength, writer);
      } finally {
        writers.delete(id);
        release();
      }
    },

    /**
     * Stops an upload of this user and deletes its part file (never a finished file).
     * @param {string} userId
     * @param {string} id
     */
    async cancel(userId, id) {
      const row = repo.byIdForUser(id, userId);
      if (!row) throw notFound("That upload was not found.");
      await cancelRow(row);
    },

    /** @param {string} channelId */
    async cancelAllForChannel(channelId) {
      for (const row of repo.listForChannel(channelId)) await cancelRow(row);
    },

    /** @param {string} userId */
    async cancelAllForUser(userId) {
      for (const row of repo.listForUser(userId)) await cancelRow(row);
    },

    /** Deletes part files and rows untouched for longer than `staleMs`. */
    async cleanup() {
      const stale = repo.listTouchedBefore(clock.now() - staleMs);
      for (const row of stale) {
        if (writers.has(row.id)) continue;
        try {
          await cancelRow(row);
        } catch (error) {
          log.warn("A stale upload could not be removed.", error);
        }
      }
    },

    /** Cleans up now and then every `cleanupIntervalMs`. */
    async start() {
      await uploads.cleanup();
      timer = timers.setInterval(() => {
        void uploads.cleanup();
      }, cleanupIntervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
    },
  };

  /**
   * @param {UploadRecord} row
   * @param {number} offset
   * @param {import("node:stream").Readable} body
   * @param {number | null} contentLength
   * @param {{ cancelled: boolean }} writer
   * @returns {Promise<UploadProgress>}
   */
  async function receive(row, offset, body, contentLength, writer) {
    /** @param {AppError} error */
    const refuse = (error) => {
      // Read and drop what is left so the answer reaches a client that is still sending.
      body.resume();
      return error;
    };
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw refuse(invalidInput("The offset must be a whole number of bytes."));
    }
    const { part, final } = await locate(row).catch((error) => {
      throw refuse(error);
    });
    const have = await reconcile(row, part).catch((error) => {
      throw refuse(error);
    });

    if (have.received === row.size) {
      // Everything is in. An empty request asks to finish the job again, for instance after a
      // name clash was cleared away; nothing else can be added.
      if (contentLength !== null && contentLength > 0) {
        throw refuse(invalidInput("The file is complete; there is nothing more to add."));
      }
      if (offset !== row.size) throw refuse(new OffsetConflict(have.received));
      body.resume();
      if (!have.finished) {
        await finalize(row, part, final);
      }
      return { received: row.size, done: true };
    }
    if (offset !== have.received) throw refuse(new OffsetConflict(have.received));
    if (contentLength !== null) {
      if (contentLength > maxChunkBytes) {
        throw refuse(
          new AppError("tooLarge", "That is more than one request may carry. Send smaller pieces."),
        );
      }
      if (have.received + contentLength > row.size) {
        throw refuse(invalidInput("That is more data than the file has."));
      }
    }

    // O_NOFOLLOW: a link planted at the part file's name is never written through.
    const handle = await fsp
      .open(
        part,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o666,
      )
      .catch((error) => {
        throw refuse(
          new AppError("io", "The server cannot write the uploaded file.", { cause: error }),
        );
      });
    let total = 0;
    let aborted = false;
    const idle = timers.setTimeout(() => body.destroy(), idleMs);
    try {
      try {
        for await (const chunk of body) {
          const bytes = /** @type {Buffer} */ (chunk);
          idle.refresh();
          if (writer.cancelled) break;
          total += bytes.length;
          if (total > maxChunkBytes) {
            throw new AppError(
              "tooLarge",
              "That is more than one request may carry. Send smaller pieces.",
            );
          }
          if (have.received + total > row.size) {
            throw invalidInput("That is more data than the file has.");
          }
          let written = 0;
          while (written < bytes.length) {
            try {
              written += (await handle.write(bytes, written, bytes.length - written)).bytesWritten;
            } catch (error) {
              throw new AppError("io", "The server cannot write the uploaded file.", {
                cause: error,
              });
            }
          }
        }
      } catch (error) {
        if (error instanceof AppError) {
          // A refused request changes nothing.
          await handle.close().catch(() => {});
          await truncateTo(part, have.received);
          throw refuse(error);
        }
        // The browser went away: what arrived stays so it can continue.
        aborted = true;
      }
    } finally {
      timers.clearTimeout(idle);
      await handle.close().catch(() => {});
    }
    if (writer.cancelled) {
      throw conflict("This upload was cancelled.");
    }
    const now = await sizeOf(part);
    const received = aborted ? (now ?? have.received) : have.received + total;
    repo.setReceived(row.id, received);
    if (aborted) return { received, done: false };
    if (received === row.size) {
      await finalize(row, part, final);
      return { received, done: true };
    }
    return { received, done: false };
  }

  return uploads;
}

/** @typedef {ReturnType<typeof createUploads>} Uploads */
