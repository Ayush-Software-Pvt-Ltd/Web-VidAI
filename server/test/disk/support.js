// Shared set-up of the Disk Cleanup tests: the library world (storage, library, three users) with
// the disk module and the edit log on top, a scheduler the test steps by hand, and helpers to lay
// out video folders. Not a test file itself.

import fs from "node:fs";
import path from "node:path";
import { createDiskModule } from "../../src/disk/index.js";
import { createEditLog } from "../../src/editLog.js";
import { createLibraryWorld, rejectsCode, write } from "../library/support.js";

export { rejectsCode, write };

/** A scheduler that runs a task only when the test says so. */
export function manualScheduler() {
  /** @type {{ task: () => void | Promise<void> }[]} */
  const queue = [];
  return {
    later(/** @type {() => void | Promise<void>} */ task) {
      const item = { task };
      queue.push(item);
      return () => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    /** How many tasks wait. */
    get size() {
      return queue.length;
    },
    /** Runs the next task; false when none waits. */
    async step() {
      const item = queue.shift();
      if (!item) return false;
      await item.task();
      return true;
    },
    /** Runs tasks until none is left; returns how many ran. */
    async drain() {
      let ran = 0;
      while (await this.step()) ran += 1;
      return ran;
    },
  };
}

/**
 * @param {object} [options]
 * @param {(videoKey: string) => boolean} [options.activeJob]
 * @param {Partial<import("../../src/disk/service.js").DiskServiceDeps>} [options.extra]
 */
export function createDiskWorld({ activeJob, extra = {} } = {}) {
  const w = createLibraryWorld();
  const scheduler = manualScheduler();
  /** @type {Set<string>} */
  const active = new Set();
  const editLog = createEditLog({
    db: w.db,
    users: w.users,
    clock: w.clock,
    log: { info() {}, warn() {}, error() {} },
    describeVideo: w.library.api.describeKey,
    strict: true,
  });
  /** @type {string[]} */
  const rescans = [];
  const disk = createDiskModule({
    channels: w.mod.api.channelsRepo,
    folders: w.mod.api.folders,
    videos: w.library.api.videos,
    library: w.library.api,
    activeJob: activeJob ?? ((key) => active.has(key)),
    editLog,
    events: { emit: (/** @type {never} */ e) => void w.libraryEvents.push(e) },
    clock: w.clock,
    log: { info() {}, warn: (m) => void w.warnings.push(m), error() {} },
    rescanLibrary: (userId) => void rescans.push(userId),
    scheduler,
    ...extra,
  });

  /** @param {{ id: string, email?: string, role?: string }} user @param {string} name @param {unknown} [input] */
  async function call(user, name, input) {
    const fn = disk.rpc.find((candidate) => candidate.name === name);
    if (!fn) throw new Error(`no RPC function ${name}`);
    return /** @type {any} */ (await fn.handler(input ?? {}, /** @type {never} */ (w.ctxOf(user))));
  }

  /** The disk events sent so far. */
  const diskEvents = () => w.libraryEvents.filter((event) => event.event === "disk-use-changed");

  return {
    ...w,
    scheduler,
    editLog,
    disk,
    call,
    active,
    rescans,
    diskEvents,
    cleanup() {
      disk.stop();
      w.cleanup();
    },
  };
}

/**
 * Lays out a video folder like a finished edit: sources, working files, project and finals.
 * Sizes: A-roll 1000, B-roll 200, CLAUDE_VE 300 + 40, project 50 + 6, finals 70 + 80, thumbnail 9.
 * @param {string} dir The video folder (made when missing).
 * @param {string} folderName
 */
export function layoutVideo(dir, folderName = path.basename(dir)) {
  const file = (/** @type {string} */ relative, /** @type {number} */ size) =>
    write(path.join(dir, relative), Buffer.alloc(size, 1));
  file("a-roll.mp4", 1000);
  file("Broll/b1.mp4", 200);
  file("CLAUDE_VE/scratch.bin", 300);
  file("CLAUDE_VE/frames/f1.png", 40);
  file(`output/${folderName}.hf/index.html`, 50);
  file(`output/${folderName}.hf/assets/a.txt`, 6);
  file(`output/${folderName}_final_v1.mp4`, 70);
  file(`output/${folderName}_final_v2.mp4`, 80);
  file("output/thumbnail-1.png", 9);
  return { working: 340, project: 56, finals: 150, sources: 1209, total: 1755 };
}

/** Whether permission bits stop this process (they do not for root). */
export const canRestrict = typeof process.getuid === "function" && process.getuid() !== 0;

/** Lists every path under a folder, links not followed, as sorted relative paths. @param {string} dir */
export function tree(dir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      found.push(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found.sort();
}
