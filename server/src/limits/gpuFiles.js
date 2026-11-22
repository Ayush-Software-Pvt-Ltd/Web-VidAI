// The file operations of the GPU slots (docs/SPEC.md section 9, GPU). The format on disk and every
// operation is described in the head of `gpuSlots.js`; this file is the code of it, shared by the
// server's keeper and by the client of the server's own render runner. Everything here is
// synchronous on purpose: a decision ("this slot is stale") and the rename that acts on it must not
// have an `await` between them, or two clients of one process could interleave.

import fs from "node:fs";
import path from "node:path";

/** A slot not renewed for this long is expired (SPEC: 15 minutes). */
export const LEASE_MS = 15 * 60 * 1000;
/** How often the holder sets the modified time of its slot (SPEC: 60 seconds). */
export const RENEW_MS = 60 * 1000;
/**
 * The limits assumed when `limits.json` is missing or unreadable: one slot in all and one per job,
 * the same as the toolkit assumes (SPEC section 9), so a damaged file never opens the GPU wide.
 */
export const DEFAULT_LIMITS = Object.freeze({ total: 1, perJob: 1 });

/**
 * @typedef {object} SlotRecord The content of a slot file.
 * @property {string} jobId
 * @property {number} pid
 * @property {number} at When it was taken, milliseconds since 1970.
 */

/**
 * @typedef {object} SlotFile What a slot file holds right now.
 * @property {number} index
 * @property {SlotRecord | null} record `null` when the content is not a valid record (empty
 *   because its creator has not written it yet, cut short, corrupt).
 * @property {number} mtimeMs
 */

/** The file name of slot `index`. @param {number} index */
export const slotName = (index) => `slot-${index}`;

/**
 * The index in a slot file name, `null` for any other name.
 * @param {string} name
 * @returns {number | null}
 */
export function slotIndex(name) {
  const m = /^slot-(\d{1,6})$/.exec(name);
  return m === null ? null : Number(m[1]);
}

let uniqueCounter = 0;
/** A name part no other writer uses: process id, a counter and random digits. */
function unique() {
  uniqueCounter += 1;
  return `${process.pid}-${uniqueCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Reads `limits.json`. `null` when it is missing or not `{ total, perJob }` of whole numbers
 * from 1 (a program then uses the defaults).
 * @param {string} dir
 * @returns {import("./budget.js").GpuSlotLimits | null}
 */
export function readLimits(dir) {
  try {
    const value = /** @type {unknown} */ (
      JSON.parse(fs.readFileSync(path.join(dir, "limits.json"), "utf8"))
    );
    if (typeof value !== "object" || value === null) return null;
    const { total, perJob } = /** @type {Record<string, unknown>} */ (value);
    if (!Number.isInteger(total) || !Number.isInteger(perJob)) return null;
    const t = /** @type {number} */ (total);
    const p = /** @type {number} */ (perJob);
    if (t < 1 || p < 1) return null;
    return { total: t, perJob: Math.min(p, t) };
  } catch {
    return null;
  }
}

/**
 * Writes `limits.json` by writing a temporary file in the same folder, then renaming it over the
 * real name, so a reader never sees half a file.
 * @param {string} dir
 * @param {import("./budget.js").GpuSlotLimits} limits
 */
export function writeLimits(dir, limits) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "limits.json");
  const temporary = `${target}.tmp-${unique()}`;
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ total: limits.total, perJob: limits.perJob })}\n`,
    );
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {SlotRecord | null}
 */
function toRecord(value) {
  if (typeof value !== "object" || value === null) return null;
  const { jobId, pid, at } = /** @type {Record<string, unknown>} */ (value);
  if (typeof jobId !== "string" || !Number.isInteger(pid) || typeof at !== "number") return null;
  return { jobId, pid: /** @type {number} */ (pid), at };
}

/**
 * Reads one file of a slot (or a renamed copy of it).
 * @param {string} file
 * @param {number} index
 * @returns {SlotFile | null} `null` when the file does not exist.
 */
export function readSlotFile(file, index) {
  /** @type {fs.Stats} */
  let stat;
  /** @type {string} */
  let text;
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  /** @type {SlotRecord | null} */
  let record;
  try {
    record = toRecord(JSON.parse(text));
  } catch {
    record = null;
  }
  return { index, record, mtimeMs: stat.mtimeMs };
}

/**
 * Every slot file in the folder (any index), in index order. Names that are not slots (the
 * limits file, temporary and renamed-away files) are skipped.
 * @param {string} dir
 * @returns {SlotFile[]}
 */
export function readSlots(dir) {
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {SlotFile[]} */
  const slots = [];
  for (const name of names) {
    const index = slotIndex(name);
    if (index === null) continue;
    const slot = readSlotFile(path.join(dir, name), index);
    if (slot !== null) slots.push(slot);
  }
  return slots.sort((a, b) => a.index - b.index);
}

/**
 * Why a slot may be taken over, `null` while it is held. A slot with an unreadable record is
 * judged by its age only (its creator may still be about to write it).
 * @param {SlotFile} slot
 * @param {number} now
 * @param {(pid: number) => boolean} isAlive
 * @param {number} [leaseMs]
 * @returns {"expired" | "holder gone" | null}
 */
export function staleReason(slot, now, isAlive, leaseMs = LEASE_MS) {
  if (now - slot.mtimeMs > leaseMs) return "expired";
  if (slot.record !== null && !isAlive(slot.record.pid)) return "holder gone";
  return null;
}

/**
 * Creates `slot-<index>` with exclusive create (it fails when the name exists), writes the record
 * and sets the modified time to `now` (so the lease runs on the caller's clock).
 * @param {string} dir
 * @param {number} index
 * @param {SlotRecord} record
 * @returns {boolean} Whether this call created it.
 */
export function createSlotFile(dir, index, record) {
  /** @type {number} */
  let fd;
  try {
    fd = fs.openSync(path.join(dir, slotName(index)), "wx");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify(record));
    fs.futimesSync(fd, record.at / 1000, record.at / 1000);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** @param {SlotFile} a @param {SlotFile} b */
function sameSlot(a, b) {
  return (
    a.mtimeMs === b.mtimeMs &&
    a.record?.jobId === b.record?.jobId &&
    a.record?.pid === b.record?.pid &&
    a.record?.at === b.record?.at
  );
}

/**
 * Removes the slot file when `decide` says so, the way SPEC section 9 takes a slot over: read it,
 * decide, rename it to a unique name, check that what was renamed is what was judged, delete the
 * renamed file. Of many programs doing this at once exactly one rename succeeds.
 *
 * The check after the rename covers the one race the plain rule has: between this program's read
 * and its rename another one may have removed the stale file AND created a fresh slot under the
 * same name, which the rename would then carry away. When that happens the fresh file is put
 * back with `link` (which fails instead of overwriting). If someone created the name again
 * meanwhile, the displaced holder has lost its slot and finds out at its next renewal (the
 * renewal checks the file's content); this needs three programs inside a few microseconds.
 * @param {string} dir
 * @param {number} index
 * @param {(slot: SlotFile) => string | null} decide A reason to remove it, or `null` to keep it.
 * @returns {{ result: "removed", reason: string, slot: SlotFile } | { result: "kept" | "gone" }}
 */
export function removeSlotIf(dir, index, decide) {
  const file = path.join(dir, slotName(index));
  const before = readSlotFile(file, index);
  if (before === null) return { result: "gone" };
  const reason = decide(before);
  if (reason === null) return { result: "kept" };
  const away = `${file}.gone-${unique()}`;
  try {
    fs.renameSync(file, away);
  } catch {
    return { result: "gone" };
  }
  const moved = readSlotFile(away, index);
  if (moved !== null && sameSlot(moved, before)) {
    fs.rmSync(away, { force: true });
    return { result: "removed", reason, slot: before };
  }
  try {
    fs.linkSync(away, file);
  } catch {
    // The name was taken again: the displaced holder notices at its next renewal.
  }
  fs.rmSync(away, { force: true });
  return { result: "kept" };
}

/**
 * Removes what crashed writers left: renamed-away slot files and temporary limits files older
 * than the lease.
 * @param {string} dir
 * @param {number} now
 * @param {number} [leaseMs]
 */
export function removeLeftovers(dir, now, leaseMs = LEASE_MS) {
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^slot-\d+\../.test(name) && !/^limits\.json\.tmp-/.test(name)) continue;
    try {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > leaseMs) fs.rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}
