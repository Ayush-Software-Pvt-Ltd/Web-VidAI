// The folders of change requests' pictures (`projects/<videoKey>/notes/<noteId>/`, docs/SPEC.md
// section 11, Change requests), and their cleaning up so that the pictures of finished requests do
// not pile up.

import fsp from "node:fs/promises";
import path from "node:path";

/** A note id: 16 random bytes as hex (`db/notes.js`). Nothing else under `notes/` is touched. */
const NOTE_ID = /^[0-9a-f]{32}$/;

/**
 * @param {object} deps
 * @param {(videoKey: string, noteId: string) => string} deps.noteDir `timeline.api.noteDir`.
 */
export function createNoteFolders({ noteDir }) {
  return {
    /**
     * Deletes the folder of one request (its pictures). Nothing happens when it is not there.
     * @param {string} videoKey
     * @param {string} noteId
     * @returns {Promise<void>}
     */
    async removeFor(videoKey, noteId) {
      if (!NOTE_ID.test(noteId)) return;
      await fsp.rm(noteDir(videoKey, noteId), { recursive: true, force: true });
    },

    /**
     * Deletes the folders of every request of the video except `keepNoteIds` (the requests that
     * are still waiting or running).
     * @param {string} videoKey
     * @param {Iterable<string>} keepNoteIds
     * @returns {Promise<string[]>} The ids whose folders were deleted.
     */
    async sweep(videoKey, keepNoteIds) {
      const keep = new Set(keepNoteIds);
      const root = path.dirname(noteDir(videoKey, "0".repeat(32)));
      let entries;
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      /** @type {string[]} */
      const removed = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !NOTE_ID.test(entry.name) || keep.has(entry.name)) continue;
        await fsp.rm(path.join(root, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
      return removed.sort();
    },
  };
}
