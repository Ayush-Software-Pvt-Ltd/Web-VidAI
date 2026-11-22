// The Windows half of the machine facts (docs/SPEC.md section 8, "Prompt"): one PowerShell call
// that prints the operating system and the graphics adapters as JSON, and the parsing of its
// answer. Written for Windows and unit tested on sample output only.

/**
 * The PowerShell program of this Windows computer, by absolute path.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string}
 */
export function powershellPath(env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** The script, on one line (it is passed as one argument of `-Command`). */
export const SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$o = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1",
  "$g = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })",
  "[pscustomobject]@{ caption = $o.Caption; version = $o.Version; gpus = $g } | ConvertTo-Json -Compress",
].join("; ");

/** The arguments of the PowerShell call. */
export const ARGS = Object.freeze([
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  SCRIPT,
]);

/** Adapters that are no real graphics card; they are dropped when a real one exists. */
const VIRTUAL_ADAPTER = /basic (display|render)|remote display|hyper-v video|virtual display/iu;

/**
 * @typedef {object} WindowsFacts
 * @property {string | null} osVersion For example `11 Pro (10.0.26100)`.
 * @property {string[]} gpus
 */

/**
 * Reads the answer of `SCRIPT`. Anything that cannot be read leaves its part empty.
 * @param {string | null} stdout
 * @returns {WindowsFacts}
 */
export function parseWindowsFacts(stdout) {
  /** @type {WindowsFacts} */
  const none = { osVersion: null, gpus: [] };
  const text = (stdout ?? "").replace(/^\uFEFF/u, "").trim();
  if (text === "") return none;
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return none;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return none;
  const record = /** @type {{ caption?: unknown, version?: unknown, gpus?: unknown }} */ (json);
  return { osVersion: osVersionOf(record.caption, record.version), gpus: gpuNamesOf(record.gpus) };
}

/**
 * `Microsoft Windows 11 Pro` and `10.0.26100` become `11 Pro (10.0.26100)`.
 * @param {unknown} caption
 * @param {unknown} version
 * @returns {string | null}
 */
function osVersionOf(caption, version) {
  const edition =
    typeof caption === "string"
      ? caption
          .replace(/^\s*Microsoft\s+/iu, "")
          .replace(/^Windows\s*/iu, "")
          .trim()
      : "";
  const build =
    typeof version === "string" && /^[\d.]+$/u.test(version.trim()) ? version.trim() : "";
  if (edition !== "" && build !== "") return `${edition} (${build})`;
  if (edition !== "") return edition;
  return build !== "" ? build : null;
}

/**
 * @param {unknown} value A name or a list of names.
 * @returns {string[]}
 */
function gpuNamesOf(value) {
  const list = Array.isArray(value) ? value : [value];
  /** @type {string[]} */
  const names = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const name = item.replace(/\s+/gu, " ").trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  const real = names.filter((name) => !VIRTUAL_ADAPTER.test(name));
  return real.length > 0 ? real : names;
}
