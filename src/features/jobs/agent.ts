/**
 * What the sheets and rows call the program and model of a job. Only display: the server decides
 * which program runs (`JobView.setup`, `harness`, `model`, `effort`) and whether edits can start.
 */
import { programName } from "@/lib/readiness";
import { SETUP_INFO } from "@/lib/setup";
import type { HarnessProgram, JobView } from "@/lib/types";

/**
 * What a sheet calls the program that does the editing: "Claude" for Claude Code (on the
 * subscription and on an Anthropic compatible API alike: it is Claude Code that works) and
 * "OpenCode 2" for the OpenCode 2 program.
 */
export function agentName(program: HarnessProgram | null | undefined): string {
  return program === "opencode2" ? programName(program) : "Claude";
}

/** The program a video's latest job ran in (Claude Code when it has no job). */
export function jobAgent(job: JobView | null): string {
  return agentName(job?.harness ?? "claudeCode");
}

/** "Claude Code" or "OpenCode 2": the program as a running thing. */
export function jobProgram(job: JobView | null): string {
  return programName(job?.harness ?? "claudeCode");
}

/**
 * Where a job's model comes from, for example "Claude Subscription" or "OpenCode Go", or `null`
 * for a job without a setup. The model itself is `JobView.model`.
 */
export function jobService(job: Pick<JobView, "setup">): string | null {
  return job.setup === null ? null : SETUP_INFO[job.setup].service;
}
