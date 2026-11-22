// Start-up and shutdown of the job manager (docs/SPEC.md section 8, "Recovery"). Quit pauses every running agent job
// and stops renders; the next start makes whatever was still running paused (with a session) or
// stopped, and never goes on by itself.

import { bounded } from "./managerRuns.js";

/**
 * @param {import("./managerDeps.js").ManagerDeps} d
 * @param {ReturnType<typeof import("./managerOutcome.js").createOutcomes>} outcomes
 */
export function createRecovery(d, outcomes) {
  const { jobs, queues, limits, registry, runs } = d;

  async function start() {
    // Programs of a crashed server first: frozen ones continued, then every left process ended.
    limits.resumeLeftovers(registry.entries().map((e) => e.pid));
    await registry.endLeftovers();
    for (const { job } of queues.start()) {
      const now = jobs.get(job.id) ?? job;
      if (now.state !== "paused" && now.state !== "stopped") continue;
      if (now.state === "stopped") await outcomes.revertEdits(now);
      outcomes.logEnd(now, now.state, null);
      await outcomes.afterEnd(now, now.state, null);
    }
  }

  async function stop() {
    const active = runs.all();
    for (const run of active) {
      const job = jobs.get(run.jobId);
      if (!job) continue;
      if (job.kind === "render") {
        if (jobs.transition(job.id, ["running", "pausing"], "stopping")) run.stop();
      } else if (jobs.transition(job.id, ["running"], "pausing")) {
        limits.resumeAll(job.id);
        run.pause();
      }
    }
    await bounded(Promise.all(active.map((r) => r.settled)), d.shutdownMs, d.timers ?? globalThis);
    queues.stop();
  }

  return { start, stop };
}
