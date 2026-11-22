// Evidence of work (docs/SPEC-desktop.md section 6, "Keeping a job going" and "Progress").
//
// Two kinds, each in its own file; this one is the entry point for both:
// - `workBusy.js`: whether the model's own commands keep the computer busy (the "busy workers"
//   of `keepgoing.js`), from the CPU time of the job's process tree.
// - `workFiles.js`: which kinds of files appeared in the video folder since the job started.

export {
  BUSY_CPU_SHARE,
  BUSY_HOLD_MS,
  REFRESH_MS,
  WAIT_MESSAGE_EVERY_MS,
  createWorkerWatch,
} from "./workBusy.js";
export { componentsInWork, evidence, kindsOf, kindsOfPath, scan, isPlanName } from "./workFiles.js";
