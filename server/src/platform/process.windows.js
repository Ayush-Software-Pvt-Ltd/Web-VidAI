// Process trees on Windows.
//
// There are no process groups: the tree is found from a `Win32_Process` listing (PowerShell)
// by parent id, and ended with `taskkill /T`. A parent id can outlive its parent and be reused
// by an unrelated process, so a child only counts when it started after its parent.
//
// Windows has no polite stop for windowless programs, so `endTree` asks once with `taskkill`
// (programs with a window get WM_CLOSE) and forces after a short wait. Suspending is not
// supported (`suspend` and `resume` return false).
//
// SPEC section 11 asks for a Job Object so that the tree dies with the server; that is a
// separate piece (it needs native code) and is not done here.

import { delay, isAlive, runTool } from "./process.common.js";

/**
 * One process of the Windows process list.
 * @typedef {object} WinRow
 * @property {number} pid
 * @property {number} ppid
 * @property {number | null} start Creation time (any unit that orders processes), if known.
 */

/**
 * Splits CSV text (RFC 4180 quoting, as `ConvertTo-Csv` writes it) into records.
 * @param {string} text
 * @returns {string[][]}
 */
function csvRecords(text) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let record = [];
  let field = "";
  let quoted = false;
  let any = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i += 1) {
    const ch = /** @type {string} */ (body[i]);
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      any = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      any = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i += 1;
      if (any || field !== "") {
        record.push(field);
        records.push(record);
      }
      record = [];
      field = "";
      any = false;
    } else {
      field += ch;
      any = true;
    }
  }
  if (any || field !== "") {
    record.push(field);
    records.push(record);
  }
  return records;
}

/**
 * Objects with the header names (lowercased) as keys.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
function csvObjects(text) {
  const [header, ...rest] = csvRecords(text);
  if (header === undefined) return [];
  const names = header.map((h) => h.trim().toLowerCase());
  return rest.map((record) => {
    /** @type {Record<string, string>} */
    const row = {};
    names.forEach((name, i) => {
      row[name] = record[i] ?? "";
    });
    return row;
  });
}

/**
 * Rows as objects with lowercased keys from either output form of PowerShell: CSV, or JSON
 * (`ConvertTo-Json` writes one object, not an array, when there is a single row).
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
function tableRows(text) {
  const trimmed = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
    const list = Array.isArray(value) ? value : [value];
    return list
      .filter((item) => typeof item === "object" && item !== null)
      .map((item) => {
        /** @type {Record<string, unknown>} */
        const row = {};
        for (const [key, v] of Object.entries(/** @type {object} */ (item))) {
          row[key.toLowerCase()] = v;
        }
        return row;
      });
  }
  return csvObjects(trimmed);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses the process list written by `LIST_SCRIPT` (CSV or JSON with `ProcessId`,
 * `ParentProcessId` and `Start`).
 * @param {string} text
 * @returns {WinRow[]}
 */
export function parseWindowsProcesses(text) {
  /** @type {WinRow[]} */
  const rows = [];
  for (const row of tableRows(text)) {
    const pid = numberOrNull(row["processid"]);
    const ppid = numberOrNull(row["parentprocessid"]);
    if (pid === null || ppid === null) continue;
    rows.push({ pid, ppid, start: numberOrNull(row["start"]) });
  }
  return rows;
}

/**
 * Parses the CPU list written by `CPU_SCRIPT` (`Id` and `Cpu`) into seconds by pid.
 * @param {string} text
 * @returns {Map<number, number>}
 */
export function parseWindowsCpu(text) {
  /** @type {Map<number, number>} */
  const out = new Map();
  for (const row of tableRows(text)) {
    const pid = numberOrNull(row["id"]);
    const cpu = numberOrNull(row["cpu"]);
    if (pid !== null && cpu !== null) out.set(pid, cpu);
  }
  return out;
}

/**
 * The members of the tree of `rootPid`: the root and the known pids that exist, and everything
 * below them by parent id that started after its parent (a reused parent id is no parent).
 * The server itself and pids 0 and 4 (System) are never members.
 * @param {readonly WinRow[]} rows
 * @param {number} rootPid
 * @param {{ knownPids?: readonly number[], selfPid?: number }} [options]
 * @returns {number[]} Root first when it is a member, then by pid.
 */
export function collectWindowsTree(rows, rootPid, options = {}) {
  const selfPid = options.selfPid ?? process.pid;
  const live = rows.filter((r) => r.pid > 4 && r.pid !== selfPid);
  /** @type {Map<number, WinRow>} */
  const members = new Map();
  const seeds = new Set([rootPid, ...(options.knownPids ?? [])]);
  for (const row of live) if (seeds.has(row.pid)) members.set(row.pid, row);
  for (;;) {
    const before = members.size;
    for (const row of live) {
      if (members.has(row.pid)) continue;
      const parent = members.get(row.ppid);
      if (parent === undefined) continue;
      if (row.start !== null && parent.start !== null && row.start < parent.start) continue;
      members.set(row.pid, row);
    }
    if (members.size === before) break;
  }
  return [...members.keys()].sort((a, b) => (a === rootPid ? -1 : b === rootPid ? 1 : a - b));
}

/** PowerShell that prints the process list as CSV (`Start` is the creation time as a number). */
const LIST_SCRIPT =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId," +
  "@{n='Start';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' }}} | " +
  "ConvertTo-Csv -NoTypeInformation";

/**
 * @param {readonly number[]} pids
 * @returns {string}
 */
function cpuScript(pids) {
  return (
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,` +
    "@{n='Cpu';e={[math]::Round($_.TotalProcessorTime.TotalSeconds,3)}} | " +
    "ConvertTo-Csv -NoTypeInformation"
  );
}

/**
 * Runs PowerShell without a profile and without a window.
 * @param {string} script
 * @returns {Promise<string | null>} Its output, `null` when it could not run.
 */
async function powershell(script) {
  const out = await runTool(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs: 20_000 },
  );
  return out === null || !out.ok ? null : out.stdout;
}

/**
 * The process list, or `null` when PowerShell could not provide it.
 * @returns {Promise<WinRow[] | null>}
 */
export async function snapshot() {
  const out = await powershell(LIST_SCRIPT);
  return out === null ? null : parseWindowsProcesses(out);
}

/**
 * The live members of the tree of `rootPid`.
 * @param {number} rootPid
 * @param {readonly number[]} [knownPids]
 * @returns {Promise<number[]>}
 */
export async function listTree(rootPid, knownPids = []) {
  const rows = await snapshot();
  if (rows === null) return isAlive(rootPid) ? [rootPid] : [];
  return collectWindowsTree(rows, rootPid, { knownPids });
}

/**
 * `taskkill` for the given pids (and their children, with `/T`).
 * @param {readonly number[]} pids
 * @param {{ force: boolean }} options
 * @returns {Promise<void>}
 */
async function taskkill(pids, { force }) {
  if (pids.length === 0) return;
  const args = pids.flatMap((pid) => ["/PID", String(pid)]);
  await runTool("taskkill", [...args, "/T", ...(force ? ["/F"] : [])], { timeoutMs: 15_000 });
}

/**
 * Ends the whole tree: a polite `taskkill /T`, a wait of at most 500 ms (or `graceMs` if
 * shorter), then `taskkill /T /F` for the members still there.
 * @param {number} rootPid
 * @param {{ graceMs?: number, knownPids?: readonly number[] }} [options]
 * @returns {Promise<boolean>} Whether nothing of the tree is left.
 */
export async function endTree(rootPid, options = {}) {
  const graceMs = options.graceMs ?? 3000;
  const known = new Set(options.knownPids ?? []);
  /** @returns {Promise<number[]>} */
  const look = async () => {
    const pids = await listTree(rootPid, [...known]);
    for (const pid of pids) known.add(pid);
    return pids;
  };
  let pids = await look();
  if (pids.length === 0) return true;
  await taskkill(pids, { force: false });
  const politeEnd = Date.now() + Math.min(graceMs, 500);
  while (Date.now() < politeEnd) {
    await delay(50);
    pids = await look();
    if (pids.length === 0) return true;
  }
  await taskkill(pids, { force: true });
  const giveUp = Date.now() + 2000;
  while (Date.now() < giveUp) {
    await delay(50);
    pids = await look();
    if (pids.length === 0) return true;
    await taskkill(pids, { force: true });
  }
  return false;
}

/**
 * Suspending is not supported on Windows.
 * @returns {Promise<boolean>}
 */
export function suspend() {
  return Promise.resolve(false);
}

/**
 * Resuming is not supported on Windows.
 * @returns {Promise<boolean>}
 */
export function resume() {
  return Promise.resolve(false);
}

/**
 * CPU seconds used so far by each of `pids` (processes that are gone are missing).
 * @param {readonly number[]} pids
 * @returns {Promise<Map<number, number>>}
 */
export async function cpuByPid(pids) {
  if (pids.length === 0) return new Map();
  const out = await powershell(cpuScript(pids));
  return out === null ? new Map() : parseWindowsCpu(out);
}

/**
 * The total CPU seconds used so far by `pids`.
 * @param {readonly number[]} pids
 * @returns {Promise<number>}
 */
export async function treeCpuSeconds(pids) {
  let total = 0;
  for (const seconds of (await cpuByPid(pids)).values()) total += seconds;
  return total;
}
