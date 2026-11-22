// Process trees on macOS and Linux.
//
// A job's agent is started with `detached: true`, which makes it a session and process group
// leader (`pid === pgid`), so every program it starts shares that group unless it makes a group
// of its own (a shell with job control, a daemon). The tree of a job is therefore found from one
// `ps` snapshot: the descendants by parent id plus every member of the groups seen so far, and
// it is ended group-wise and pid-wise, never touching the server itself.

import { delay, isAlive, runTool } from "./process.common.js";

/**
 * One line of the process table.
 * @typedef {object} PsRow
 * @property {number} pid
 * @property {number} ppid
 * @property {number} pgid
 * @property {boolean} zombie Has ended, waits for its parent to collect it.
 */

/**
 * Parses `ps -axo pid=,ppid=,pgid=,stat=`. Lines that do not fit are skipped.
 * @param {string} text
 * @returns {PsRow[]}
 */
export function parsePs(text) {
  /** @type {PsRow[]} */
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      zombie: /** @type {string} */ (m[4]).startsWith("Z"),
    });
  }
  return rows;
}

/**
 * @typedef {object} TreeOptions
 * @property {readonly number[]} [knownPids] Processes known to belong to the tree even when
 *   they were handed to another parent (their groups count too).
 * @property {number} [selfPid] The server's own process id (default: this process).
 * @property {number | null} [selfPgid] The server's own group (default: read from the rows).
 */

/**
 * The members of the tree of `rootPid` in a process table.
 *
 * Members are the root, the known pids, their descendants by parent id, and every process of
 * a group a member belongs to (the root's own group included: it leads one). Zombies, pids 1
 * and below, the server itself and the server's own group are never members.
 * @param {readonly PsRow[]} rows
 * @param {number} rootPid
 * @param {TreeOptions} [options]
 * @returns {{ pids: number[], groups: number[] }} Members (root first when it is one, then by
 *   pid) and the groups they span.
 */
export function collectTree(rows, rootPid, options = {}) {
  const selfPid = options.selfPid ?? process.pid;
  const selfPgid =
    options.selfPgid !== undefined
      ? options.selfPgid
      : (rows.find((r) => r.pid === selfPid)?.pgid ?? null);
  const live = rows.filter((r) => !r.zombie && r.pid > 1 && r.pid !== selfPid);
  /** @type {Set<number>} */
  const members = new Set();
  /** @type {Set<number>} */
  const groups = new Set();
  /** @param {number} group */
  const addGroup = (group) => {
    if (group > 1 && group !== selfPgid) groups.add(group);
  };
  const seeds = new Set([rootPid, ...(options.knownPids ?? [])]);
  for (const row of live) if (seeds.has(row.pid)) members.add(row.pid);
  addGroup(rootPid);
  for (;;) {
    const before = members.size + groups.size;
    for (const row of live) {
      if (members.has(row.pid)) addGroup(row.pgid);
    }
    for (const row of live) {
      if (members.has(row.pid)) continue;
      if (members.has(row.ppid) || groups.has(row.pgid)) members.add(row.pid);
    }
    if (members.size + groups.size === before) break;
  }
  const pids = [...members].sort((a, b) => (a === rootPid ? -1 : b === rootPid ? 1 : a - b));
  return { pids, groups: [...groups].sort((a, b) => a - b) };
}

/**
 * The process table, or `null` when `ps` cannot be run.
 * @returns {Promise<PsRow[] | null>}
 */
export async function snapshot() {
  const out = await runTool("ps", ["-axo", "pid=,ppid=,pgid=,stat="]);
  return out === null || !out.ok ? null : parsePs(out.stdout);
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
  return collectTree(rows, rootPid, { knownPids }).pids;
}

/**
 * Sends `signal` to groups and pids, ignoring those that are gone. Never signals pid 1 or
 * below, the server, or the server's own group.
 * @param {{ pids: readonly number[], groups: readonly number[] }} tree
 * @param {NodeJS.Signals} signal
 * @param {number | null} selfPgid
 */
function signalTree(tree, signal, selfPgid) {
  /** @param {number} target */
  const send = (target) => {
    try {
      process.kill(target, signal);
    } catch {
      // Gone already, or not ours.
    }
  };
  for (const group of tree.groups) {
    if (group > 1 && group !== selfPgid) send(-group);
  }
  for (const pid of tree.pids) {
    if (pid > 1 && pid !== process.pid) send(pid);
  }
}

/**
 * @typedef {object} EndOptions
 * @property {number} [graceMs] How long the tree may take to end after SIGTERM (default 3000).
 * @property {readonly number[]} [knownPids]
 */

/**
 * Ends the whole tree: SIGTERM to every member, a check every 50 ms, SIGKILL for what is left
 * after `graceMs`, then up to 2 s of confirming. Anything that starts meanwhile is caught on the
 * next check.
 * @param {number} rootPid
 * @param {EndOptions} [options]
 * @returns {Promise<boolean>} Whether nothing of the tree is left.
 */
export async function endTree(rootPid, options = {}) {
  const graceMs = options.graceMs ?? 3000;
  const known = new Set(options.knownPids ?? []);
  /** @returns {Promise<{ pids: number[], groups: number[], selfPgid: number | null } | null>} */
  const look = async () => {
    const rows = await snapshot();
    if (rows === null) return null;
    const self = rows.find((r) => r.pid === process.pid)?.pgid ?? null;
    const tree = collectTree(rows, rootPid, { knownPids: [...known], selfPgid: self });
    for (const pid of tree.pids) known.add(pid);
    return { ...tree, selfPgid: self };
  };

  let tree = await look();
  if (tree === null) return endWithoutPs(rootPid, graceMs);
  if (tree.pids.length === 0) return true;
  signalTree(tree, "SIGTERM", tree.selfPgid);

  const graceEnd = Date.now() + graceMs;
  let killed = false;
  let confirmEnd = Number.POSITIVE_INFINITY;
  for (;;) {
    await delay(50);
    tree = await look();
    if (tree === null) return !isAlive(rootPid);
    if (tree.pids.length === 0) return true;
    const now = Date.now();
    if (!killed && now >= graceEnd) {
      killed = true;
      confirmEnd = now + 2000;
    }
    if (killed) {
      signalTree(tree, "SIGKILL", tree.selfPgid);
      if (now >= confirmEnd) return false;
    }
  }
}

/**
 * The fallback when `ps` cannot be run: the root's group and the root only.
 * @param {number} rootPid
 * @param {number} graceMs
 * @returns {Promise<boolean>}
 */
async function endWithoutPs(rootPid, graceMs) {
  const tree = { pids: rootPid > 1 ? [rootPid] : [], groups: rootPid > 1 ? [rootPid] : [] };
  signalTree(tree, "SIGTERM", null);
  const killAt = Date.now() + graceMs;
  const giveUp = killAt + 2000;
  while (Date.now() < giveUp) {
    await delay(50);
    if (!isAlive(rootPid)) return true;
    if (Date.now() >= killAt) signalTree(tree, "SIGKILL", null);
  }
  return !isAlive(rootPid);
}

/**
 * Stops (`suspend`) or continues (`resume`) every member of the tree.
 * @param {number} rootPid
 * @param {NodeJS.Signals} signal
 * @param {readonly number[]} knownPids
 * @returns {Promise<boolean>} Whether at least one process was signalled.
 */
async function signalAll(rootPid, signal, knownPids) {
  const pids = await listTree(rootPid, knownPids);
  let any = false;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      any = true;
    } catch {
      // Ended meanwhile.
    }
  }
  return any;
}

/**
 * Freezes the tree (SIGSTOP), as the SPEC's pause of a job does.
 * @param {number} rootPid
 * @param {readonly number[]} [knownPids]
 * @returns {Promise<boolean>}
 */
export function suspend(rootPid, knownPids = []) {
  return signalAll(rootPid, "SIGSTOP", knownPids);
}

/**
 * Continues a frozen tree (SIGCONT).
 * @param {number} rootPid
 * @param {readonly number[]} [knownPids]
 * @returns {Promise<boolean>}
 */
export function resume(rootPid, knownPids = []) {
  return signalAll(rootPid, "SIGCONT", knownPids);
}

/**
 * Seconds of CPU time from the formats of `ps`: `1:02.34` (macOS, minutes), `01:02:03`,
 * `1-02:03:04` (days), `45` (seconds). `null` when the text is none of them.
 * @param {string} text
 * @returns {number | null}
 */
export function parseCpuTime(text) {
  const m = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(text.trim());
  if (m === null) return null;
  const days = m[1] === undefined ? 0 : Number(m[1]);
  const parts = /** @type {string} */ (m[2]).split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return days * 86_400 + seconds;
}

/**
 * Parses `ps -o pid=,time=` into CPU seconds by pid.
 * @param {string} text
 * @returns {Map<number, number>}
 */
export function parseCpuTable(text) {
  /** @type {Map<number, number>} */
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (m === null) continue;
    const seconds = parseCpuTime(/** @type {string} */ (m[2]));
    if (seconds !== null) out.set(Number(m[1]), seconds);
  }
  return out;
}

/**
 * CPU seconds used so far by each of `pids` (processes that are gone are missing).
 * @param {readonly number[]} pids
 * @returns {Promise<Map<number, number>>}
 */
export async function cpuByPid(pids) {
  if (pids.length === 0) return new Map();
  const out = await runTool("ps", ["-o", "pid=,time=", "-p", pids.join(",")]);
  return out === null ? new Map() : parseCpuTable(out.stdout);
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
