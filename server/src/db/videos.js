// The `videos` table (docs/SPEC.md sections 6 and 15). A video is a folder in a channel directory;
// its wire id is `<channelId>/<folder name>`. A row is made the first time something must be
// remembered about a folder (a type override, inputs, an upload, a job, a session), and its random
// key is what other tables (`jobs`, `notes`, `uploads`, `revisions`) point at.

import { randomBytes } from "node:crypto";
import { invalidInput } from "../errors.js";
import { systemClock } from "./open.js";

/** @typedef {import("../../../src/lib/wire/channels.ts").VideoType} VideoType */
/** @typedef {import("../../../src/lib/wire/library.ts").VideoInputs} VideoInputs */
/** @typedef {"claudeCode" | "opencode2"} SessionHarness */

/**
 * @typedef {object} VideoRecord
 * @property {string} key The row id: 16 random bytes as hex.
 * @property {string} channelId
 * @property {string} folderName
 * @property {VideoType | null} typeOverride
 * @property {VideoInputs} inputs
 * @property {string | null} sessionId The agent session to resume, when one exists.
 * @property {SessionHarness | null} sessionHarness The program that made `sessionId`; only it may resume it.
 * @property {number | null} archivedAt Milliseconds; `null` when the video is not archived.
 * @property {unknown} progressMemory What the progress estimate remembers; `null` when nothing.
 * @property {number} createdAt
 */

/** Slots of a prompt or style list (`CHANNEL_SLOTS` in `channelProfile.js`). */
const SLOT_COUNT = 5;
/** The longest text of the product links field and of the notes field, in characters. */
export const MAX_INPUT_TEXT_CHARS = 20_000;

const COLUMNS = `id, channel_id, folder_name, type_override, inputs, session_id, session_harness,
  archived_at, progress_memory, created_at`;

/** @returns {VideoInputs} */
export function emptyInputs() {
  return { productLinks: "", notes: "", promptSlot: 0, styleSlot: 0 };
}

/**
 * Reads stored inputs leniently, like the Rust store: a damaged field or a slot that does not
 * exist falls back to the default instead of failing the whole library.
 * @param {unknown} raw
 * @returns {VideoInputs}
 */
export function parseInputs(raw) {
  const base = emptyInputs();
  if (typeof raw !== "string") return base;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return base;
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @param {unknown} slot */
  const slotOf = (slot) =>
    typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT ? slot : 0;
  return {
    productLinks: typeof record.productLinks === "string" ? record.productLinks : "",
    notes: typeof record.notes === "string" ? record.notes : "",
    promptSlot: slotOf(record.promptSlot),
    styleSlot: slotOf(record.styleSlot),
  };
}

/**
 * Checks inputs that arrive from the page; unlike `parseInputs` it refuses what is wrong.
 * @param {unknown} value
 * @returns {VideoInputs}
 * @throws {import("../errors.js").AppError} `invalidInput`
 */
export function validateInputs(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput("The video's inputs must be an object.");
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record)) {
    if (!["productLinks", "notes", "promptSlot", "styleSlot"].includes(key)) {
      throw invalidInput(`The video's inputs have no field called "${key}".`);
    }
  }
  /** @param {string} field @param {string} label */
  const text = (field, label) => {
    const entry = record[field];
    if (typeof entry !== "string") throw invalidInput(`The ${label} must be text.`);
    if ([...entry].length > MAX_INPUT_TEXT_CHARS) {
      throw invalidInput(`The ${label} can have at most ${MAX_INPUT_TEXT_CHARS} characters.`);
    }
    return entry;
  };
  /** @param {string} field @param {string} label */
  const slot = (field, label) => {
    const entry = record[field];
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry >= SLOT_COUNT) {
      throw invalidInput(`The selected ${label} must be a number from 0 to ${SLOT_COUNT - 1}.`);
    }
    return entry;
  };
  return {
    productLinks: text("productLinks", "product links"),
    notes: text("notes", "notes"),
    promptSlot: slot("promptSlot", "prompt"),
    styleSlot: slot("styleSlot", "style"),
  };
}

/** @param {unknown} raw */
function parseJson(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {import("./open.js").Row} row
 * @returns {VideoRecord}
 */
function toVideo(row) {
  return {
    key: String(row.id),
    channelId: String(row.channel_id),
    folderName: String(row.folder_name),
    typeOverride:
      row.type_override === "long" || row.type_override === "short" ? row.type_override : null,
    inputs: parseInputs(row.inputs),
    sessionId: row.session_id === null ? null : String(row.session_id),
    sessionHarness:
      row.session_harness === "claudeCode" || row.session_harness === "opencode2"
        ? row.session_harness
        : null,
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    progressMemory: parseJson(row.progress_memory),
    createdAt: Number(row.created_at),
  };
}

/**
 * @param {import("./open.js").Database} db
 * @param {{ clock?: import("./open.js").Clock }} [options]
 */
export function createVideosRepo(db, { clock = systemClock } = {}) {
  const repo = {
    /**
     * The row of a folder, when something was ever remembered about it.
     * @param {string} channelId
     * @param {string} folderName
     * @returns {VideoRecord | undefined}
     */
    find(channelId, folderName) {
      const row = db.get(
        `SELECT ${COLUMNS} FROM videos WHERE channel_id = ? AND folder_name = ?`,
        channelId,
        folderName,
      );
      return row ? toVideo(row) : undefined;
    },

    /**
     * The row of a folder, made when it does not exist yet. Calling it again changes nothing.
     * @param {string} channelId
     * @param {string} folderName
     * @returns {VideoRecord}
     */
    ensure(channelId, folderName) {
      return db.transaction(() => {
        db.run(
          "INSERT OR IGNORE INTO videos (id, channel_id, folder_name, created_at) VALUES (?, ?, ?, ?)",
          randomBytes(16).toString("hex"),
          channelId,
          folderName,
          clock.now(),
        );
        const video = repo.find(channelId, folderName);
        if (!video) throw new Error("The video row that was just added is missing.");
        return video;
      });
    },

    /** @param {string} key @returns {VideoRecord | undefined} */
    byKey(key) {
      const row = db.get(`SELECT ${COLUMNS} FROM videos WHERE id = ?`, key);
      return row ? toVideo(row) : undefined;
    },

    /**
     * Every row of the given channels.
     * @param {readonly string[]} channelIds
     * @returns {VideoRecord[]}
     */
    listForChannels(channelIds) {
      if (channelIds.length === 0) return [];
      const marks = channelIds.map(() => "?").join(", ");
      return db
        .all(`SELECT ${COLUMNS} FROM videos WHERE channel_id IN (${marks})`, ...channelIds)
        .map(toVideo);
    },

    /**
     * Sets or clears (`null`) the video's own Long or Short choice.
     * @param {string} key
     * @param {VideoType | null} type
     */
    setTypeOverride(key, type) {
      db.run("UPDATE videos SET type_override = ? WHERE id = ?", type, key);
    },

    /** @param {string} key @returns {VideoInputs | undefined} */
    getInputs(key) {
      return repo.byKey(key)?.inputs;
    },

    /**
     * Remembers the inputs of the video; they are checked first.
     * @param {string} key
     * @param {unknown} inputs
     * @returns {VideoInputs} What was stored.
     * @throws {import("../errors.js").AppError} `invalidInput`
     */
    setInputs(key, inputs) {
      const clean = validateInputs(inputs);
      db.run("UPDATE videos SET inputs = ? WHERE id = ?", JSON.stringify(clean), key);
      return clean;
    },

    /**
     * Remembers the agent session of the video and the program that made it.
     * @param {string} key
     * @param {string} sessionId
     * @param {SessionHarness} harness
     */
    setSession(key, sessionId, harness) {
      if (sessionId === "") throw new Error("A session id must not be empty.");
      if (harness !== "claudeCode" && harness !== "opencode2") {
        throw new Error(`Unknown harness "${String(harness)}".`);
      }
      db.run(
        "UPDATE videos SET session_id = ?, session_harness = ? WHERE id = ?",
        sessionId,
        harness,
        key,
      );
    },

    /** @param {string} key */
    clearSession(key) {
      db.run("UPDATE videos SET session_id = NULL, session_harness = NULL WHERE id = ?", key);
    },

    /**
     * What the progress estimate remembers about this video (JSON); `null` clears it.
     * @param {string} key
     * @param {unknown} memory
     */
    setProgressMemory(key, memory) {
      db.run(
        "UPDATE videos SET progress_memory = ? WHERE id = ?",
        memory === null || memory === undefined ? null : JSON.stringify(memory),
        key,
      );
    },

    /**
     * Archives (a time in milliseconds) or unarchives (`null`).
     * @param {string} key
     * @param {number | null} at
     */
    setArchived(key, at) {
      db.run("UPDATE videos SET archived_at = ? WHERE id = ?", at, key);
    },

    /**
     * The archived rows of the given channels, most recently archived first.
     * @param {readonly string[]} channelIds
     * @returns {VideoRecord[]}
     */
    listArchived(channelIds) {
      if (channelIds.length === 0) return [];
      const marks = channelIds.map(() => "?").join(", ");
      return db
        .all(
          `SELECT ${COLUMNS} FROM videos WHERE channel_id IN (${marks}) AND archived_at IS NOT NULL
           ORDER BY archived_at DESC, folder_name`,
          ...channelIds,
        )
        .map(toVideo);
    },

    /**
     * Forgets a folder: its row and, by cascade, its jobs, notes, revisions and uploads.
     * @param {string} key
     */
    remove(key) {
      db.run("DELETE FROM videos WHERE id = ?", key);
    },
  };
  return repo;
}

/** @typedef {ReturnType<typeof createVideosRepo>} VideosRepo */
