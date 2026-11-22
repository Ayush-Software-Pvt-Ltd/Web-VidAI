// The places the admin's folder picker starts from, and the hidden entries of a folder (docs/SPEC.md
// section 6, "Folders on the server"). The operating system's rules are in `places.macos.js` and
// `places.windows.js`; this file picks one and hands them the folders to look at, which tests
// replace with temporary ones.

import os from "node:os";
import path from "node:path";
import { foldName, pathApi } from "./fsnames.js";
import { runHelper } from "./process.js";
import * as macos from "./places.macos.js";
import * as windows from "./places.windows.js";

/** @typedef {import("../../../src/lib/wire/storage.ts").FsPlace} FsPlace */

/**
 * @typedef {object} PlacesOptions
 * @property {string} [platform] Default: this computer's (`process.platform`).
 * @property {string} [homeDir] The home folder of the account the server runs as.
 * @property {string} [rootDir] The top of the file system on a Mac (`/`).
 * @property {string} [volumesDir] Where a Mac keeps its volumes (`/Volumes`).
 * @property {(command: string, args: readonly string[], timeoutMs: number) => Promise<string | null>} [run]
 *   Runs a short program and returns what it printed, or null.
 * @property {(target: string) => Promise<unknown>} [stat] Windows: how a drive letter is probed.
 */

/** Longest wait for the attribute listing of one folder. */
const HIDDEN_TIMEOUT_MS = 10_000;

/** @type {NonNullable<PlacesOptions["run"]>} */
async function runWithHelper(command, args, timeoutMs) {
  try {
    const result = await runHelper({ command, args: [...args], timeoutMs });
    return result.code === 0 && !result.timedOut ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * @param {PlacesOptions} [options]
 */
export function createPlaces({
  platform = process.platform,
  homeDir = os.homedir(),
  rootDir = "/",
  volumesDir = "/Volumes",
  run = runWithHelper,
  stat,
} = {}) {
  const api = pathApi(platform);
  const volumes = path.resolve(volumesDir);

  return {
    /** The home folder of the account the server runs as. */
    homeDir,

    /**
     * Whether a real path is the top of a drive, which has no folder above it to list: the root
     * `/`, a drive letter's `C:\` or share, or on a Mac a volume.
     * @param {string} real
     * @returns {boolean}
     */
    isDriveTop(real) {
      const above = api.dirname(real);
      return above === real || (platform !== "win32" && above === volumes);
    },

    /**
     * The home folder, then the drives and volumes (SPEC section 6).
     * @returns {Promise<FsPlace[]>}
     */
    async list() {
      const drives =
        platform === "win32"
          ? await windows.listDrives(stat ? { stat } : {})
          : await macos.listDrives({ rootDir, volumesDir });
      return [{ name: "Home", path: homeDir, kind: "home", available: true }, ...drives];
    },

    /**
     * The names (folded, so they compare the way the file system does) of the entries of `folder`
     * that are hidden. Dot names are the caller's; this adds what the system itself hides: on
     * Windows the hidden and system attributes. Best effort: when the listing fails nothing is hidden.
     * @param {string} folder A real path.
     * @returns {Promise<Set<string>>}
     */
    async hiddenNames(folder) {
      /** @type {Set<string>} */
      const hidden = new Set();
      if (platform !== "win32") return hidden;
      for (const attribute of /** @type {const} */ (["h", "s"])) {
        const stdout = await run(
          windows.CMD,
          windows.dirArgs(folder, attribute),
          HIDDEN_TIMEOUT_MS,
        );
        for (const entry of windows.parseDirNames(stdout)) {
          // `dir /b` prints bare names for a pattern, but be safe if a path comes back.
          hidden.add(foldName(path.win32.basename(entry), platform));
        }
      }
      return hidden;
    },
  };
}

/** @typedef {ReturnType<typeof createPlaces>} Places */
