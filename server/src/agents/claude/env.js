// The environment an agent program is started with (docs/SPEC.md section 5).
//
// The server's own environment, minus the server's admin secrets, with a `PATH` that finds the
// usual tool folders even when the server was started from a service manager with a bare
// `PATH` (`/usr/bin:/bin`). Nothing else is added: the server is a plain process of the user,
// so the login shell is not asked for its environment.

import path from "node:path";

/** Variables with this prefix configure the server itself and never reach an agent. */
export const ADMIN_PREFIX = "VIDAI_ADMIN_";

/**
 * The Homebrew `bin` and `sbin` folders of both layouts, the one of this Mac's processor first
 * (`/opt/homebrew` on Apple Silicon, `/usr/local` on Intel). The other is kept as well: an
 * Intel Node.js under Rosetta 2 reports `x64` on an Apple Silicon Mac.
 * @param {string} arch What `process.arch` says.
 * @returns {string[]}
 */
export function homebrewBins(arch) {
  const apple = ["/opt/homebrew/bin", "/opt/homebrew/sbin"];
  const intel = ["/usr/local/bin", "/usr/local/sbin"];
  return arch === "arm64" ? [...apple, ...intel] : [...intel, ...apple];
}

/**
 * The folders a `PATH` is extended with: the user's `~/.local/bin` (where Claude Code installs
 * itself), then on a Mac Homebrew and MacPorts, then the system folders.
 * @param {{ platform: NodeJS.Platform, arch: string, home?: string | null }} machine
 * @returns {string[]}
 */
export function wellKnownDirs({ platform, arch, home }) {
  if (platform === "win32") return [];
  /** @type {string[]} */
  const dirs = [];
  if (home) dirs.push(path.posix.join(home, ".local", "bin"));
  if (platform === "darwin") {
    dirs.push(...homebrewBins(arch), "/opt/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  } else {
    dirs.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin");
  }
  return dirs;
}

/**
 * `pathValue` with every folder of `dirs` that it does not list yet appended, in order. Existing
 * entries keep their place and win over the added ones.
 * @param {string | undefined} pathValue
 * @param {readonly string[]} dirs
 * @param {string} [delimiter]
 * @returns {string}
 */
export function withDirs(pathValue, dirs, delimiter = ":") {
  const parts = (pathValue ?? "").split(delimiter).filter((p) => p !== "");
  const have = new Set(parts);
  for (const dir of dirs) {
    if (!have.has(dir)) {
      parts.push(dir);
      have.add(dir);
    }
  }
  return parts.join(delimiter);
}

/**
 * `~` and `~/...` at the start of `value` as `home`; everything else unchanged.
 * @param {string} value
 * @param {string | null | undefined} home
 * @returns {string}
 */
export function expandHome(value, home) {
  if (!home) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

/**
 * The environment for an agent process.
 *
 * - Every `VIDAI_ADMIN_` variable is removed (letter case ignored).
 * - macOS and Linux: `PATH` gets the folders of `wellKnownDirs` that it lacks, and `HOME` is
 *   set from `home` when it is missing.
 * - Windows: `PATH` is kept as it is.
 * @param {Readonly<Record<string, string | undefined>>} processEnv
 * @param {{ platform?: NodeJS.Platform, arch?: string, home?: string | null }} [machine] The
 *   computer (default: this one).
 * @returns {Record<string, string>}
 */
export function agentEnv(processEnv, machine = {}) {
  const platform = machine.platform ?? process.platform;
  const arch = machine.arch ?? process.arch;
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (key.toUpperCase().startsWith(ADMIN_PREFIX)) continue;
    env[key] = value;
  }
  if (platform === "win32") return env;
  const home = machine.home ?? env["HOME"] ?? null;
  if (env["HOME"] === undefined && home !== null && home !== "") env["HOME"] = home;
  env["PATH"] = withDirs(env["PATH"], wellKnownDirs({ platform, arch, home }));
  return env;
}
