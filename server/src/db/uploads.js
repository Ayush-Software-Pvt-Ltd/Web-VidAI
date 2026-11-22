// The `uploads` table (docs/SPEC.md sections 6 and 15). An upload names its channel and, for an
// upload into a video's `upload` folder, the video's row in `videos` (a row made the first time
// something must be remembered about a folder, which an upload is), so this repository also makes
// that row when it is missing.

import { randomBytes } from "node:crypto";
import { systemClock } from "./open.js";
import { createVideosRepo } from "./videos.js";

/**
 * @typedef {object} UploadRecord
 * @property {string} id
 * @property {string} userId
 * @property {string} channelId
 * @property {string | null} videoKey The `videos.id` row; null for an upload into the channel's folder.
 * @property {string | null} folderName The video folder's name inside the channel directory; null for a channel upload.
 * @property {string} name The file name the upload will have.
 * @property {number} size Declared size in bytes.
 * @property {number} received Bytes in order that the server has.
 * @property {number} createdAt
 * @property {number} touchedAt Milliseconds of the last `PUT`.
 */

const SELECT = `SELECT u.id, u.user_id, u.channel_id, u.video_id, v.folder_name, u.name,
  u.size, u.received, u.created_at, u.touched_at
  FROM uploads u LEFT JOIN videos v ON v.id = u.video_id`;

/**
 * @param {import("./open.js").Row} row
 * @returns {UploadRecord}
 */
function toUpload(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    channelId: String(row.channel_id),
    videoKey: row.video_id === null ? null : String(row.video_id),
    folderName: row.folder_name === null ? null : String(row.folder_name),
    name: String(row.name),
    size: Number(row.size),
    received: Number(row.received),
    createdAt: Number(row.created_at),
    touchedAt: Number(row.touched_at),
  };
}

/**
 * @param {import("./open.js").Database} db
 * @param {{ clock?: import("./open.js").Clock }} [options]
 */
export function createUploadsRepo(db, { clock = systemClock } = {}) {
  const videos = createVideosRepo(db, { clock });
  return {
    /**
     * Adds an upload (and the video's row when it is aimed at a video that has none yet).
     * @param {{ userId: string, channelId: string, folderName: string | null, name: string, size: number }} input
     *   `folderName` null: the channel's own `upload` folder.
     * @returns {UploadRecord}
     */
    create({ userId, channelId, folderName, name, size }) {
      const id = randomBytes(16).toString("hex");
      return db.transaction(() => {
        const now = clock.now();
        const video = folderName === null ? null : videos.ensure(channelId, folderName);
        db.run(
          `INSERT INTO uploads (id, user_id, channel_id, video_id, name, size, received, created_at, touched_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          id,
          userId,
          channelId,
          video ? video.key : null,
          name,
          size,
          now,
          now,
        );
        const created = this.byId(id);
        if (!created) throw new Error("The upload that was just added is missing.");
        return created;
      });
    },

    /** @param {string} id @returns {UploadRecord | undefined} */
    byId(id) {
      const row = db.get(`${SELECT} WHERE u.id = ?`, id);
      return row ? toUpload(row) : undefined;
    },

    /**
     * An upload only when it belongs to `userId`: a foreign id is as good as a missing one.
     * @param {string} id
     * @param {string} userId
     * @returns {UploadRecord | undefined}
     */
    byIdForUser(id, userId) {
      const row = db.get(`${SELECT} WHERE u.id = ? AND u.user_id = ?`, id, userId);
      return row ? toUpload(row) : undefined;
    },

    /**
     * The uploads aimed at the same folder, for the name check.
     * @param {string} channelId
     * @param {string | null} folderName A video's folder name, or null for the channel's own folder.
     * @returns {UploadRecord[]}
     */
    listForTarget(channelId, folderName) {
      if (folderName === null) {
        return db
          .all(`${SELECT} WHERE u.channel_id = ? AND u.video_id IS NULL`, channelId)
          .map(toUpload);
      }
      return db
        .all(`${SELECT} WHERE u.channel_id = ? AND v.folder_name = ?`, channelId, folderName)
        .map(toUpload);
    },

    /** @param {string} userId @returns {UploadRecord[]} */
    listForUser(userId) {
      return db.all(`${SELECT} WHERE u.user_id = ?`, userId).map(toUpload);
    },

    /**
     * Every upload into the channel's folder and into its videos' folders.
     * @param {string} channelId
     * @returns {UploadRecord[]}
     */
    listForChannel(channelId) {
      return db.all(`${SELECT} WHERE u.channel_id = ?`, channelId).map(toUpload);
    },

    /** Uploads whose last `PUT` was before `before`. @param {number} before @returns {UploadRecord[]} */
    listTouchedBefore(before) {
      return db.all(`${SELECT} WHERE u.touched_at < ?`, before).map(toUpload);
    },

    /**
     * How many uploads into a video's own `upload` folder are not complete (a video with one does
     * not offer Start Editing); uploads into the channel's folder are not counted.
     * @param {string} channelId
     * @param {string} folderName
     * @returns {number}
     */
    countInProgress(channelId, folderName) {
      const row = db.get(
        `SELECT COUNT(*) AS n FROM uploads u JOIN videos v ON v.id = u.video_id
         WHERE v.channel_id = ? AND v.folder_name = ? AND u.received < u.size`,
        channelId,
        folderName,
      );
      return row ? Number(row.n) : 0;
    },

    /**
     * Records how far an upload got.
     * @param {string} id
     * @param {number} received
     */
    setReceived(id, received) {
      db.run(
        "UPDATE uploads SET received = ?, touched_at = ? WHERE id = ?",
        received,
        clock.now(),
        id,
      );
    },

    /** Removes the row only. @param {string} id */
    delete(id) {
      db.run("DELETE FROM uploads WHERE id = ?", id);
    },
  };
}

/** @typedef {ReturnType<typeof createUploadsRepo>} UploadsRepo */
