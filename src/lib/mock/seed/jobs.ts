/**
 * The jobs seed: ended jobs (completed, failed, stopped) for the seeded videos, and `addJob`, the
 * helper the scenarios and tests use to put a job in any state into a world (with the log and
 * progress a run in that state would have).
 */
import type { JobKind, JobState, JobView } from "../../types";
import { makeVideoId } from "../../videoId";
import { queueOfKind } from "../queue";
import { DONE_PROGRESS, progressAfter, scriptFor, stepDetail } from "../scripts";
import { nextId, type MockJob, type World } from "../world";
import { ADMIN_ID } from "./session";
import { ADMIN_CHANNEL_BEAUTY, ADMIN_CHANNEL_TECH } from "./workspace";

export interface JobSpec {
  channelId: string;
  folderName: string;
  userId: string;
  kind?: JobKind;
  state: JobState;
  /** Script steps done; default depends on the state. */
  steps?: number;
  urgent?: boolean;
  /** Minutes ago the job joined the queue. */
  joinedMinutesAgo?: number;
  error?: string | null;
  resume?: boolean;
}

const DEFAULT_STEPS: Record<JobState, number> = {
  queued: 0,
  running: 6,
  pausing: 6,
  paused: 6,
  stopping: 6,
  stopped: 5,
  failed: 3,
  completed: 100,
};

/** Adds a job in `state` to the world and returns it. */
export function addJob(world: World, spec: JobSpec, now: number): MockJob {
  const kind = spec.kind ?? "edit";
  const script = scriptFor(kind);
  const steps = Math.min(spec.steps ?? DEFAULT_STEPS[spec.state], script.length);
  const videoId = makeVideoId(spec.channelId, spec.folderName);
  const channel = world.channels.find((c) => c.id === spec.channelId);
  const joinedAt = now - (spec.joinedMinutesAgo ?? 30) * 60_000;
  const active = !["queued", "stopped", "failed", "completed"].includes(spec.state);
  const ended = ["stopped", "failed", "completed"].includes(spec.state);
  const started = spec.state !== "queued" || spec.resume === true;
  const { setup, program, claude } = world.harness;
  const view: JobView = {
    id: nextId(world, "job"),
    videoId,
    userId: spec.userId,
    kind,
    queue: queueOfKind(kind),
    state: spec.state,
    urgent: spec.urgent ?? false,
    position: null,
    joinedAt,
    startedAt: started ? joinedAt + 20_000 : null,
    endedAt: ended ? now - 5 * 60_000 : null,
    activeMs: started ? Math.max(0, steps * 20_000) : 0,
    runningSince: spec.state === "running" || spec.state === "stopping" ? now - 15_000 : null,
    startsAt: null,
    lastActivity: null,
    error:
      spec.state === "failed" ? (spec.error ?? "The editing program stopped with an error.") : null,
    progress: spec.state === "completed" ? { ...DONE_PROGRESS } : progressAfter(kind, steps),
    videoType: "long",
    setup,
    harness: program,
    model: claude.model,
    effort: claude.effort,
    costUsd: steps > 0 ? Math.round(steps * 4 + (spec.state === "completed" ? 40 : 0)) / 100 : null,
  };
  if (active || spec.state === "stopping") {
    view.lastActivity =
      script.slice(0, steps).findLast((s) => s.activity !== undefined)?.activity ?? null;
  }
  const paths = {
    channelDir: channel?.dir ?? "",
    videoDir: `${channel?.dir ?? ""}/${spec.folderName}`,
  };
  const entries = script.slice(0, steps).map((step, index) => ({
    seq: index + 1,
    ts: new Date(joinedAt + 20_000 + index * 20_000).toISOString(),
    kind: step.kind,
    text: step.text,
    detail: stepDetail(step, paths),
    nested: step.nested ?? false,
  }));
  world.jobLogs[view.id] = entries;
  const job: MockJob = {
    view,
    request: {},
    sim: {
      step: steps,
      carry: 0,
      resume: spec.resume ?? false,
      startNow: false,
      failAt: null,
      failMessage: null,
      seq: entries.length + 1,
    },
  };
  world.jobs.push(job);
  if (started && view.queue === "edits" && spec.resume !== true && spec.state !== "completed") {
    (world.launches["edits"] ??= []).push(view.startedAt ?? joinedAt);
  }
  return job;
}

export function seedJobs(world: World, now: number): void {
  const done = (
    channelId: string,
    folderName: string,
    state: JobState,
    extra: Partial<JobSpec> = {},
  ) =>
    addJob(
      world,
      { channelId, folderName, userId: ADMIN_ID, state, joinedMinutesAgo: 60 * 24 * 2, ...extra },
      now,
    );
  done(ADMIN_CHANNEL_BEAUTY, "Serum Launch", "completed");
  done(ADMIN_CHANNEL_BEAUTY, "Lip Balm Haul", "completed");
  done(ADMIN_CHANNEL_BEAUTY, "Lip Balm Haul", "completed", { kind: "render", steps: 100 });
  done(ADMIN_CHANNEL_BEAUTY, "Foundation Test", "failed", {
    error: "The editing program ran out of credit. Add credit, then continue.",
  });
  done(ADMIN_CHANNEL_BEAUTY, "Mascara Quick Look", "stopped");
  done(ADMIN_CHANNEL_BEAUTY, "Old Reel", "completed");
  done(ADMIN_CHANNEL_TECH, "Laptop Teardown", "completed");
  // Seeded history must not hold back the start delay of the next edit.
  world.launches["edits"] = [];
}
