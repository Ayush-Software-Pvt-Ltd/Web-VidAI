// Making one preview copy (docs/SPEC.md section 11, Preview copies; section 9, CPU budget and GPU
// slots: a preview-copy job is a heavy job of kind `proxy`, limited from its first process).
//
// The copy uses the hardware encoder when the machine has one and a GPU slot can be had at once
// (a short wait, never holding up the queue), else `libx264 -preset veryfast`; a failing hardware
// encode is tried once more in software. The process is counted by the limits module, recorded in
// the process registry (a crashed server ends it at the next start) and always ended on abort.
import fsp from "node:fs/promises";
import { realTimers } from "../limits/timers.js";
import { endTree, spawnAgent } from "../platform/process.js";
import { SOFTWARE_ENCODER } from "../platform/encoders.js";
import { copyArgs } from "./proxyArgs.js";
import { copyFile, partFile } from "./proxyName.js";

/** How long a GPU slot is waited for before the copy uses the CPU instead. */
const GPU_WAIT_MS = 100;
/** The part of ffmpeg's messages that is kept for the log. */
const STDERR_BYTES = 4000;

/**
 * @typedef {object} RunningCopy
 * @property {number} pid
 * @property {Promise<{ code: number | null, stderr: string }>} done
 * @property {() => Promise<unknown>} stop Ends the process and its tree.
 *
 * @typedef {(options: { command: string, args: readonly string[] }) => RunningCopy} StartCopy
 */

/**
 * Starts ffmpeg for real.
 * @type {StartCopy}
 */
export function startFfmpeg({ command, args }) {
  const child = spawnAgent({ command, args });
  child.stdin.end();
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_BYTES);
  });
  child.stderr.on("error", () => {});
  const pid = /** @type {number} */ (child.pid);
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {number | null} */ code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr });
    };
    child.once("error", () => finish(null));
    child.once("exit", (code) => {
      // Output may still be in flight; do not wait for pipes a grandchild keeps open.
      const wait = setTimeout(() => finish(code), 500);
      child.once("close", () => {
        clearTimeout(wait);
        finish(code);
      });
    });
  });
  return { pid, done, stop: () => endTree(pid, { graceMs: 2000 }) };
}

/**
 * @typedef {object} MakerDeps
 * @property {ReturnType<typeof import("./proxyStore.js").createCopyStore>} store
 * @property {Pick<ReturnType<typeof import("../limits/index.js").createLimitsModule>["api"], "envFor" | "jobStarted" | "jobEnded" | "acquireGpuSlot">} limits
 * @property {{ add(entry: { jobId: string, pid: number }): Promise<void>, remove(pid: number): Promise<void> }} registry
 * @property {() => string | null} ffmpeg
 * @property {{ h264(): Promise<import("../platform/encoders.js").EncoderChoice | null>, toneMapping(): Promise<boolean> }} encoders
 * @property {StartCopy} [run]
 * @property {import("../limits/timers.js").Timers} [timers]
 * @property {number} [gpuWaitMs]
 * @property {import("../log.js").Logger} log
 */

/**
 * @param {MakerDeps} deps
 * @returns {(item: { name: string, realPath: string, facts: import("./proxyProbe.js").MediaFacts }, signal: AbortSignal) => Promise<import("./proxyQueue.js").Outcome>}
 */
export function createCopyMaker(deps) {
  const { store, limits, registry, log } = deps;
  const run = deps.run ?? startFfmpeg;
  const timers = deps.timers ?? realTimers;
  const gpuWaitMs = deps.gpuWaitMs ?? GPU_WAIT_MS;

  /**
   * A GPU slot if one is free now or within a moment.
   * @param {string} jobKey
   * @param {AbortSignal} signal
   * @returns {Promise<import("../limits/gpuSlots.js").HeldSlot | null>}
   */
  async function slotNow(jobKey, signal) {
    const wait = new AbortController();
    const timer = timers.setTimeout(() => wait.abort(), gpuWaitMs);
    const onAbort = () => wait.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await limits.acquireGpuSlot(jobKey, wait.signal);
    } catch {
      return null;
    } finally {
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * One ffmpeg run to its end.
   * @param {string} jobKey
   * @param {StartCopy} start
   * @param {{ command: string, args: string[] }} options
   * @param {AbortSignal} signal
   * @returns {Promise<{ code: number | null, stderr: string }>}
   */
  async function runOnce(jobKey, start, options, signal) {
    const child = start(options);
    const onAbort = () => void child.stop().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await registry.add({ jobId: jobKey, pid: child.pid });
      limits.jobStarted(jobKey, { rootPid: child.pid, kind: "proxy" });
      if (signal.aborted) onAbort();
      return await child.done;
    } finally {
      signal.removeEventListener("abort", onAbort);
      limits.jobEnded(jobKey);
      await registry.remove(child.pid).catch(() => {});
    }
  }

  return async function make(item, signal) {
    const command = deps.ffmpeg();
    if (command === null) {
      log.warn("preview copies: ffmpeg was not found, so no preview copy is made");
      return "failed";
    }
    const jobKey = `proxy-${item.name.slice(0, 16)}`;
    const part = partFile(store.dir, item.name);
    const hardware = await deps.encoders.h264();
    const toneMapping = await deps.encoders.toneMapping();
    const threads = Number(limits.envFor(jobKey).VE_CPU_CORES) || 1;
    const attempts = hardware ? [hardware, SOFTWARE_ENCODER] : [SOFTWARE_ENCODER];
    try {
      for (const encoder of attempts) {
        if (signal.aborted) return "cancelled";
        const slot = encoder.backend === "software" ? null : await slotNow(jobKey, signal);
        // No slot at once: this file goes through the CPU.
        if (encoder.backend !== "software" && slot === null) continue;
        try {
          await fsp.rm(part, { force: true });
          const args = copyArgs({
            input: item.realPath,
            output: part,
            facts: item.facts,
            encoder,
            threads,
            toneMapping,
          });
          const result = await runOnce(jobKey, run, { command, args }, signal);
          if (signal.aborted) return "cancelled";
          const size = result.code === 0 ? await fileSize(part) : 0;
          if (size > 0) {
            await fsp.rename(part, copyFile(store.dir, item.name));
            store.markReady(item.name);
            return "made";
          }
          log.warn(
            `preview copies: ${item.realPath}: ${encoder.name} ended with code ${result.code}: ${result.stderr.trim()}`,
          );
        } catch (error) {
          log.warn(`preview copies: ${item.realPath} could not be copied`, error);
        } finally {
          slot?.release();
        }
      }
      return signal.aborted ? "cancelled" : "failed";
    } finally {
      await fsp.rm(part, { force: true }).catch(() => {});
    }
  };
}

/** @param {string} file @returns {Promise<number>} 0 when it does not exist. */
async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}
