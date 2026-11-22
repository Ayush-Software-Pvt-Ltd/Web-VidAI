import { describe, expect, it } from "vitest";
import type { JobKind, JobState, JobView } from "@/lib/types";
import { videoStatus } from "@/lib/status";
import { jobKindTag, modelAndEffort, stopConsequence } from "./describe";

function video(kind: JobKind, state: JobState, edited = false, finalRendered = false) {
  return { job: { kind, state } as JobView, edited, finalRendered };
}

describe("jobKindTag", () => {
  it("is left out when the status already names the job or describes the video", () => {
    expect(jobKindTag({ job: null, edited: false, finalRendered: false })).toBeNull();
    for (const kind of ["edit", "reEdit", "timelineEdit", "render"] as const) {
      expect(jobKindTag(video(kind, "running", kind !== "edit"))).toBeNull();
    }
    expect(jobKindTag(video("edit", "completed", true))).toBeNull();
    expect(jobKindTag(video("reEdit", "completed", true))).toBeNull();
    expect(jobKindTag(video("render", "completed", true, true))).toBeNull();
  });

  it("names the job when the status does not", () => {
    expect(jobKindTag(video("edit", "queued"))).toBe("Edit");
    expect(jobKindTag(video("reEdit", "paused", true))).toBe("Re-Edit");
    expect(jobKindTag(video("reEdit", "pausing", true))).toBe("Re-Edit");
    expect(jobKindTag(video("render", "failed", true))).toBe("Final render");
    expect(jobKindTag(video("edit", "stopping"))).toBe("Edit");
    expect(jobKindTag(video("edit", "stopped"))).toBe("Edit");
    expect(jobKindTag(video("timelineEdit", "queued", true))).toBe("Change requests");
  });

  it("says that a job was stopped when the status shows the video's result", () => {
    const reEdit = video("reEdit", "stopped", true);
    expect(videoStatus(reEdit).label).toBe("Edited");
    expect(jobKindTag(reEdit)).toBe("Re-Edit stopped");
    const render = video("render", "stopped", true, false);
    expect(jobKindTag(render)).toBe("Final render stopped");
  });
});

describe("modelAndEffort", () => {
  it("names the model as people read it and the effort when there is one", () => {
    expect(modelAndEffort("Opus 5.5", "high")).toBe("Opus 5.5, High effort");
    expect(modelAndEffort("GLM-5.3", null)).toBe("GLM-5.3");
    expect(modelAndEffort(null, null)).toBe("Default model");
    expect(modelAndEffort(null, "xhigh")).toBe("Default model, Extra high effort");
  });
});

describe("stopConsequence", () => {
  const sentence = (kind: JobKind, state: JobState, edited = false) =>
    stopConsequence({ kind, state }, edited);

  it("says nothing for a job that has not started", () => {
    expect(sentence("edit", "queued")).toBe("");
  });

  it("keeps the files of a first edit", () => {
    expect(sentence("edit", "running")).toMatch(/files are kept, and Start Editing later begins/);
  });

  it("puts the project back after a stopped Re-Edit and a stopped change request", () => {
    expect(sentence("reEdit", "running", true)).toMatch(/put back as it was before this Re-Edit/);
    expect(sentence("timelineEdit", "running", true)).toMatch(
      /put back as it was.*change requests are marked as failed/,
    );
  });

  it("keeps nothing of a render and starts again at the first frame", () => {
    expect(sentence("render", "running", true)).toMatch(/starts at the first frame/);
  });
});
