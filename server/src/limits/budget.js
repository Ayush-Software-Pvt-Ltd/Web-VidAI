// The arithmetic of docs/SPEC.md section 9 (resource limits) and the worker rule of section 12.
// Pure: no clock, no files, no processes.

/** GPU tasks that run at once at 100 percent (SPEC section 9, GPU). */
export const GPU_SLOTS_AT_FULL = 8;

/** The most renderer workers (SPEC section 12). */
export const MAX_RENDER_WORKERS = 8;

/** The most renderer workers for a 2160 render (SPEC section 12: same time, less memory). */
export const MAX_RENDER_WORKERS_2160 = 4;

/** The fewest budget at which more than one render worker pays off (SPEC section 12). */
export const MIN_BUDGET_FOR_WORKERS = 4;

/**
 * Whole processors for a percentage of `processors`, never less than 1:
 * `max(1, floor(N * percent / 100))`. A tiny epsilon keeps products like 3 * 70 / 100 from
 * landing just under a whole number.
 * @param {number} processors
 * @param {number} percent
 * @returns {number}
 */
function share(processors, percent) {
  return Math.max(1, Math.floor((processors * percent) / 100 + 1e-9));
}

/**
 * @typedef {object} CpuBudgetInput
 * @property {number} processors `N`, the logical processors of this computer.
 * @property {number} perEditPercent `cpuPerEditPercent`, 5 to 100.
 * @property {number} totalPercent `cpuTotalPercent`, 5 to 100.
 * @property {number} running `R`, the heavy jobs running (agent jobs, renders, preview copies).
 */

/**
 * The processors one of `running` heavy jobs may use (SPEC section 9, CPU):
 * `perEdit = max(1, floor(N * cpuPerEditPercent / 100))`,
 * `total = max(1, floor(N * cpuTotalPercent / 100))`, budget `min(perEdit, total / R)`.
 * With no job running the answer is the budget a first job would get (`R` counts as 1), so
 * the environment of a job about to start can be computed before it is counted.
 * @param {CpuBudgetInput} input
 * @returns {number} May be fractional (for example 2.5 processors).
 */
export function cpuBudget({ processors, perEditPercent, totalPercent, running }) {
  const perEdit = share(processors, perEditPercent);
  const total = share(processors, totalPercent);
  return Math.min(perEdit, total / Math.max(1, running));
}

/**
 * `VE_CPU_CORES`: the budget rounded up, at least 1 (SPEC section 9, CPU, way 1).
 * @param {number} budget
 * @returns {number}
 */
export function cpuCoresEnv(budget) {
  // The epsilon keeps 2.0000000000000004 (a division that did not come out even) at 2.
  return Math.max(1, Math.ceil(budget - 1e-9));
}

/**
 * `hyperframes render --workers`: the budget when it is 4 or more (at most 8), otherwise 1
 * (SPEC section 12: one worker uses the faster capture path, two are slower than one).
 * A fractional budget of 4 or more counts its whole processors only.
 * @param {number} budget
 * @returns {number}
 */
export function renderWorkers(budget) {
  if (budget < MIN_BUDGET_FOR_WORKERS - 1e-9) return 1;
  return Math.min(MAX_RENDER_WORKERS, Math.floor(budget + 1e-9));
}

/**
 * The workers a render of this resolution may use: the budget's `workers` (from
 * `renderWorkers`), at most 4 at 2160 (SPEC section 12). The cap is a ceiling on top of the
 * CPU limits, never a raise, and 1 stays 1.
 * @param {number} workers
 * @param {1080 | 2160} resolution
 * @returns {number}
 */
export function renderWorkersAt(workers, resolution) {
  return resolution === 2160 ? Math.min(workers, MAX_RENDER_WORKERS_2160) : workers;
}

/**
 * @typedef {object} GpuSlotLimits The content of `limits.json` (SPEC section 9, GPU).
 * @property {number} total How many GPU tasks may run at once on the server.
 * @property {number} perJob How many of them one job may hold.
 */

/**
 * `gpuSlotsTotal = max(1, round(8 * gpuTotalPercent / 100))` and
 * `gpuSlotsPerEdit = min(gpuSlotsTotal, max(1, round(8 * gpuPerEditPercent / 100)))`.
 * @param {{ perEditPercent: number, totalPercent: number }} input
 * @returns {GpuSlotLimits}
 */
export function gpuSlots({ perEditPercent, totalPercent }) {
  const total = Math.max(1, Math.round((GPU_SLOTS_AT_FULL * totalPercent) / 100));
  const perEdit = Math.max(1, Math.round((GPU_SLOTS_AT_FULL * perEditPercent) / 100));
  return { total, perJob: Math.min(total, perEdit) };
}
