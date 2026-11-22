// Finding the OpenCode 2 program and telling whether VidAI can drive it (docs/SPEC.md section 5,
// "The OpenCode 2 program").
//
// OpenCode 2 comes in several shapes on disk: the v2 install script
// (`curl -fsSL https://opencode.ai/v2/install | bash`) writes its binary as
// `~/.opencode/bin/opencode` (the same file the v1 installer writes, so installing one replaces
// the other) plus an `opencode2` shim that runs the `opencode` next to it; npm's `@opencode/cli`
// links both `opencode` and `opencode2` to its binary; Homebrew provides `opencode`.
//
// Candidates: `VIDAI_OPENCODE2_BIN` (tests, development; when set it is the only candidate), then
// every `opencode2`, then every `opencode`, each on the `PATH` of the agent environment and then
// in the folders the installers use (`wellKnownDirs`). The first that reports a 2.x version is
// the program: an `opencode2` usually, or an `opencode` that is 2.x. An `opencode2` shim left
// behind after the v1 installer replaced the binary next to it reports 1.x and is passed over;
// when nothing is 2.x such a shim is reported as found but not supported, with its version, while
// a 1.x `opencode` alone means OpenCode 2 is not installed.
//
// On Windows the official installer is bash-only, so OpenCode 2 comes from WinGet
// (`winget install --id Anomaly.OpenCode --exact`, which puts a link in
// `%LOCALAPPDATA%\Microsoft\WinGet\Links`), an older manual install in `%USERPROFILE%\.opencode\bin`,
// npm's global folder (`%APPDATA%\npm`, `.cmd` shims) or scoop (`%USERPROFILE%\scoop\shims`). Each
// name is looked for with `PATHEXT` (always `.exe` and `.cmd` too) on `PATH` and then in those
// folders (`windowsDirs`). A `.cmd` shim is never run through `cmd.exe` by hand:
// `platform/launch.js` (behind `runHelper`) reads npm's shim and starts the program it points to.
//
// The version comes from `--version` (auto-update off), which 2.x prints as `opencode v2.2.6`.
// VidAI drives the v2 API of OpenCode 2.x.
//
// Everything takes the environment and the machine as parameters, so it runs the same way in
// tests on any system.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, homebrewBins } from "../claude/env.js";
import { inDirs, isExecutable, whichAllIn } from "../claude/locate.js";
import { getVar, pathExtensions } from "../../platform/launchLookup.js";
import { runHelper } from "../../platform/process.js";

/** The variable that names the OpenCode 2 program to use instead of searching (tests). */
export const OVERRIDE_VAR = "VIDAI_OPENCODE2_BIN";

/**
 * The official installer command on a Mac (installs OpenCode 2 as `opencode`, plus an `opencode2`
 * shim, into `~/.opencode/bin`).
 */
export const INSTALL_COMMAND_MAC = "curl -fsSL https://opencode.ai/v2/install | bash";

/** The way to install OpenCode 2 on Windows (the official installer is bash-only). */
export const INSTALL_COMMAND_WINDOWS = "winget install --id Anomaly.OpenCode --exact";

/** The oldest major version VidAI drives as the OpenCode 2 program (and the only one). */
export const MIN_MAJOR = 2;

/**
 * How long `--version` may take. The first run of a newly installed or updated binary of 100 MB
 * and more can be slow: macOS checks it before it runs the first time, and an older Intel Mac
 * reads it from a slower disk. Measured: 0.1 to 0.7 s once checked, 3 s for the first run of the
 * Intel build under Rosetta 2.
 */
export const VERSION_TIMEOUT_MS = 45_000;

/**
 * The install command of a platform.
 * @param {NodeJS.Platform} [platform] Default: this computer.
 * @returns {string}
 */
export function installCommand(platform = process.platform) {
  return platform === "win32" ? INSTALL_COMMAND_WINDOWS : INSTALL_COMMAND_MAC;
}

/**
 * Folders searched after `PATH` on a Mac (and other Unix systems), in order: the official
 * installers' folder, Homebrew's two `bin` folders (this processor's prefix first) and
 * `~/.local/bin`. `~` is the home folder.
 * @param {string} arch What `process.arch` says.
 * @returns {string[]}
 */
export function wellKnownDirs(arch) {
  const brew = homebrewBins(arch).filter((dir) => dir.endsWith("/bin"));
  return ["~/.opencode/bin", ...brew, "~/.local/bin"];
}

/**
 * The folders Windows installs of OpenCode 2 use, searched after `PATH`, in order: WinGet's links
 * (the official way), the older manual install, npm's global folder, scoop's shims and
 * `~\.local\bin`. `env` is the child environment (names ignore letter case); a missing
 * `LOCALAPPDATA` or `APPDATA` falls back to the usual place inside `USERPROFILE`.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string[]}
 */
export function windowsDirs(env) {
  const win = path.win32;
  const profile = getVar(env, "USERPROFILE");
  /** @param {...string} parts @returns {string | null} */
  const underProfile = (...parts) => (profile === null ? null : win.join(profile, ...parts));
  const local = getVar(env, "LOCALAPPDATA") ?? underProfile("AppData", "Local");
  const roaming = getVar(env, "APPDATA") ?? underProfile("AppData", "Roaming");
  return [
    local === null ? null : win.join(local, "Microsoft", "WinGet", "Links"),
    underProfile(".opencode", "bin"),
    roaming === null ? null : win.join(roaming, "npm"),
    underProfile("scoop", "shims"),
    underProfile(".local", "bin"),
  ].filter((dir) => dir !== null);
}

/**
 * The extensions a Windows lookup tries: those of `PATHEXT`, and `.exe` and `.cmd` (what
 * OpenCode 2 comes as) when it does not list them.
 * @param {string | null | undefined} pathext
 * @returns {string[]}
 */
export function windowsExtensions(pathext) {
  const extensions = pathExtensions(pathext);
  for (const needed of [".exe", ".cmd"]) {
    if (!extensions.includes(needed)) extensions.push(needed);
  }
  return extensions;
}

/**
 * Where candidates are looked for: a search path and folders to try after it. On Unix `dirs` may
 * start with `~/` (the home folder); on Windows they are absolute and `pathext` names the
 * extensions to try. Plain data, so the lookups are tested on every platform.
 * @typedef {object} Folders
 * @property {NodeJS.Platform} platform
 * @property {string | null} path The `PATH` value.
 * @property {string | null} home The home folder (Unix `~`).
 * @property {readonly string[]} dirs
 * @property {string | null} [pathext] Windows only.
 */

/**
 * @typedef {object} LookupFiles
 * @property {(file: string) => boolean} [isFile] Whether a file exists and can be started.
 * @property {(file: string) => string} [realpath] Where a link ends (default: the file system's;
 *   a file that does not resolve is its own place).
 */

/**
 * Every runnable file called one of `names`, in this order: each name on the `PATH`, then in the
 * well-known folders. A file reached under two names or folders (a symlink, npm's `opencode` and
 * `opencode2`) is listed once, where it is first met.
 * @param {readonly string[]} names
 * @param {Folders} folders
 * @param {LookupFiles} [files]
 * @returns {string[]}
 */
export function candidates(names, folders, files = {}) {
  const win = folders.platform === "win32";
  const isFile = files.isFile ?? ((/** @type {string} */ f) => isExecutable(f, folders.platform));
  const realpath =
    files.realpath ??
    ((/** @type {string} */ f) => {
      try {
        return fs.realpathSync(f);
      } catch {
        return f;
      }
    });
  const pathext = win ? windowsExtensions(folders.pathext).join(";") : null;
  const dirs = win
    ? [...folders.dirs]
    : folders.dirs.flatMap((dir) => {
        if (!dir.startsWith("~")) return [dir];
        return folders.home ? [expandHome(dir, folders.home)] : [];
      });
  const options = { platform: folders.platform, isFile, pathext };
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const found = [];
  for (const name of names) {
    for (const candidate of [
      ...whichAllIn(name, folders.path, options),
      ...inDirs(dirs, [name], options),
    ]) {
      const real = realpath(candidate);
      const key = win ? real.toLowerCase() : real;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(candidate);
    }
  }
  return found;
}

/**
 * A program file and what its `--version` said.
 * @typedef {object} Found
 * @property {string} path
 * @property {string | null} version `null` when it did not answer.
 */

/**
 * Whether VidAI drives this version: OpenCode 2.x (a leading `v`, a suffix such as `-beta.1`
 * and build metadata are fine; the major and the minor must be numbers).
 * @param {string} version
 * @returns {boolean}
 */
export function supported(version) {
  const parts = version
    .trim()
    .replace(/^v+/, "")
    .split(/[.\-+]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : null));
  const [major, minor] = parts;
  if (major === undefined || major === null || minor === undefined || minor === null) return false;
  return major === MIN_MAJOR;
}

/**
 * The first of `list` whose version is `supported`; otherwise the first one, so its version can
 * say why it cannot be used. Versions are asked in order and only as far as needed.
 * @param {Iterable<string>} list
 * @param {(file: string) => Promise<string | null>} versionOf
 * @returns {Promise<Found | null>}
 */
export async function firstSupported(list, versionOf) {
  /** @type {Found | null} */
  let first = null;
  for (const file of list) {
    const found = { path: file, version: await versionOf(file) };
    if (found.version !== null && supported(found.version)) return found;
    first ??= found;
  }
  return first;
}

/**
 * The version number in `--version` output: `opencode v2.2.6` is `2.2.6`, `1.18.31` is `1.18.31`.
 * (Not the Claude Code parser: its word boundary does not see a number behind the `v`.)
 * @param {string} text
 * @returns {string | null}
 */
export function parseVersion(text) {
  const m = /(?<![\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  return m === null ? null : /** @type {string} */ (m[1]);
}

/**
 * The version `--version` prints, for example "1.18.31" (1.x) or "2.2.6" (2.x prints
 * "opencode v2.2.6"), or `null` when it fails, does not start, times out or prints no version.
 * Auto-update is switched off for the call, so checking never upgrades the program.
 * @param {string} bin
 * @param {Readonly<Record<string, string | undefined>>} env The environment to run it in.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function version(bin, env, options = {}) {
  try {
    const result = await runHelper({
      command: bin,
      args: ["--version"],
      env: { ...env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      timeoutMs: options.timeoutMs ?? VERSION_TIMEOUT_MS,
    });
    if (result.timedOut || result.code !== 0) return null;
    return parseVersion(result.stdout);
  } catch {
    return null;
  }
}

/**
 * The computer and file system a lookup runs against. Every field is optional (default: this
 * computer).
 * @typedef {object} Machine
 * @property {(file: string) => boolean} [isFile] Whether a file exists and can be started.
 * @property {(file: string) => string} [realpath] Where a link ends.
 * @property {NodeJS.Platform} [platform]
 * @property {string} [arch]
 * @property {string | null} [home]
 * @property {number} [timeoutMs] The limit of one `--version` call.
 * @property {(file: string) => Promise<string | null>} [versionOf] Replaces the real
 *   `--version` call (tests).
 */

/**
 * The OpenCode 2 executable to run and its version, or `null` when it is not installed.
 *
 * - With `VIDAI_OPENCODE2_BIN` set (a leading `~` is the home folder) that file is the only
 *   candidate: found when it can be started, with whatever version it reports (even one that
 *   is not 2.x), `null` when it cannot.
 * - Otherwise the first 2.x of `opencode2` then `opencode` (see the file comment); when none is
 *   2.x, an `opencode2` counts as found (with its version, not supported), a 1.x `opencode`
 *   alone as not installed.
 * @param {Readonly<Record<string, string | undefined>>} env The environment the program will
 *   run in.
 * @param {Machine} [machine]
 * @returns {Promise<Found | null>}
 */
export async function findOpencode2(env, machine = {}) {
  const platform = machine.platform ?? process.platform;
  const home =
    machine.home !== undefined
      ? machine.home
      : (getVar(env, platform === "win32" ? "USERPROFILE" : "HOME") ?? os.homedir());
  const isFile = machine.isFile ?? ((/** @type {string} */ f) => isExecutable(f, platform));
  const versionOf =
    machine.versionOf ??
    ((/** @type {string} */ file) => version(file, env, { timeoutMs: machine.timeoutMs }));
  const override = getVar(env, OVERRIDE_VAR)?.trim();
  if (override) {
    const bin = expandHome(override, home);
    return isFile(bin) ? { path: bin, version: await versionOf(bin) } : null;
  }
  /** @type {Folders} */
  const folders =
    platform === "win32"
      ? {
          platform,
          path: getVar(env, "PATH"),
          home,
          dirs: windowsDirs(env),
          pathext: getVar(env, "PATHEXT"),
        }
      : {
          platform,
          path: getVar(env, "PATH"),
          home,
          dirs: wellKnownDirs(machine.arch ?? process.arch),
        };
  const files = { isFile, realpath: machine.realpath };
  const shims = candidates(["opencode2"], folders, files);
  const all = candidates(["opencode2", "opencode"], folders, files);
  const found = await firstSupported(all, versionOf);
  if (found === null) return null;
  // Nothing is 2.x: only an `opencode2` counts as a (wrong) OpenCode 2, never a 1.x `opencode`.
  const usable = found.version !== null && supported(found.version);
  return usable || shims.includes(found.path) ? found : null;
}

/**
 * What the System page shows for the OpenCode 2 program: found, where, which version, whether
 * VidAI drives it, and the command that installs it on this computer.
 * @typedef {object} OpencodeCli
 * @property {boolean} found
 * @property {string | null} path
 * @property {string | null} version As `--version` prints it, for example "2.2.6"; `null` when
 *   it did not answer.
 * @property {boolean} supported VidAI can drive this version.
 * @property {string} installCommand
 */

/**
 * The status of a finding (`null`: not installed).
 * @param {Found | null} found
 * @param {NodeJS.Platform} [platform] Default: this computer.
 * @returns {OpencodeCli}
 */
export function cliStatus(found, platform = process.platform) {
  return {
    found: found !== null,
    path: found?.path ?? null,
    version: found?.version ?? null,
    supported: found !== null && found.version !== null && supported(found.version),
    installCommand: installCommand(platform),
  };
}

/**
 * Finds the program and reports its status.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} [machine]
 * @returns {Promise<OpencodeCli>}
 */
export async function opencodeStatus(env, machine = {}) {
  return cliStatus(await findOpencode2(env, machine), machine.platform);
}

/** @returns {string} "OpenCode 2 is not installed ..." */
function notInstalled() {
  return "OpenCode 2 is not installed on the computer that runs VidAI.";
}

/**
 * One sentence about a program that is installed but cannot be used; `null` when usable.
 * @param {OpencodeCli} cli
 * @returns {string | null}
 */
export function problem(cli) {
  if (!cli.found) return notInstalled();
  if (cli.supported) return null;
  return cli.version !== null
    ? `OpenCode ${cli.version} is installed; VidAI needs OpenCode 2.0 or later.`
    : "OpenCode 2 is installed but did not say which version it is.";
}
