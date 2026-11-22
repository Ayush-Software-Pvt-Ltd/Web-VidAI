#!/usr/bin/env node
// The VidAI Server executable (docs/SPEC.md section 2): arguments, data directory, lock, start,
// signals. Everything else is built by `app.js`.
//
// Exit codes: 0 clean, 1 error, 2 bad usage.
import fs from "node:fs";
import readline from "node:readline";
import { acquireLock, loadConfig, prepareDataDir, dataPaths, usageText } from "./config.js";
import { AppError } from "./errors.js";
import { createLogger } from "./log.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/** How long the first signal waits for the server to stop (SPEC section 2). */
const STOP_LIMIT_MS = 40_000;
/** How long a crash waits for a best-effort stop before exiting. */
const CRASH_STOP_LIMIT_MS = 5_000;

/** Signals that stop the server; SIGBREAK is Ctrl+Break on Windows and never fires elsewhere. */
const STOP_SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGBREAK"]);

/**
 * `node:sqlite` prints an ExperimentalWarning that scares operators and means nothing to them.
 * Only that one warning is dropped; every other warning is printed as usual.
 */
function silenceSqliteWarning() {
  const original = process.emitWarning;
  process.emitWarning = /** @type {typeof process.emitWarning} */ (
    (warning, ...rest) => {
      const first = rest[0];
      const type =
        typeof first === "string"
          ? first
          : typeof first === "object" && first !== null
            ? (first.type ?? "")
            : "";
      const text = typeof warning === "string" ? warning : warning.message;
      if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
      return Reflect.apply(original, process, [warning, ...rest]);
    }
  );
}

/** The text of `-h`: the options of `config.js` plus the one command this file knows. */
function fullUsage() {
  return [
    usageText().trimEnd(),
    "",
    "Commands:",
    "  admin-reset --email <email>   Set a new password for an admin (asks for it twice)",
    "",
  ].join("\n");
}

/**
 * @param {string} message
 * @returns {number} The usage exit code.
 */
function usageError(message) {
  process.stderr.write(`${message}\nRun "node server/src/main.js -h" for the options.\n`);
  return EXIT_USAGE;
}

/**
 * Read a password without showing it. On a terminal the keys are read one by one with echo off;
 * otherwise (a script, a test) one line of standard input is the answer.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function askPassword(prompt) {
  const input = process.stdin;
  if (!input.isTTY) return readLine(input);
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let text = "";
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    /** @param {Error | null} error */
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(text);
    };
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const key of chunk) {
        if (key === "\r" || key === "\n" || key === "\u0004") return finish(null);
        if (key === "\u0003") return finish(new AppError("io", "Cancelled."));
        if (key === "\u007f" || key === "\b") text = [...text].slice(0, -1).join("");
        else if (key >= " ") text += key;
      }
    };
    input.on("data", onData);
  });
}

/**
 * @param {NodeJS.ReadableStream} input
 * @returns {Promise<string>}
 */
async function readLine(input) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
  } finally {
    lines.close();
  }
  throw new AppError("invalidInput", "No password was given on standard input.");
}

/**
 * The new password: typed twice on a terminal, or one line of standard input (scripts, tests).
 * @returns {Promise<string>}
 */
async function askNewPassword() {
  const first = await askPassword("New password: ");
  if (!process.stdin.isTTY) return first;
  const second = await askPassword("New password again: ");
  if (first !== second) throw new AppError("invalidInput", "The two passwords are not the same.");
  return first;
}

/**
 * `admin-reset --email <email>` (SPEC section 2): sets a new password for a locked-out admin.
 * It works on the database directly, so it also works while the server runs.
 * @param {import("./config.js").Config} config
 * @returns {Promise<number>}
 */
async function adminReset(config) {
  const { email, ...unknown } = config.extra;
  const unknownNames = Object.keys(unknown);
  if (unknownNames.length > 0) return usageError(`Unknown option --${unknownNames[0]}.`);
  if (typeof email !== "string" || email.trim() === "") {
    return usageError("admin-reset needs --email <email>.");
  }
  const paths = dataPaths(config.dataDir);
  if (!fs.existsSync(paths.db)) {
    throw new AppError("notFound", `There is no VidAI data in ${config.dataDir}.`);
  }
  const { openDatabase, systemClock } = await import("./db/open.js");
  const { createUsersRepo } = await import("./db/users.js");
  const { createSessionsRepo } = await import("./db/sessions.js");
  const { createSessions } = await import("./auth/sessions.js");
  const { resetAdminPassword } = await import("./auth/setup.js");
  const db = openDatabase(paths.db);
  try {
    const users = createUsersRepo(db);
    // Asked before the prompt, so a wrong email does not cost two typed passwords.
    if (users.byEmail(email.trim().toLowerCase())?.role !== "admin") {
      throw new AppError("notFound", "There is no admin account with this email.");
    }
    const password = await askNewPassword();
    const sessions = createSessions({
      sessions: createSessionsRepo(db),
      users,
      clock: systemClock,
    });
    const admin = await resetAdminPassword({ users, sessions, email, password });
    process.stdout.write(
      `The password of ${admin.email} was changed and all its sessions ended.\n`,
    );
  } finally {
    db.close();
  }
  return EXIT_OK;
}

/**
 * Run the server until a signal stops it.
 * @param {import("./config.js").Config} config
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number | null>} An exit code when it could not start, null while it runs.
 */
async function serve(config, env) {
  if (Object.keys(config.extra).length > 0) {
    return usageError(`Unknown option --${Object.keys(config.extra)[0]}.`);
  }
  const paths = prepareDataDir(config.dataDir);
  // Taken before anything else touches the database; released by app.stop() and on exit.
  const lock = acquireLock(paths.lockFile);
  const log = createLogger({ file: paths.serverLog, console: true });
  const { createApp } = await import("./app.js");
  /** @type {ReturnType<typeof createApp>} */
  let app;
  try {
    app = createApp({ config, env, log, options: { lock } });
  } catch (error) {
    lock.release();
    throw error;
  }

  let stopRequested = false;
  let crashing = false;
  /** @param {number} limitMs @returns {Promise<boolean>} Whether it stopped in time. */
  async function stopWithin(limitMs) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, limitMs);
    });
    try {
      return await Promise.race([app.stop().then(() => true), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => {
      if (stopRequested) {
        log.warn(`${signal} again: exiting at once.`);
        process.exit(EXIT_ERROR);
      }
      stopRequested = true;
      log.info(`${signal}: stopping. Press Ctrl+C again to exit at once.`);
      void stopWithin(STOP_LIMIT_MS).then((stopped) => {
        if (!stopped) log.error(`The server did not stop within ${STOP_LIMIT_MS / 1000} seconds.`);
        process.exit(stopped ? EXIT_OK : EXIT_ERROR);
      });
    });
  }
  process.on("unhandledRejection", (reason) => {
    log.error("An unhandled promise rejection (the server keeps running).", reason);
  });
  process.on("uncaughtException", (error) => {
    log.error("An uncaught exception (the server stops).", error);
    if (crashing) return;
    crashing = true;
    void stopWithin(CRASH_STOP_LIMIT_MS).then(() => process.exit(EXIT_ERROR));
  });

  /** @type {Awaited<ReturnType<typeof app.start>>} */
  let info;
  try {
    info = await app.start();
  } catch (error) {
    await app.stop();
    throw error;
  }
  const lines = ["", `VidAI Server ${app.version} is running. Open it at:`];
  for (const address of info.addresses) lines.push(`  ${address}`);
  if (info.adminCreatedFromEnv) {
    lines.push(
      "",
      `The admin account ${info.adminCreatedFromEnv} was created from VIDAI_ADMIN_EMAIL and VIDAI_ADMIN_PASSWORD.`,
    );
  }
  if (info.setupUrl) {
    lines.push(
      "",
      "There is no admin account yet. Open this address once to create it:",
      `  ${info.setupUrl}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n\n`);
  return null;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number | null>}
 */
async function main(argv, env) {
  silenceSqliteWarning();
  /** @type {import("./config.js").Config} */
  let config;
  try {
    config = loadConfig({ argv, env });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  if (config.help) {
    process.stdout.write(fullUsage());
    return EXIT_OK;
  }
  if (config.command === "admin-reset") return adminReset(config);
  if (config.command !== null) return usageError(`Unknown command "${config.command}".`);
  return serve(config, env);
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    // null: the server runs on; its handles keep the process alive until a signal ends it.
    if (code !== null) process.exit(code);
  },
  (error) => {
    const message =
      error instanceof AppError
        ? error.message
        : `VidAI Server could not start: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`${message}\n`);
    if (!(error instanceof AppError) && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exit(EXIT_ERROR);
  },
);
