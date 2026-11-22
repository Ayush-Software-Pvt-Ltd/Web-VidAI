// The recorded result of Prepare, kept in `<data dir>/toolkit/prepare.json` so the System page
// shows the steps after a restart (docs/SPEC.md section 7). Written whole through a temporary
// file and a rename; read leniently (a missing or damaged file means "never prepared").

import fs from "node:fs";
import path from "node:path";
import { STEPS } from "./steps.js";

/** @typedef {import("../../../src/lib/wire/system.ts").PrepareStepId} PrepareStepId */
/** @typedef {import("../../../src/lib/wire/system.ts").PrepareStepState} PrepareStepState */

/**
 * @typedef {object} StoredStep
 * @property {PrepareStepId} id
 * @property {PrepareStepState} state
 * @property {string | null} message
 * @property {number | null} at
 *
 * @typedef {object} StoredPrepare
 * @property {1} format
 * @property {StoredStep[]} steps Always every step, in order.
 * @property {string[]} log The last lines printed (at most `LOG_LINES`).
 * @property {string | null} requirementsHash The hash of `requirements.txt` the packages were
 *   installed from at the last successful install; `null` before.
 * @property {number | null} startedAt
 * @property {number | null} finishedAt
 */

/** How many log lines are kept. */
export const LOG_LINES = 200;

/** The text of a step that was running when the server stopped. */
export const INTERRUPTED = "The server stopped while this step was running. Press Prepare again.";

/** @returns {StoredPrepare} */
export function emptyPrepare() {
  return {
    format: 1,
    steps: STEPS.map((step) => ({ id: step.id, state: "pending", message: null, at: null })),
    log: [],
    requirementsHash: null,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the stored record. A step left `running` by a crash becomes `failed`.
 * @param {string} file
 * @returns {StoredPrepare}
 */
export function readPrepare(file) {
  const fresh = emptyPrepare();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fresh;
  }
  if (!isRecord(raw)) return fresh;
  const stored = Array.isArray(raw.steps) ? raw.steps : [];
  for (const step of fresh.steps) {
    const found = stored.find((s) => isRecord(s) && s.id === step.id);
    if (!isRecord(found)) continue;
    const state = found.state;
    if (state === "done" || state === "failed" || state === "running" || state === "pending") {
      step.state = state === "running" ? "failed" : state;
      step.message = state === "running" ? INTERRUPTED : typeof found.message === "string" ? found.message : null;
      step.at = typeof found.at === "number" ? found.at : null;
    }
  }
  if (Array.isArray(raw.log)) {
    fresh.log = raw.log.filter((line) => typeof line === "string").slice(-LOG_LINES);
  }
  if (typeof raw.requirementsHash === "string") fresh.requirementsHash = raw.requirementsHash;
  if (typeof raw.startedAt === "number") fresh.startedAt = raw.startedAt;
  if (typeof raw.finishedAt === "number") fresh.finishedAt = raw.finishedAt;
  return fresh;
}

/**
 * Writes the record so it appears whole or not at all.
 * @param {string} file
 * @param {StoredPrepare} record
 */
export function writePrepare(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temp, file);
}
