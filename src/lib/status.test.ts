import { describe, expect, it } from "vitest";
import {
  ACTION_LABELS,
  CHANNEL_TYPE_LABELS,
  jobStatus,
  progressView,
  queueNote,
  statusRank,
  videoStatus,
  videoTypeLabel,
  waitsForUserLimit,
} from "./status";
import type { JobKind, JobState, JobView, VideoAction } from "./types";

const job = (
  state: JobState,
  progress: JobView["progress"] = null,
  endedAt: number | null = null,
  extra: Partial<JobView> = {},
): JobView => ({ kind: "edit", queue: "edits", state, progress, endedAt, ...extra }) as JobView;
const video = (j: JobView | null, edited = false, finalRendered = false) => ({
  job: j,
  edited,
  finalRendered,
});
const p = { percent: 46, stage: "Building graphics", secondsLeft: null };

describe("jobStatus", () => {
  it.each<[JobState, JobKind, string, string, string, boolean]>([
    ["queued", "edit", "Queued", "info", "clock", false],
    ["running", "edit", "Editing", "accent", "spinner", true],
    ["running", "reEdit", "Re-editing", "accent", "spinner", true],
    ["running", "timelineEdit", "Applying changes", "accent", "spinner", true],
    ["running", "render", "Rendering", "accent", "spinner", true],
    ["pausing", "edit", "Pausing", "warning", "spinner", true],
    ["paused", "reEdit", "Paused", "warning", "pause", false],
    ["stopping", "edit", "Stopping", "neutral", "spinner", true],
    ["stopped", "edit", "Stopped", "neutral", "stop", false],
    ["failed", "render", "Needs attention", "danger", "alert", false],
    ["completed", "edit", "Done", "success", "check", false],
  ])("%s %s reads %s", (state, kind, label, tone, icon, live) => {
    expect(jobStatus({ state, kind })).toEqual({ label, tone, icon, live });
  });
});

describe("videoStatus", () => {
  it("uses the spec wording without a job", () => {
    expect(videoStatus(video(null)).label).toBe("Not edited");
    expect(videoStatus(video(null, true)).label).toBe("Edited");
    expect(videoStatus(video(null, true, true))).toEqual({
      label: "Final rendered",
      tone: "success",
      icon: "check",
      live: false,
    });
  });
  it("lets an active or failed job outrank the output it left behind", () => {
    expect(videoStatus(video(job("running"), true, true)).label).toBe("Editing");
    expect(videoStatus(video(job("running", null, null, { kind: "render" }), true)).label).toBe(
      "Rendering",
    );
    expect(videoStatus(video(job("queued"), true)).label).toBe("Queued");
    expect(videoStatus(video(job("paused"), true)).label).toBe("Paused");
    expect(videoStatus(video(job("failed"), true)).label).toBe("Needs attention");
  });
  it("shows Stopped only while nothing was edited, and ignores a completed job", () => {
    expect(videoStatus(video(job("stopped"))).label).toBe("Stopped");
    expect(videoStatus(video(job("stopped"), true)).label).toBe("Edited");
    expect(videoStatus(video(job("completed"), true)).label).toBe("Edited");
    expect(videoStatus(video(job("completed"))).label).toBe("Not edited");
  });
});

describe("queueNote", () => {
  const now = 1_000_000;
  const waiting = (extra: Partial<JobView> = {}) =>
    job("queued", null, null, { position: 3, urgent: false, startsAt: null, ...extra });

  it("is only for waiting jobs", () => {
    expect(queueNote(job("running"))).toBeNull();
    expect(queueNote(job("paused"))).toBeNull();
  });
  it("says the position the server gave", () => {
    expect(queueNote(waiting())).toEqual({
      text: "Waiting, position 3",
      detail: null,
      urgent: false,
      waitingForLimit: false,
    });
    expect(queueNote(waiting({ position: null }))?.text).toBe("Waiting");
    expect(queueNote(waiting({ position: 1 }))?.text).toBe("Waiting, position 1");
  });
  it("carries Urgent", () => {
    expect(queueNote(waiting({ urgent: true }))?.urgent).toBe(true);
  });
  it("shows the start delay's countdown", () => {
    expect(queueNote(waiting({ startsAt: now + 6 * 60_000 }), { now })?.detail).toBe(
      "Starts in 6 min",
    );
    // The countdown is over: nothing to say any more.
    expect(queueNote(waiting({ startsAt: now - 1 }), { now })?.detail).toBeNull();
  });
  it("explains the per-user limit and says Earliest start with a countdown", () => {
    const limited = { ownRunningEdits: 2, maxEditsPerUser: 2, now };
    const note = queueNote(waiting(), limited);
    expect(note?.waitingForLimit).toBe(true);
    expect(note?.detail).toBe(
      "You can edit 2 videos at a time. This one starts when another is done.",
    );
    expect(
      queueNote(waiting(), { ...limited, maxEditsPerUser: 1, ownRunningEdits: 1 })?.detail,
    ).toMatch(/1 video at a time/);
    expect(queueNote(waiting({ startsAt: now + 90_000 }), limited)?.detail).toBe(
      "Earliest start in 2 min",
    );
  });
  it("applies the per-user limit only to edits below the limit's count", () => {
    const ctx = { ownRunningEdits: 1, maxEditsPerUser: 2 };
    expect(waitsForUserLimit(waiting(), ctx)).toBe(false);
    expect(waitsForUserLimit(waiting(), { ownRunningEdits: 2, maxEditsPerUser: 0 })).toBe(false);
    expect(
      waitsForUserLimit(waiting({ queue: "renders" }), { ownRunningEdits: 5, maxEditsPerUser: 1 }),
    ).toBe(false);
    expect(waitsForUserLimit(job("running"), { ownRunningEdits: 5, maxEditsPerUser: 1 })).toBe(
      false,
    );
  });
});

describe("progressView", () => {
  it("has no bar without a job, nor for finished jobs that never reported progress", () => {
    expect(progressView(video(null))).toBeNull();
    expect(progressView(video(job("stopped", null)))).toBeNull();
    expect(progressView(video(job("failed", null)))).toBeNull();
    expect(progressView(video(job("completed", null)))).toBeNull();
  });

  it("colours the bar by state", () => {
    expect(progressView(video(job("running", p)))).toMatchObject({ percent: 46, tone: "accent" });
    expect(progressView(video(job("running", null)))).toMatchObject({
      percent: null,
      tone: "accent",
    });
    expect(progressView(video(job("queued", null)))).toMatchObject({
      percent: null,
      tone: "muted",
    });
    for (const state of ["pausing", "paused", "stopping", "stopped"] as const) {
      expect(progressView(video(job(state, p)))?.tone).toBe("muted");
    }
    expect(progressView(video(job("failed", p)))?.tone).toBe("danger");
    expect(progressView(video(job("completed", null, 1_700_000_000_000)))).toEqual({
      percent: 100,
      stage: null,
      tone: "success",
      doneAt: 1_700_000_000_000,
    });
  });

  it("clamps the percent and hides a stopped bar once the row says Edited", () => {
    expect(
      progressView(video(job("running", { percent: 140, stage: null, secondsLeft: null })))
        ?.percent,
    ).toBe(100);
    expect(progressView(video(job("stopped", p), true))).toBeNull();
  });
});

describe("statusRank", () => {
  const rank = (
    state: JobState | null,
    extra: Partial<JobView> = {},
    edited = false,
    finalRendered = false,
  ) => statusRank({ job: state ? job(state, null, null, extra) : null, edited, finalRendered });

  it("orders attention, not edited, editing, edited, rendering, final rendered", () => {
    expect(rank("failed", {}, true, true)).toBe(0);
    expect(rank(null)).toBe(1);
    expect(rank("stopped")).toBe(1);
    expect(rank("completed")).toBe(1);
    for (const state of ["queued", "running", "pausing", "paused", "stopping"] as const) {
      expect(rank(state, {}, true, true)).toBe(2);
    }
    expect(rank("running", { kind: "reEdit" })).toBe(2);
    expect(rank("running", { kind: "timelineEdit" })).toBe(2);
    expect(rank(null, {}, true)).toBe(3);
    expect(rank("completed", {}, true)).toBe(3);
    expect(rank("running", { kind: "render" }, true)).toBe(4);
    expect(rank(null, {}, true, true)).toBe(5);
  });
});

describe("labels", () => {
  it("has a button label for every action the server can offer", () => {
    const actions: VideoAction[] = [
      "startEdit",
      "pause",
      "continue",
      "stop",
      "reEdit",
      "review",
      "renderFinal",
      "upload",
      "diskCleanup",
      "archive",
      "unarchive",
      "startNow",
    ];
    for (const action of actions) expect(ACTION_LABELS[action]).not.toBe("");
    expect(ACTION_LABELS.startEdit).toBe("Start Editing");
    expect(Object.keys(ACTION_LABELS).sort()).toEqual([...actions].sort());
  });
  it("words video types", () => {
    expect(videoTypeLabel("long")).toBe("Long 16:9");
    expect(videoTypeLabel("short")).toBe("Short 9:16");
    expect(CHANNEL_TYPE_LABELS).toEqual({
      auto: "Auto-detect",
      long: "Always Long",
      short: "Always Short",
    });
  });
});
