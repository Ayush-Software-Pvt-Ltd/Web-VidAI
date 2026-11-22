// The server log: one line per entry (ISO time, level, message), rotated by size (docs/SPEC.md section 2).
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {object} Logger
 * @property {(message: string, detail?: unknown) => void} info
 * @property {(message: string, detail?: unknown) => void} warn
 * @property {(message: string, detail?: unknown) => void} error
 */

const LEVELS = /** @type {const} */ (["info", "warn", "error"]);

/**
 * @param {unknown} detail
 * @returns {string}
 */
function describe(detail) {
  if (detail === undefined) return "";
  if (detail instanceof Error) return `\n${detail.stack ?? `${detail.name}: ${detail.message}`}`;
  if (typeof detail === "string") return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

/**
 * Create a logger. It never throws: a log that cannot be written must not take the server down.
 * When the file passes `maxBytes` it becomes `<file>.1`, the older ones move up, and only `keep`
 * old files remain.
 * @param {object} options
 * @param {string | null} [options.file] Log file; null logs to `console` only.
 * @param {number} [options.maxBytes]
 * @param {number} [options.keep] How many rotated files (`.1` to `.<keep>`) stay next to the current one.
 * @param {boolean | { write(line: string, level: "info" | "warn" | "error"): void }} [options.console]
 *   `true` prints to stdout (info) and stderr (warn, error); an object receives every line.
 * @param {{ now(): number }} [options.clock]
 * @returns {Logger}
 */
export function createLogger({
  file = null,
  maxBytes = 10 * 1024 * 1024,
  keep = 5,
  console: consoleOut = false,
  clock = { now: () => Date.now() },
} = {}) {
  let size = 0;
  let prepared = false;

  function prepare() {
    if (prepared || file === null) return;
    prepared = true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }

  /** @param {string} target */
  function rotate(target) {
    fs.rmSync(`${target}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${target}.${i}`)) fs.renameSync(`${target}.${i}`, `${target}.${i + 1}`);
    }
    if (keep >= 1) fs.renameSync(target, `${target}.1`);
    else fs.rmSync(target, { force: true });
    size = 0;
  }

  /**
   * @param {"info" | "warn" | "error"} level
   * @param {string} message
   * @param {unknown} detail
   */
  function write(level, message, detail) {
    const line = `${new Date(clock.now()).toISOString()} ${level.toUpperCase()} ${message}${describe(detail)}\n`;
    try {
      if (file !== null) {
        prepare();
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate(file);
        fs.appendFileSync(file, line);
        size += bytes;
      }
    } catch {
      // Disk full or folder gone: keep serving.
    }
    try {
      if (consoleOut === true) {
        (level === "info" ? process.stdout : process.stderr).write(line);
      } else if (consoleOut) {
        consoleOut.write(line, level);
      }
    } catch {
      // Closed stdout (for example a closed terminal) is not our problem.
    }
  }

  const logger = /** @type {Logger} */ ({});
  for (const level of LEVELS) {
    logger[level] = (message, detail) => {
      write(level, message, detail);
    };
  }
  return logger;
}
