// The macOS half of the machine facts (docs/SPEC.md section 8, "Prompt"): the commands to ask
// and the parsing of their answers. Pure parsing, so it is unit tested without a Mac.

/** The programs, by absolute path (a server started from launchd may have no useful PATH). */
export const SW_VERS = "/usr/bin/sw_vers";
export const SYSTEM_PROFILER = "/usr/sbin/system_profiler";

/** Arguments that print the macOS version, for example `15.4.1`. */
export const VERSION_ARGS = Object.freeze(["-productVersion"]);

/** Arguments that print the graphics adapters as JSON. */
export const GPU_ARGS = Object.freeze(["SPDisplaysDataType", "-json"]);

/**
 * The macOS version from `sw_vers -productVersion`.
 * @param {string | null} stdout
 * @returns {string | null}
 */
export function parseVersion(stdout) {
  const text = (stdout ?? "").trim();
  return /^\d+(\.\d+){0,2}$/u.test(text) ? text : null;
}

/**
 * The graphics adapter names from `system_profiler SPDisplaysDataType -json`, in order, each once
 * (an Apple Silicon Mac lists its own chip, an Intel Mac may list an integrated and a discrete one).
 * @param {string | null} stdout
 * @returns {string[]}
 */
export function parseGpuNames(stdout) {
  if (stdout === null || stdout.trim() === "") return [];
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = /** @type {{ SPDisplaysDataType?: unknown }} */ (json ?? {}).SPDisplaysDataType;
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const names = [];
  for (const entry of list) {
    const name = /** @type {{ sppci_model?: unknown }} */ (entry ?? {}).sppci_model;
    if (typeof name === "string" && name.trim() !== "" && !names.includes(name.trim())) {
      names.push(name.trim());
    }
  }
  return names;
}
