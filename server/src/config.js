// Command line, environment, the data directory and its lock (docs/SPEC.md section 2).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, invalidInput } from "./errors.js";
import { defaultDataDir, restrictToOwner } from "./platform/paths.js";

export const DEFAULT_PORT = 14200;
export const DEFAULT_HOST = "0.0.0.0";

/**
 * @typedef {object} Config
 * @property {boolean} help `-h` was given: print `usageText()` and exit.
 * @property {string | null} command First positional argument (a sub-command such as `admin-reset`).
 * @property {Record<string, unknown>} extra Options this module does not know
 *   (a sub-command's own, such as `--email`).
 * @property {number} port 0 asks the system for a free port.
 * @property {string} host
 * @property {string} dataDir Absolute.
 * @property {string} uiDist Absolute directory of the built UI.
 *
 * @typedef {ReturnType<typeof dataPaths>} DataPaths
 */

/** The text `-h` prints. */
export function usageText() {
  return [
    "VidAI Server",
    "",
    "Usage: node server/src/main.js [options]",
    "",
    `  --port <n>     Port to listen on (default ${DEFAULT_PORT}, also VIDAI_PORT)`,
    `  --host <addr>  Address to listen on (default ${DEFAULT_HOST}, also VIDAI_HOST)`,
    "  --data <dir>   Data directory (also VIDAI_DATA_DIR)",
    "  -h             Show this help",
    "",
  ].join("\n");
}

/**
 * @param {string} text
 * @param {string} name
 * @returns {number}
 */
function parsePort(text, name) {
  const port = /^\d{1,5}$/.test(text.trim()) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw invalidInput(`${name} must be a number from 0 to 65535.`);
  }
  return port;
}

/**
 * Split the command line into `--name value`, `--name=value`, `-h` and positional words. Options
 * this module does not know are kept too, because a sub-command (`admin-reset --email x`) has its
 * own; an option followed by another option or by nothing has the value `true`.
 * @param {string[]} argv
 * @returns {{ values: Record<string, string | boolean>, positionals: string[] }}
 */
function splitArguments(argv) {
  /** @type {Record<string, string | boolean>} */
  const values = {};
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (word === "-h") {
      values.help = true;
    } else if (word.startsWith("--") && word.length > 2) {
      const equals = word.indexOf("=");
      if (equals > 0) {
        values[word.slice(2, equals)] = word.slice(equals + 1);
        continue;
      }
      const name = word.slice(2);
      const next = argv[i + 1];
      if (name === "help" || next === undefined || next.startsWith("-")) {
        values[name] = true;
      } else {
        values[name] = next;
        i++;
      }
    } else {
      positionals.push(word);
    }
  }
  return { values, positionals };
}

/**
 * Turn the command line and the environment into one config object (the option wins over the
 * environment, which wins over the default). It reads nothing from disk.
 * @param {object} [input]
 * @param {string[]} [input.argv] Arguments after the script name.
 * @param {Record<string, string | undefined>} [input.env]
 * @param {string} [input.platform]
 * @param {string} [input.home]
 * @param {string} [input.cwd] Relative `--data` and `VIDAI_UI_DIST` paths resolve against it.
 * @returns {Config}
 */
export function loadConfig({
  argv = process.argv.slice(2),
  env = process.env,
  platform,
  home,
  cwd = process.cwd(),
} = {}) {
  const parsed = splitArguments(argv);
  const { port, host, data, help, ...extra } = parsed.values;
  for (const [name, value] of [
    ["--port", port],
    ["--host", host],
    ["--data", data],
  ]) {
    if (value === true) throw invalidInput(`${name} needs a value.`);
  }

  const portText = typeof port === "string" ? port : env.VIDAI_PORT;
  const hostText = typeof host === "string" ? host : env.VIDAI_HOST;
  const dataText = typeof data === "string" ? data : env.VIDAI_DATA_DIR;
  const resolvedHost = hostText?.trim() ? hostText.trim() : DEFAULT_HOST;
  const uiText = env.VIDAI_UI_DIST?.trim();

  return {
    help: help === true,
    command: parsed.positionals[0] ?? null,
    extra,
    port: portText?.trim()
      ? parsePort(portText, typeof port === "string" ? "--port" : "VIDAI_PORT")
      : DEFAULT_PORT,
    host: resolvedHost,
    dataDir: path.resolve(
      cwd,
      dataText?.trim() ? dataText : defaultDataDir({ platform, env, home }),
    ),
    uiDist: uiText
      ? path.resolve(cwd, uiText)
      : fileURLToPath(new URL("../../dist", import.meta.url)),
  };
}

/**
 * Every path inside a data directory (SPEC section 2 table). Pure.
 * @param {string} dataDir
 */
export function dataPaths(dataDir) {
  const at = (/** @type {string[]} */ ...parts) => path.join(dataDir, ...parts);
  return {
    dataDir,
    db: at("vidai.db"),
    secretKey: at("secret.key"),
    tlsDir: at("tls"),
    certFile: at("tls", "cert.pem"),
    keyFile: at("tls", "key.pem"),
    logsDir: at("logs"),
    serverLog: at("server.log"),
    toolkitDir: at("toolkit"),
    mediaDir: at("media"),
    projectsDir: at("projects"),
    proxyCacheDir: at("cache", "proxy"),
    renderCacheDir: at("cache", "render"),
    locksDir: at("locks"),
    lockFile: at("server.lock"),
  };
}

/**
 * Create the data directory and its sub-folders. A directory made by this call is private to its
 * owner (it will hold `secret.key`); an existing one keeps its mode.
 * @param {string} dataDir
 * @returns {DataPaths}
 */
export function prepareDataDir(dataDir) {
  const paths = dataPaths(dataDir);
  const existed = fs.existsSync(dataDir);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    for (const dir of [
      paths.tlsDir,
      paths.logsDir,
      paths.toolkitDir,
      paths.mediaDir,
      paths.projectsDir,
      paths.proxyCacheDir,
      paths.renderCacheDir,
      paths.locksDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!existed) restrictToOwner(dataDir);
    restrictToOwner(paths.tlsDir);
  } catch (error) {
    throw new AppError("io", `The data folder ${dataDir} cannot be prepared.`, { cause: error });
  }
  return paths;
}

/**
 * Whether a process with this id is running. `EPERM` means it exists but belongs to someone else.
 * @param {number} pid
 * @returns {boolean}
 */
export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code === "EPERM";
  }
}

/**
 * Take the single-instance lock of a data directory: a file holding the process id. The lock of a
 * dead process is taken over. Released by `release()` and when the process exits.
 *
 * Two servers starting at the very same instant on a stale lock could both pass the stale check;
 * the exclusive create makes one of them lose, except in a window of microseconds that a person
 * starting servers by hand does not reach.
 * @param {string} lockFile
 * @param {{ pid?: number, isAlive?: (pid: number) => boolean, releaseOnExit?: boolean }} [options]
 * @returns {{ release(): void }}
 */
export function acquireLock(
  lockFile,
  { pid = process.pid, isAlive = processIsAlive, releaseOnExit = true } = {},
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(lockFile, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return makeLock(lockFile, pid, releaseOnExit);
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== "EEXIST") {
        throw new AppError("io", "The lock file in the data folder cannot be written.", {
          cause: error,
        });
      }
    }
    const holder = Number.parseInt(readText(lockFile), 10);
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
      throw new AppError(
        "conflict",
        `Another VidAI Server (process ${holder}) is already using this data folder.`,
      );
    }
    fs.rmSync(lockFile, { force: true });
  }
  throw new AppError("conflict", "The lock file of the data folder keeps changing.");
}

/** @param {string} file */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string} lockFile
 * @param {number} pid
 * @param {boolean} releaseOnExit
 */
function makeLock(lockFile, pid, releaseOnExit) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    // Only our own lock: after a takeover the file belongs to someone else.
    if (Number.parseInt(readText(lockFile), 10) === pid) fs.rmSync(lockFile, { force: true });
  };
  if (releaseOnExit) process.on("exit", release);
  return { release };
}
