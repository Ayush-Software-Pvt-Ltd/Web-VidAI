// The preview copies on disk (docs/SPEC.md section 2, `cache/proxy/`, and section 11, Preview copies).
//
// For every file that was looked at there is `<name>.json` (what ffprobe found, so a restart probes
// nothing again) and for a heavy one, once complete, `<name>.mp4`. A copy is written as
// `<name>.part` and renamed when it is whole; leftovers of a crashed run are deleted at the start.
//
// `proxyFor(realPath)` is what the preview route calls for every request, so it is synchronous and
// cheap: an in-memory index of finished copies, and a stat of the original that is cached for a
// moment, so a replaced original stops matching within seconds.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  copyFile,
  factsFile,
  nameOfCopy,
  nameOfFacts,
  PART_EXTENSION,
  proxyName,
} from "./proxyName.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} FactsRecord What is kept about one original.
 * @property {string} realPath
 * @property {number} size
 * @property {number} mtimeMs
 * @property {import("./proxyProbe.js").MediaFacts | null} facts `null`: not a video.
 * @property {string[]} reasons Why it is heavy; empty: it plays well as it is.
 *
 * @typedef {object} StoreOptions
 * @property {string} dir `<data dir>/cache/proxy`.
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {number} [maxAgeMs] Unused copies older than this are deleted (30 days).
 * @property {number} [statTtlMs] How long the stat of an original is trusted (2 seconds).
 * @property {number} [touchEveryMs] How often a used copy's time is renewed (1 hour).
 * @property {() => number | null} [maxBytes] The size at which the oldest copies go (`proxyCacheGb`).
 */

/**
 * @param {StoreOptions} options
 */
export function createCopyStore(options) {
  const { dir, clock, log } = options;
  const maxAgeMs = options.maxAgeMs ?? 30 * DAY_MS;
  const statTtlMs = options.statTtlMs ?? 2000;
  const touchEveryMs = options.touchEveryMs ?? 60 * 60 * 1000;

  /** Finished copies. @type {Set<string>} */
  const ready = new Set();
  /** @type {Map<string, { at: number, name: string | null }>} */
  const stats = new Map();
  /** @type {Map<string, number>} */
  const touched = new Map();

  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith(PART_EXTENSION)) {
      fs.rmSync(path.join(dir, entry), { force: true });
      continue;
    }
    const name = nameOfCopy(entry);
    if (name !== null) ready.add(name);
  }

  /** @param {string} name */
  function forget(name) {
    ready.delete(name);
    touched.delete(name);
    for (const [file, entry] of stats) if (entry.name === name) stats.delete(file);
  }

  /** @param {string} file */
  async function remove(file) {
    try {
      await fsp.rm(file, { force: true });
    } catch (error) {
      log.warn(`preview copies: ${file} could not be deleted`, error);
    }
  }

  return {
    dir,

    /**
     * The copy to serve instead of the original, or null. Synchronous and cheap.
     * @param {string} realPath
     * @returns {string | null}
     */
    proxyFor(realPath) {
      const now = clock.now();
      let entry = stats.get(realPath);
      if (!entry || now - entry.at >= statTtlMs) {
        /** @type {string | null} */
        let name = null;
        try {
          const stat = fs.statSync(realPath);
          if (stat.isFile()) name = proxyName(realPath, stat.size, stat.mtimeMs);
        } catch {
          name = null;
        }
        if (stats.size > 5000) stats.clear();
        entry = { at: now, name };
        stats.set(realPath, entry);
      }
      if (entry.name === null || !ready.has(entry.name)) return null;
      const last = touched.get(entry.name) ?? 0;
      const file = copyFile(dir, entry.name);
      if (now - last >= touchEveryMs) {
        // Used copies stay: the sweep goes by this time.
        touched.set(entry.name, now);
        const date = new Date(now);
        fsp.utimes(file, date, date).catch(() => {});
      }
      return file;
    },

    /**
     * The name for the file's present size and time (not cached).
     * @param {string} realPath
     * @returns {Promise<{ name: string, size: number, mtimeMs: number } | null>} null: not a file.
     */
    async identify(realPath) {
      try {
        const stat = await fsp.stat(realPath);
        if (!stat.isFile()) return null;
        return {
          name: proxyName(realPath, stat.size, stat.mtimeMs),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch {
        return null;
      }
    },

    /** @param {string} name @returns {boolean} */
    has: (name) => ready.has(name),

    /** A copy was finished: matches from now on. @param {string} name */
    markReady(name) {
      ready.add(name);
      for (const [file, entry] of stats) if (entry.name === name) stats.delete(file);
    },

    /** @param {string} name @returns {Promise<FactsRecord | null>} */
    async readFacts(name) {
      try {
        const record = JSON.parse(await fsp.readFile(factsFile(dir, name), "utf8"));
        if (typeof record?.realPath !== "string" || !Array.isArray(record.reasons)) return null;
        return /** @type {FactsRecord} */ (record);
      } catch {
        return null;
      }
    },

    /** @param {string} name @param {FactsRecord} record @returns {Promise<void>} */
    async writeFacts(name, record) {
      const file = factsFile(dir, name);
      const temp = `${file}${PART_EXTENSION}`;
      await fsp.writeFile(temp, JSON.stringify(record));
      await fsp.rename(temp, file);
    },

    /**
     * Deletes copies not used for 30 days, copies and notes whose original is gone or changed,
     * copies without notes, and the oldest copies beyond the size cap.
     * @returns {Promise<{ deleted: number, freedBytes: number }>}
     */
    async sweep() {
      const now = clock.now();
      let deleted = 0;
      let freedBytes = 0;
      /** @type {Map<string, { size: number, mtimeMs: number }>} */
      const copies = new Map();
      /** @type {Map<string, number>} */
      const notes = new Map();
      for (const entry of await fsp.readdir(dir)) {
        const copy = nameOfCopy(entry);
        const note = nameOfFacts(entry);
        try {
          if (copy !== null) {
            const stat = await fsp.stat(path.join(dir, entry));
            copies.set(copy, { size: stat.size, mtimeMs: stat.mtimeMs });
          } else if (note !== null) {
            notes.set(note, (await fsp.stat(path.join(dir, entry))).mtimeMs);
          }
        } catch {
          // Gone while listing.
        }
      }
      /** @param {string} name @param {boolean} withNote */
      const drop = async (name, withNote) => {
        const copy = copies.get(name);
        if (copy) {
          await remove(copyFile(dir, name));
          freedBytes += copy.size;
          deleted += 1;
          copies.delete(name);
          forget(name);
        }
        if (withNote) {
          await remove(factsFile(dir, name));
          notes.delete(name);
        }
      };
      for (const name of [...notes.keys()]) {
        const record = await this.readFacts(name);
        const original = record ? await this.identify(record.realPath) : null;
        const same =
          record !== null &&
          original !== null &&
          original.size === record.size &&
          original.mtimeMs === record.mtimeMs;
        if (!same) await drop(name, true);
      }
      for (const name of [...copies.keys()]) {
        if (!notes.has(name)) await drop(name, false);
      }
      for (const [name, copy] of [...copies]) {
        if (now - copy.mtimeMs > maxAgeMs) await drop(name, true);
      }
      for (const [name, mtimeMs] of [...notes]) {
        if (!copies.has(name) && now - mtimeMs > maxAgeMs) await drop(name, true);
      }
      const cap = options.maxBytes?.() ?? null;
      if (cap !== null) {
        let total = 0;
        for (const copy of copies.values()) total += copy.size;
        const oldest = [...copies].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
        for (const [name] of oldest) {
          if (total <= cap) break;
          total -= copies.get(name)?.size ?? 0;
          await drop(name, true);
        }
      }
      return { deleted, freedBytes };
    },

    /**
     * What the copies take, for the System page.
     * @returns {Promise<{ files: number, bytes: number }>}
     */
    async usage() {
      let files = 0;
      let bytes = 0;
      for (const entry of await fsp.readdir(dir)) {
        if (nameOfCopy(entry) === null) continue;
        try {
          bytes += (await fsp.stat(path.join(dir, entry))).size;
          files += 1;
        } catch {
          // Gone while listing.
        }
      }
      return { files, bytes };
    },
  };
}
