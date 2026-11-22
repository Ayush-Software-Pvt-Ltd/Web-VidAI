// The registry of the processes the job engine started (docs/SPEC.md section 9 and the registry
// of `platform/process/mod.rs` in the old core): a file the engine keeps current while jobs run,
// so that the next start of the server can end what a crashed or killed server left behind.
//
//   const registry = createProcessRegistry({ file, isAlive, endTree, clock, log });
//   await registry.add({ jobId, pid, startedAt });   // while a job runs
//   registry.remove(pid);                            // when its process was ended
//   await registry.endLeftovers();                   // once, at the start, before any job
//
// Same process, not just same pid: an entry holds the command line the process had, and a
// leftover is ended only when a process with that pid still exists AND has that command line, so
// a pid that the system reused for another program is never touched (as `sweep_registry` did).
// An entry whose command line could not be read is kept in the file but never ended.
//
// The file is `<data dir>/processes.json`, written by temp name and rename. A damaged file counts
// as empty.

import fs from "node:fs";
import path from "node:path";
import { commandOf as systemCommandOf } from "../platform/processCommand.js";

/**
 * One recorded process.
 * @typedef {object} RegistryEntry
 * @property {string} jobId
 * @property {number} pid
 * @property {number} startedAt Epoch ms, when it was recorded.
 * @property {string | null} command Its command line; `null` when it could not be read.
 */

/**
 * @typedef {object} ProcessRegistryOptions
 * @property {string} file `<data dir>/processes.json`.
 * @property {(pid: number) => boolean} isAlive
 * @property {(pid: number, options?: { graceMs?: number, knownPids?: readonly number[] }) => Promise<boolean>} endTree
 * @property {{ now(): number }} clock
 * @property {{ info(message: string, detail?: unknown): void, warn(message: string, detail?: unknown): void }} [log]
 * @property {(pid: number) => Promise<string | null>} [commandOf] The command line of a process;
 *   default: the system's (`platform/processCommand.js`).
 * @property {number} [graceMs] How long an ended tree may take (default 3000).
 */

/**
 * @typedef {object} ProcessRegistry
 * @property {(entry: { jobId: string, pid: number, startedAt?: number, command?: string | null }) => Promise<void>} add
 *   Records a process (its command line is read now unless given). A pid already recorded is
 *   left as it is.
 * @property {(pid: number) => Promise<void>} remove Forgets a process.
 * @property {() => Promise<number>} endLeftovers Ends the recorded trees that still run and are
 *   the same process, then clears the file. Returns how many processes it ended.
 * @property {() => RegistryEntry[]} entries What is recorded now.
 */

/**
 * Reads the file; a missing or damaged file, or an entry that is not valid, counts as empty.
 * @param {string} file
 * @returns {RegistryEntry[]}
 */
export function readRegistry(file) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  /** @type {RegistryEntry[]} */
  const entries = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const e = /** @type {Record<string, unknown>} */ (item);
    if (
      typeof e["jobId"] === "string" &&
      typeof e["pid"] === "number" &&
      Number.isInteger(e["pid"]) &&
      e["pid"] > 0
    ) {
      entries.push({
        jobId: e["jobId"],
        pid: e["pid"],
        startedAt: typeof e["startedAt"] === "number" ? e["startedAt"] : 0,
        command: typeof e["command"] === "string" && e["command"] !== "" ? e["command"] : null,
      });
    }
  }
  return entries;
}

/**
 * Writes the file by temp name and rename, so it is never half written.
 * @param {string} file
 * @param {readonly RegistryEntry[]} entries
 */
function writeRegistry(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entries));
  fs.renameSync(temp, file);
}

/**
 * @param {ProcessRegistryOptions} options
 * @returns {ProcessRegistry}
 */
export function createProcessRegistry(options) {
  const { file, isAlive, endTree, clock } = options;
  const log = options.log ?? { info() {}, warn() {} };
  const commandOf = options.commandOf ?? ((/** @type {number} */ pid) => systemCommandOf(pid));
  const graceMs = options.graceMs ?? 3000;
  /** @type {Map<number, RegistryEntry>} */
  const current = new Map();
  /** One change at a time, so the file always shows a whole state. */
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  const save = () => {
    try {
      writeRegistry(file, [...current.values()]);
    } catch (error) {
      log.warn("The process registry could not be written", error);
    }
  };
  /**
   * @template T
   * @param {() => Promise<T> | T} change
   * @returns {Promise<T>}
   */
  const queue = (change) => {
    const next = chain.then(change);
    chain = next.catch(() => {});
    return next;
  };

  return {
    entries: () => [...current.values()],
    add(entry) {
      return queue(async () => {
        if (current.has(entry.pid)) return;
        const command =
          entry.command !== undefined
            ? entry.command
            : await commandOf(entry.pid).catch(() => null);
        current.set(entry.pid, {
          jobId: entry.jobId,
          pid: entry.pid,
          startedAt: entry.startedAt ?? clock.now(),
          command: command === null || command === "" ? null : command,
        });
        save();
      });
    },
    remove(pid) {
      return queue(() => {
        if (current.delete(pid)) save();
      });
    },
    endLeftovers() {
      return queue(async () => {
        const recorded = readRegistry(file);
        /** @type {RegistryEntry[]} */
        const same = [];
        for (const entry of recorded) {
          if (entry.command === null || !isAlive(entry.pid)) continue;
          const now = await commandOf(entry.pid).catch(() => null);
          if (now !== null && now === entry.command) same.push(entry);
        }
        let ended = 0;
        for (const entry of same) {
          const known = same.filter((e) => e.jobId === entry.jobId).map((e) => e.pid);
          log.info(`Ending the process ${entry.pid} of job ${entry.jobId} left by an earlier run`);
          try {
            await endTree(entry.pid, { graceMs, knownPids: known });
            ended += 1;
          } catch (error) {
            log.warn(`The process ${entry.pid} could not be ended`, error);
          }
        }
        current.clear();
        save();
        return ended;
      });
    },
  };
}
