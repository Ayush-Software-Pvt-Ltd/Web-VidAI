// The `channels` table (docs/SPEC.md sections 6 and 15). Plain data in, plain camelCase objects
// out; the rules (names, directories, slots) are in `channels.js` one level up.

import { randomBytes } from "node:crypto";
import { conflict } from "../errors.js";
import { systemClock } from "./open.js";

/** @typedef {import("../../../src/lib/wire/channels.ts").ChannelProfile} ChannelProfile */
/** @typedef {import("../../../src/lib/wire/channels.ts").ChannelVideoType} ChannelVideoType */

/**
 * @typedef {object} ChannelRecord
 * @property {string} id
 * @property {string} userId
 * @property {string} name
 * @property {string} dir Real path, unique over all users.
 * @property {ChannelVideoType} videoType
 * @property {ChannelProfile} long
 * @property {ChannelProfile} short
 * @property {number} position 0-based, per user.
 * @property {number} createdAt
 */

const COLUMNS = "id, user_id, name, dir, video_type, profiles, position, created_at";

/**
 * @param {import("./open.js").Row} row
 * @returns {ChannelRecord}
 */
function toChannel(row) {
  const profiles = JSON.parse(String(row.profiles));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    dir: String(row.dir),
    videoType: /** @type {ChannelVideoType} */ (String(row.video_type)),
    long: profiles.long,
    short: profiles.short,
    position: Number(row.position),
    createdAt: Number(row.created_at),
  };
}

/** @param {unknown} error */
function constraint(error) {
  return error instanceof Error ? error.message : "";
}

/**
 * @param {import("./open.js").Database} db
 * @param {{ clock?: import("./open.js").Clock }} [options]
 */
export function createChannelsRepo(db, { clock = systemClock } = {}) {
  return {
    /**
     * Adds a channel at the end of the user's list.
     * @param {{ userId: string, name: string, dir: string, videoType: ChannelVideoType, long: ChannelProfile, short: ChannelProfile }} input
     * @returns {ChannelRecord}
     * @throws {import("../errors.js").AppError} `conflict` when the directory or the name is taken.
     */
    create({ userId, name, dir, videoType, long, short }) {
      const id = randomBytes(16).toString("hex");
      return db.transaction(() => {
        const last = db.get("SELECT MAX(position) AS last FROM channels WHERE user_id = ?", userId);
        const position = last && last.last !== null ? Number(last.last) + 1 : 0;
        try {
          db.run(
            `INSERT INTO channels (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            userId,
            name,
            dir,
            videoType,
            JSON.stringify({ long, short }),
            position,
            clock.now(),
          );
        } catch (error) {
          if (/UNIQUE constraint failed: channels\.dir/.test(constraint(error))) {
            throw conflict("This folder already belongs to a channel.");
          }
          if (
            /UNIQUE constraint failed: channels\.user_id, channels\.name/.test(constraint(error))
          ) {
            throw conflict("You already have a channel with this name.");
          }
          throw error;
        }
        const created = this.byId(id);
        if (!created) throw new Error("The channel that was just added is missing.");
        return created;
      });
    },

    /** @param {string} id @returns {ChannelRecord | undefined} */
    byId(id) {
      const row = db.get(`SELECT ${COLUMNS} FROM channels WHERE id = ?`, id);
      return row ? toChannel(row) : undefined;
    },

    /**
     * A channel only when it belongs to `userId`: a foreign id is as good as a missing one.
     * @param {string} id
     * @param {string} userId
     * @returns {ChannelRecord | undefined}
     */
    byIdForUser(id, userId) {
      const row = db.get(
        `SELECT ${COLUMNS} FROM channels WHERE id = ? AND user_id = ?`,
        id,
        userId,
      );
      return row ? toChannel(row) : undefined;
    },

    /** The user's channels in their order. @param {string} userId @returns {ChannelRecord[]} */
    listForUser(userId) {
      return db
        .all(
          `SELECT ${COLUMNS} FROM channels WHERE user_id = ? ORDER BY position, created_at`,
          userId,
        )
        .map(toChannel);
    },

    /** Every channel of every user, for the directory rules. @returns {ChannelRecord[]} */
    listAll() {
      return db.all(`SELECT ${COLUMNS} FROM channels`).map(toChannel);
    },

    /**
     * Changes the given fields.
     * @param {string} id
     * @param {{ name?: string, videoType?: ChannelVideoType, long?: ChannelProfile, short?: ChannelProfile }} patch
     * @throws {import("../errors.js").AppError} `conflict` when the name is taken.
     */
    update(id, patch) {
      db.transaction(() => {
        const current = this.byId(id);
        if (!current) return;
        try {
          db.run(
            "UPDATE channels SET name = ?, video_type = ?, profiles = ? WHERE id = ?",
            patch.name ?? current.name,
            patch.videoType ?? current.videoType,
            JSON.stringify({
              long: patch.long ?? current.long,
              short: patch.short ?? current.short,
            }),
            id,
          );
        } catch (error) {
          if (
            /UNIQUE constraint failed: channels\.user_id, channels\.name/.test(constraint(error))
          ) {
            throw conflict("You already have a channel with this name.");
          }
          throw error;
        }
      });
    },

    /**
     * Gives the user's channels the order of `ids`, which must be all of them.
     * @param {string} userId
     * @param {string[]} ids
     */
    setOrder(userId, ids) {
      db.transaction(() => {
        ids.forEach((id, position) => {
          db.run(
            "UPDATE channels SET position = ? WHERE id = ? AND user_id = ?",
            position,
            id,
            userId,
          );
        });
      });
    },

    /**
     * Removes the row; its videos' rows follow (foreign keys). Files are never touched.
     * @param {string} id
     */
    delete(id) {
      db.run("DELETE FROM channels WHERE id = ?", id);
    },
  };
}

/** @typedef {ReturnType<typeof createChannelsRepo>} ChannelsRepo */
