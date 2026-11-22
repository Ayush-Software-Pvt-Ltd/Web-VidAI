/**
 * Presentation helpers of the main window: labels for effort levels, usage limits and video
 * types, and the second line of a video row. Pure functions, unit tested.
 */
import { formatTimeAgo } from "@/lib/format";
import { CHANNEL_TYPE_LABELS, videoStatus, videoTypeLabel, type VideoStatus } from "@/lib/status";
import type { TypeSource, UsageLimit, VideoType, VideoView } from "@/lib/types";
import { hasActiveJob } from "./model";

const EFFORT_NAMES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(level: string): string {
  return EFFORT_NAMES[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

/** "5h", "Week", or the scope of a model-scoped limit ("Opus"). */
export function usageShortLabel(limit: UsageLimit): string {
  if (limit.key === "fiveHour") return "5h";
  if (limit.key === "weekly") return "Week";
  if (limit.key === "monthly") return "Month";
  const scoped = /\(([^)]+)\)/.exec(limit.label)?.[1];
  return scoped ?? limit.label;
}

/** What a video's type is on Auto (without an override), and why. */
export interface AutoType {
  type: VideoType;
  source: Exclude<TypeSource, "override">;
}

/**
 * The type Auto resolves to: the channel's setting when it is not Auto-detect, else the detected
 * type, else an assumed Long. The same order as the backend's resolution, minus the override.
 */
export function autoType(video: Pick<VideoView, "channelType" | "detectedType">): AutoType {
  if (video.channelType !== "auto") return { type: video.channelType, source: "channel" };
  if (video.detectedType !== null) return { type: video.detectedType, source: "detected" };
  return { type: "long", source: "assumed" };
}

export interface TypeInfo {
  /** The override to show (pending choice first). */
  override: VideoType | null;
  /** The type the badge shows. */
  type: VideoType;
  /** Where `type` comes from. */
  source: TypeSource;
  /** What Auto resolves to, for the Auto item of the menu. */
  auto: AutoType;
  /** One or two sentences for the tooltip and the accessible name. */
  note: string;
}

type TypeInfoVideo = Pick<
  VideoView,
  "detectedType" | "typeOverride" | "channelType" | "videoType" | "typeSource"
>;

/** How the detected type relates to `type`, for example "Detected as Long 16:9." */
function detectedNote(video: TypeInfoVideo, type: VideoType, unreadable: string): string {
  const detected = video.detectedType;
  if (detected === null) return unreadable;
  if (detected === type) return "Matches the detected type.";
  return `Detected as ${videoTypeLabel(detected)}.`;
}

function typeNote(video: TypeInfoVideo, type: VideoType, source: TypeSource, auto: AutoType) {
  switch (source) {
    case "override":
      return auto.source === "channel"
        ? `Set by you. The channel is set to ${CHANNEL_TYPE_LABELS[video.channelType]}.`
        : `Set by you. ${detectedNote(video, type, "No A-roll could be read to detect it.")}`;
    case "channel":
      return `Set by the channel: ${CHANNEL_TYPE_LABELS[video.channelType]}. ${detectedNote(video, type, "No A-roll could be read.")}`;
    case "detected":
      return "Detected from the A-roll.";
    case "assumed":
      return "Assumed. No readable A-roll was found, so pick the type if this is wrong.";
  }
}

/**
 * The type badge of a video. Without a pending choice it shows what the backend resolved; a
 * pending choice (the user just picked one in the menu) is shown at once: a type is an override,
 * `null` (Auto) is what Auto resolves to.
 */
export function typeInfo(video: TypeInfoVideo, pending?: VideoType | null): TypeInfo {
  const auto = autoType(video);
  let override: VideoType | null;
  let type: VideoType;
  let source: TypeSource;
  if (pending === undefined) {
    override = video.typeOverride;
    type = video.videoType;
    source = video.typeSource;
  } else if (pending === null) {
    override = null;
    ({ type, source } = auto);
  } else {
    override = pending;
    type = pending;
    source = "override";
  }
  return { override, type, source, auto, note: typeNote(video, type, source, auto) };
}

/** The second line of the Auto item in the type menu, for example "Channel setting: Short 9:16". */
export function autoTypeHint(auto: AutoType): string {
  switch (auto.source) {
    case "channel":
      return `Channel setting: ${videoTypeLabel(auto.type)}`;
    case "detected":
      return `Detected: ${videoTypeLabel(auto.type)}`;
    case "assumed":
      return `Not detected, assumed ${videoTypeLabel(auto.type)}`;
  }
}

/** What the second line says next to the status pill. */
/** What the tooltip and the empty state of a channel whose folder cannot be reached say. */
export function unavailableText(name: string): string {
  return `The folder of "${name}" cannot be reached right now, for example because a drive is not connected. Its videos are shown again as soon as it can be read.`;
}

/** The quiet state of a video whose files are still arriving. */
export const UPLOADING_STATUS: VideoStatus = {
  label: "Uploading",
  tone: "neutral",
  icon: "dot",
  live: false,
};

/**
 * The status pill of a row: `videoStatus`, except that a video whose upload is not complete and
 * that has no job yet is "Uploading" (it cannot be edited before its files are all there).
 */
export function rowStatus(
  video: Pick<VideoView, "job" | "edited" | "finalRendered" | "uploading">,
) {
  return video.uploading && video.job === null ? UPLOADING_STATUS : videoStatus(video);
}

export interface RowDetail {
  text: string | null;
  tone: "muted" | "danger" | "warning";
}

/** Fallback lines for transient states whose `lastActivity` only repeats the pill. */
const TRANSIENT_TEXT: Partial<Record<string, string>> = {
  pausing: "Finishing the current step, then pausing",
  stopping: "Ending the agent and its tools",
};

/**
 * The line after the status pill for every state except a waiting job (the row words that from
 * `waitingText`): the error of a failed job, the last activity of a running one, else what the
 * video has produced.
 */
export function rowDetail(video: VideoView, status: VideoStatus): RowDetail {
  const job = video.job;
  if (job?.state === "failed") {
    return {
      text: job.error ?? job.lastActivity ?? "The edit stopped with an error.",
      tone: "danger",
    };
  }
  if (job && hasActiveJob(video)) {
    const activity = job.lastActivity?.trim() ?? "";
    const repeatsPill = activity === "" || activity.toLowerCase() === status.label.toLowerCase();
    return { text: repeatsPill ? (TRANSIENT_TEXT[job.state] ?? null) : activity, tone: "muted" };
  }
  // Files are still arriving: the A-roll is not complete, so nothing is missing yet.
  if (video.uploading) return { text: null, tone: "muted" };
  const { finals, newestFinal, project } = video.output;
  const final = finals.find((f) => f.name === newestFinal) ?? finals[0];
  if (final) return { text: `${final.name} · ${formatTimeAgo(final.modifiedAt)}`, tone: "muted" };
  if (project) return { text: `Project · ${formatTimeAgo(project.modifiedAt)}`, tone: "muted" };
  if (video.arollCount === 0) return { text: "No A-roll found in this folder", tone: "warning" };
  return { text: null, tone: "muted" };
}
