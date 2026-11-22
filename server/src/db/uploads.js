// The `uploads` table (docs/SPEC.md sections 6 and 15). An upload names its video by the video's
// row in `videos` (a row made the first time something must be remembered about a folder, which
// an upload is), so this repository also makes that row when it is missing.

import { randomBytes } from "node:crypto";
import { systemClock } from "./open.js";
import { createVideosRepo } from "./videos.js";

/**
 * @typedef {object} UploadRecord
 * @property {string} id
 * @property {string} userId
 * @property {string} videoKey The `videos.id` row.
 * @property {string} channelId
 * @property {string} folderName The video folder's name inside the channel directory.
 * @property {"video" | "broll"} folder
 * @property {string} name The file name the upload will have.
 * @property {number} size Declared size in bytes.
 * @property {number} received Bytes in order that the server has.
 * @property {number} createdAt
 * @property {number} touchedAt Milliseconds of the last `PUT`.
 */

const SELECT = `SELECT u.id, u.user_id, u.video_id, v.channel_id, v.folder_name, u.folder, u.name,
  u.size, u.received, u.created_at, u.touched_at
  FROM uploads u JOIN videos v ON v.id = u.video_id`;

/**
 * @param {import("./open.js").Row} row
 * @returns {UploadRecord}
 */
function toUpload(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    videoKey: String(row.video_id),
    channelId: String(row.channel_id),
    folderName: String(row.folder_name),
    folder: row.folder === "broll" ? "broll" : "video",
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
     * Adds an upload (and the video's row when there is none yet).
     * @param {{ userId: string, channelId: string, folderName: string, folder: "video" | "broll", name: string, size: number }} input
     * @returns {UploadRecord}
     */
    create({ userId, channelId, folderName, folder, name, size }) {
      const id = randomBytes(16).toString("hex");
      return db.transaction(() => {
        const now = clock.now();
        const video = videos.ensure(channelId, folderName);
        db.run(
          `INSERT INTO uploads (id, user_id, video_id, folder, name, size, received, created_at, touched_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          id,
          userId,
          video.key,
          folder,
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
     * The uploads aimed at the same folder of the same video, for the name check.
     * @param {string} channelId
     * @param {string} folderName
     * @param {"video" | "broll"} folder
     * @returns {UploadRecord[]}
     */
    listForTarget(channelId, folderName, folder) {
      return db
        .all(
          `${SELECT} WHERE v.channel_id = ? AND v.folder_name = ? AND u.folder = ?`,
          channelId,
          folderName,
          folder,
        )
        .map(toUpload);
    },

    /** @param {string} userId @returns {UploadRecord[]} */
    listForUser(userId) {
      return db.all(`${SELECT} WHERE u.user_id = ?`, userId).map(toUpload);
    },

    /** @param {string} channelId @returns {UploadRecord[]} */
    listForChannel(channelId) {
      return db.all(`${SELECT} WHERE v.channel_id = ?`, channelId).map(toUpload);
    },

    /** Uploads whose last `PUT` was before `before`. @param {number} before @returns {UploadRecord[]} */
    listTouchedBefore(before) {
      return db.all(`${SELECT} WHERE u.touched_at < ?`, before).map(toUpload);
    },

    /**
     * How many uploads of a video are not complete (a video with one does not offer Start Editing).
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
