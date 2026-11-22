// Wire types of the library (docs/SPEC.md sections 6, 8 and 14): the videos of a user's channels
// as the browser shows them. Pure declarations; every field is always present (`null` when empty),
// every time is milliseconds since 1970 and no field holds a path on the server: files are named
// by their path relative to the video folder and fetched with
// `GET /api/file?video=<video id>&path=<relative path>`.

import type { ChannelVideoType, VideoType } from "./channels.ts";
import type { JobView } from "./jobs.ts";

/** Which step of "override, channel setting, detected, assumed Long" decided `videoType`. */
export type TypeSource = "override" | "channel" | "detected" | "assumed";

/**
 * What a video row may offer right now. The server computes it (SPEC section 8); the page only
 * shows the buttons.
 * - `startEdit`: no active job and no upload in progress.
 * - `pause`, `continue`, `stop`: follow the latest job's state.
 * - `reEdit`: a project exists and no job is active.
 * - `review`: a project exists (open the timeline).
 * - `renderFinal`: a project exists and no job is active.
 * - `upload`: add files to the video folder.
 * - `diskCleanup`: no job is active and the working folder `CLAUDE_VE` holds files.
 * - `archive`: no active job, and the video is edited or its last job failed.
 * - `unarchive`: the video is archived (only in the Archive page's menu).
 * - `startNow`: admins only; a queued edit held back only by the start delay.
 */
export type VideoAction =
  | "startEdit"
  | "pause"
  | "continue"
  | "stop"
  | "reEdit"
  | "review"
  | "renderFinal"
  | "upload"
  | "diskCleanup"
  | "archive"
  | "unarchive"
  | "startNow";

/** A file inside the video folder. */
export interface OutputFile {
  name: string;
  /** Relative to the video folder, with `/` separators, for example `output/final.mp4`. */
  path: string;
  size: number;
  modifiedAt: number;
}

/** The HyperFrames project of a video: `output/<video folder name>.hf/index.html`. */
export interface VideoProject {
  /** Relative to the video folder: `output/<folder name>.hf/index.html`. */
  path: string;
  /** Modified time of `index.html`. */
  modifiedAt: number;
}

/** What `<video>/output/` and the video folder hold (SPEC section 6, Videos). */
export interface VideoOutput {
  /** `null` when there is no project (the video has not been edited). */
  project: VideoProject | null;
  /** `*.mp4`, `*.mov`, `*.m4v` directly in `output/`, in natural order of their names. */
  finals: OutputFile[];
  /** The name of the most recently modified final (the one to play first); `null` without finals. */
  newestFinal: string | null;
  /** `thumbnail-*.png|jpg|jpeg` directly in `output/`, in natural order. */
  thumbnails: OutputFile[];
  /** `output/meta.txt`; `null` when absent. */
  metaFile: string | null;
  /** `info.txt` in the video folder; `null` when absent. */
  infoFile: string | null;
}

/** Remembered per video (SPEC section 15, `videos.inputs`). */
export interface VideoInputs {
  productLinks: string;
  notes: string;
  /** Index of the selected prompt of the video's type, 0 to 4. */
  promptSlot: number;
  /** Index of the selected style, 0 to 4. */
  styleSlot: number;
}

export interface VideoView {
  /** `<channelId>/<folder name>`. */
  id: string;
  channelId: string;
  folderName: string;
  /** Creation time of the video folder, its modified time when the file system keeps none. */
  createdAt: number;
  /** `null` when there is no readable A-roll. */
  detectedType: VideoType | null;
  typeOverride: VideoType | null;
  /** The channel's video type setting. */
  channelType: ChannelVideoType;
  /** The effective type: override, else the channel's setting unless `auto`, else detected, else Long. */
  videoType: VideoType;
  typeSource: TypeSource;
  /** A-roll files directly in the video folder. */
  arollCount: number;
  output: VideoOutput;
  /** A project exists (`output.project` is not `null`). */
  edited: boolean;
  /** `output.finals` is not empty. */
  finalRendered: boolean;
  /** An upload into this video folder is not complete. */
  uploading: boolean;
  /** The latest job of this video. */
  job: JobView | null;
  actions: VideoAction[];
}

/** One channel of the library; `available: false` means its directory cannot be read right now. */
export interface ChannelLibrary {
  channelId: string;
  available: boolean;
  /** Newest first (names in descending natural order); archived videos are not listed. */
  videos: VideoView[];
}

/** The answer of `getLibrary` and the payload of `library-changed`; one entry per channel, in the user's order. */
export interface Library {
  channels: ChannelLibrary[];
}

/** One video removed from the main list with Archive (the Archive page). */
export interface ArchivedVideo {
  /** `<channelId>/<folder name>`. */
  videoId: string;
  channelId: string;
  channelName: string;
  folderName: string;
  archivedAt: number;
}
