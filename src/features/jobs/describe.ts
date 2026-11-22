/** Human wording for models, effort, job kinds and slots. Presentation only. */
import { JOB_KIND_LABEL } from "@/lib/status";
import type { Channel, ChannelSlot, JobView, TypeSource, VideoView } from "@/lib/types";

const EFFORT_NAMES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortName(effort: string): string {
  return EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * The model and effort a new edit uses, for example "Opus 5.5, High effort": `modelName` is the
 * model as people read it (`HarnessPublicView.modelName`; `null` is the program's own default) and
 * `effort` the reasoning effort (`null` is the model's default).
 */
export function modelAndEffort(modelName: string | null, effort: string | null): string {
  const modelText = modelName ?? "Default model";
  return effort === null ? modelText : `${modelText}, ${effortName(effort)} effort`;
}

/**
 * The tag next to the status pill that says which kind of job the status is about, or `null`
 * when the pill already says it ("Editing", "Re-editing", "Applying changes" and "Rendering" name
 * the kind), and after
 * a finished job "Edited" or "Final rendered" describe the video. So "Paused" gets "Re-Edit",
 * "Needs attention" gets "Final render", and a re-edit stopped on an edited video reads
 * "Edited" + "Re-Edit stopped".
 */
export function jobKindTag(
  video: Pick<VideoView, "job" | "edited" | "finalRendered">,
): string | null {
  const job = video.job;
  if (!job) return null;
  const kind = JOB_KIND_LABEL[job.kind];
  switch (job.state) {
    case "running":
    case "completed":
      return null;
    case "stopped":
      // The pill shows the video's result ("Edited") unless nothing was edited yet ("Stopped").
      return video.edited || video.finalRendered ? `${kind} stopped` : kind;
    case "queued":
    case "pausing":
    case "paused":
    case "stopping":
    case "failed":
      return kind;
  }
}

const TYPE_SOURCE_NAMES: Record<TypeSource, string> = {
  override: "set by you",
  channel: "set by the channel",
  detected: "detected",
  assumed: "assumed, no readable A-roll",
};

/** Where the video type comes from, for example "detected" or "set by the channel". */
export function videoTypeSource(video: Pick<VideoView, "typeSource">): string {
  return TYPE_SOURCE_NAMES[video.typeSource];
}

/** The slots a video's Start Editing sheet offers: non-empty prompts; Default and non-empty styles. */
export function offeredSlots(slots: ChannelSlot[], kind: "prompt" | "style"): number[] {
  return slots.flatMap((s, i) =>
    s.text.trim() !== "" || (kind === "style" && i === 0) ? [i] : [],
  );
}

/** The channel's offered prompt and style slots for the video's type, and the selection to use. */
export function startSlots(
  channel: Channel | undefined,
  video: VideoView,
  wanted: { promptSlot: number; styleSlot: number },
) {
  const profile = channel?.[video.videoType];
  const prompts = offeredSlots(profile?.prompts ?? [], "prompt");
  const styles = offeredSlots(profile?.styles ?? [], "style");
  const pick = (offered: number[], slot: number) =>
    offered.includes(slot) ? slot : (offered[0] ?? 0);
  return {
    prompts,
    styles,
    promptSlot: pick(prompts, wanted.promptSlot),
    styleSlot: pick(styles, wanted.styleSlot),
  };
}

/**
 * What stopping this job leaves behind, in a sentence (SPEC section 8, "What a job keeps and puts
 * back"): a first edit keeps its files, a Re-Edit and change requests put the project back as it
 * was before, and a render keeps nothing and starts again at the first frame.
 */
export function stopConsequence(job: Pick<JobView, "kind" | "state">, edited: boolean): string {
  if (job.state === "queued") return "";
  switch (job.kind) {
    case "edit":
      return edited
        ? "The working files are kept."
        : "The working files are kept, and Start Editing later begins a new session.";
    case "reEdit":
      return "The project is put back as it was before this Re-Edit.";
    case "timelineEdit":
      return "The project is put back as it was, and the change requests are marked as failed.";
    case "render":
      return "Nothing of this render is kept, and rendering again starts at the first frame.";
  }
}
