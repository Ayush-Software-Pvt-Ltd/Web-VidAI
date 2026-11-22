// The job log on disk (src-tauri/src/store.rs, job logs): one JSON object per line in
// `<data dir>/logs/<jobId>.jsonl`, appended in batches.
//
// Files are read and written synchronously on purpose: a batch is a few kilobytes every 150 ms,
// and a synchronous append keeps batches in order and a read never sees half of one.

import fs from "node:fs";
import path from "node:path";
import { invalidInput } from "../errors.js";
import { MAX_LOG_ENTRIES } from "./logText.js";

/**
 * One line of the log, as it is stored and as it goes to the UI (`LogEntry` of
 * `src/lib/bindings.ts`, field for field). Every field is always present.
 * @typedef {object} LogEntry
 * @property {number} seq Increasing per job.
 * @property {string} ts
 * @property {import("./logDescribe.js").LogKind} kind
 * @property {string} text One short readable line or the assistant's text.
 * @property {string | null} detail Full command / input / output, truncated to
 *   `MAX_LOG_DETAIL_CHARS`.
 * @property {boolean} nested Produced by a sub-agent.
 */

/**
 * The TypeScript declaration for `src/lib/wire.ts` (not edited by this module):
 *
 *     export type LogKind = "status" | "assistant" | "tool" | "toolResult" | "user" | "error";
 *     export interface LogEntry {
 *       seq: number; ts: string; kind: LogKind; text: string; detail: string | null; nested: boolean;
 *     }
 *     export interface JobLog { videoId: string; jobId: string; entries: LogEntry[]; }
 *
 * @typedef {object} JobLogBatch New log entries of one job, batched (at most every 150 ms): the
 *   `job-log` event.
 * @property {string} videoId
 * @property {string} jobId
 * @property {LogEntry[]} entries
 */

const KINDS = new Set(["status", "assistant", "tool", "toolResult", "user", "error"]);

/**
 * @typedef {object} LogStore
 * @property {(jobId: string) => string} path Path of `<jobId>.jsonl`. Rejects ids that are not
 *   plain file names.
 * @property {(jobId: string, entries: readonly LogEntry[]) => void} append Appends entries, one
 *   JSON object per line. Throws on a write error.
 * @property {(jobId: string, limit?: number) => LogEntry[]} read The last `limit` entries
 *   (default `MAX_LOG_ENTRIES`), oldest first. A missing log is empty; lines that cannot be
 *   parsed (for example a line cut short by a crash) are skipped.
 * @property {(jobId: string) => void} remove Deletes the log (used when a newer job replaces
 *   it). A missing log is fine.
 */

/**
 * @param {unknown} value
 * @returns {value is LogEntry}
 */
function isLogEntry(value) {
  if (typeof value !== "object" || value === null) return false;
  const e = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof e.seq === "number" &&
    Number.isFinite(e.seq) &&
    typeof e.ts === "string" &&
    typeof e.kind === "string" &&
    KINDS.has(e.kind) &&
    typeof e.text === "string" &&
    (e.detail === null || typeof e.detail === "string") &&
    typeof e.nested === "boolean"
  );
}

/**
 * @param {object} options
 * @param {string} options.dir The logs folder (`<data dir>/logs`); created on the first write.
 * @returns {LogStore}
 */
export function createLogStore({ dir }) {
  /** @param {string} jobId */
  function logPath(jobId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
      throw invalidInput(`Invalid job id: ${JSON.stringify(jobId)}`);
    }
    return path.join(dir, `${jobId}.jsonl`);
  }

  return {
    path: logPath,
    append(jobId, entries) {
      const file = logPath(jobId);
      if (entries.length === 0) return;
      // Key order of the Rust struct, so the files stay readable by either side.
      const lines = entries.map((e) =>
        JSON.stringify({
          seq: e.seq,
          ts: e.ts,
          kind: e.kind,
          text: e.text,
          detail: e.detail,
          nested: e.nested,
        }),
      );
      let buffer = `${lines.join("\n")}\n`;
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(file, "a+");
      try {
        // A line cut short by a crash must not swallow the first new entry.
        const size = fs.fstatSync(fd).size;
        if (size > 0) {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) buffer = `\n${buffer}`;
        }
        fs.writeSync(fd, buffer);
      } finally {
        fs.closeSync(fd);
      }
    },
    read(jobId, limit = MAX_LOG_ENTRIES) {
      const file = logPath(jobId);
      if (limit <= 0) return [];
      /** @type {string} */
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
        throw error;
      }
      /** @type {LogEntry[]} */
      const out = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed = JSON.parse(line);
          if (isLogEntry(parsed)) {
            out.push({
              seq: parsed.seq,
              ts: parsed.ts,
              kind: parsed.kind,
              text: parsed.text,
              detail: parsed.detail,
              nested: parsed.nested,
            });
          }
        } catch {
          // A line cut short by a crash.
        }
      }
      return out.length > limit ? out.slice(out.length - limit) : out;
    },
    remove(jobId) {
      try {
        fs.rmSync(logPath(jobId));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      }
    },
  };
}
