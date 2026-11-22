// The data of the admin's System page (docs/SPEC.md section 5, "System page", and section 14,
// `adminGetSystem`): the server, the data directory, the toolkit and its Prepare steps, the
// programs found, the CPU and GPU limits and counts of users, channels and jobs. Everything that
// belongs to another module comes in as a function, so this file depends on none of them.

import fs from "node:fs";
import nodeOs from "node:os";

/** @typedef {import("../../src/lib/wire/system.ts").SystemView} SystemView */
/** @typedef {import("../../src/lib/wire/system.ts").ProgramInfo} ProgramInfo */
/** @typedef {import("../../src/lib/wire/system.ts").SystemCounts} SystemCounts */

/**
 * What a probe tells about one program; missing fields mean `null`.
 * @typedef {object} ProbeResult
 * @property {boolean} found
 * @property {string | null} [path]
 * @property {string | null} [version]
 * @property {string | null} [note]
 *
 * @typedef {() => Promise<ProbeResult> | ProbeResult} Probe
 */

/** The programs the page lists, in order, with their labels. */
export const PROGRAMS = /** @type {const} */ ([
  ["claude", "Claude Code"],
  ["opencode", "OpenCode 2"],
  ["ffmpeg", "ffmpeg"],
  ["ffprobe", "ffprobe"],
  ["python", "Python"],
  ["hyperframes", "HyperFrames"],
]);

/** The states of a job, all of which the counts list. */
const JOB_STATES = /** @type {const} */ ([
  "queued",
  "running",
  "pausing",
  "paused",
  "stopping",
  "stopped",
  "failed",
  "completed",
]);

/**
 * @typedef {object} SystemDeps
 * @property {import("./db/open.js").Database} db
 * @property {string} dataDir
 * @property {string} version The server's version.
 * @property {import("./db/open.js").Clock} clock
 * @property {() => string[]} [addresses] The addresses the server listens on (the app knows).
 * @property {Partial<Record<(typeof PROGRAMS)[number][0], Probe>>} [probes] A probe per program;
 *   a program without one is listed as "not checked".
 * @property {{ cpuState(): { processors: number, running: number, budget: number },
 *   gpuState(): { total: number, perJob: number, slots: import("../../src/lib/wire/system.ts").SystemGpuSlot[] } }} limits
 * @property {() => import("../../src/lib/wire/system.ts").SystemToolkit} toolkit
 * @property {() => import("../../src/lib/wire/system.ts").PrepareState} prepare
 * @property {number} [startedAt] When the server started (default: when this was created).
 * @property {number} [probeTimeoutMs] The longest a probe may take (default 15 seconds).
 * @property {(dir: string) => { bavail: number, bsize: number, blocks: number }} [statfs]
 * @property {{ platform(): string, release(): string, arch(): string, hostname(): string }} [os]
 */

/**
 * The operating system in words.
 * @param {string} platform
 * @param {string} release
 * @param {string} arch
 * @returns {string}
 */
export function describeOs(platform, release, arch) {
  const name = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform;
  return `${name} ${release} (${arch})`;
}

/**
 * Waits for a probe, but not longer than `ms`; a probe that throws or is too slow is reported as
 * a note, never as an error of the page.
 * @param {Probe} probe
 * @param {number} ms
 * @returns {Promise<ProbeResult>}
 */
async function runProbe(probe, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve("slow"), ms);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(probe), slow]);
    if (result === "slow") return { found: false, note: "This check took too long to answer." };
    return /** @type {ProbeResult} */ (result);
  } catch (error) {
    return {
      found: false,
      note: `This check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {SystemDeps} deps
 */
export function createSystem(deps) {
  const { db, dataDir, version, clock } = deps;
  const startedAt = deps.startedAt ?? clock.now();
  const probeTimeoutMs = deps.probeTimeoutMs ?? 15_000;
  const statfs = deps.statfs ?? ((/** @type {string} */ dir) => fs.statfsSync(dir));
  const os = deps.os ?? nodeOs;

  /** @returns {{ freeBytes: number | null, totalBytes: number | null }} */
  function disk() {
    try {
      const stat = statfs(dataDir);
      return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
    } catch {
      return { freeBytes: null, totalBytes: null };
    }
  }

  /** @returns {SystemCounts} */
  function counts() {
    const users = db.get(
      "SELECT COUNT(*) AS total, COALESCE(SUM(role = 'admin'), 0) AS admins, COALESCE(SUM(disabled), 0) AS disabled FROM users",
    );
    const channels = db.get("SELECT COUNT(*) AS n FROM channels");
    const rows = /** @type {{ state: string, n: number }[]} */ (
      db.all("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state")
    );
    const jobs = /** @type {SystemCounts["jobs"]} */ (
      Object.fromEntries(JOB_STATES.map((state) => [state, 0]))
    );
    for (const row of rows) {
      if (row.state in jobs) jobs[/** @type {keyof typeof jobs} */ (row.state)] = row.n;
    }
    const u = /** @type {{ total: number, admins: number, disabled: number }} */ (users);
    return {
      users: { total: u.total, admins: u.admins, disabled: u.disabled },
      channels: /** @type {{ n: number }} */ (channels).n,
      jobs,
    };
  }

  /** @returns {Promise<ProgramInfo[]>} */
  async function programs() {
    return Promise.all(
      PROGRAMS.map(async ([id, label]) => {
        const probe = deps.probes?.[id];
        if (!probe) {
          return { id, label, found: false, path: null, version: null, note: "Not checked." };
        }
        const result = await runProbe(probe, probeTimeoutMs);
        return {
          id,
          label,
          found: result.found,
          path: result.path ?? null,
          version: result.version ?? null,
          note: result.note ?? null,
        };
      }),
    );
  }

  return {
    /**
     * The whole System page.
     * @returns {Promise<SystemView>}
     */
    async view() {
      const list = await programs();
      const gpu = deps.limits.gpuState();
      return {
        server: {
          version,
          node: process.versions.node,
          os: describeOs(os.platform(), os.release(), os.arch()),
          hostname: os.hostname(),
          startedAt,
        },
        dataDir: { path: dataDir, ...disk() },
        addresses: deps.addresses?.() ?? [],
        toolkit: deps.toolkit(),
        prepare: deps.prepare(),
        programs: list,
        cpu: deps.limits.cpuState(),
        gpu: { total: gpu.total, perJob: gpu.perJob, slots: gpu.slots },
        counts: counts(),
      };
    },
  };
}
