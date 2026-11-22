// Wire types of Disk Cleanup (docs/SPEC.md section 13): how much room each of the user's videos
// takes and what deleting its working files freed. Pure declarations; every field is always
// present (`null` when empty), sizes are bytes and times are milliseconds since 1970.

/** The four parts of a video folder; `total` is their sum. */
export interface DiskSizes {
  /** `<video>/CLAUDE_VE/`: what Disk Cleanup deletes. */
  working: number;
  /** `<video>/output/<folder name>.hf/`. */
  project: number;
  /** `<video>/output/*_final_v*.mp4`. */
  finals: number;
  /** The rest of the video folder: A-roll, B-roll, other output files. */
  sources: number;
  total: number;
}

export interface DiskVideo {
  /** `<channelId>/<folder name>`. */
  videoId: string;
  channelId: string;
  channelName: string;
  folderName: string;
  archived: boolean;
  /** `null` until the folder was measured for the first time. */
  sizes: DiskSizes | null;
  /** The numbers are being measured or checked; `sizes` may be out of date until they arrive. */
  measuring: boolean;
  /** When `sizes` were measured; `null` while there are none. */
  measuredAt: number | null;
}

/**
 * The answer of `getDiskUse` and the payload of the `disk-use-changed` event.
 * Videos are in the order of the user's channels, newest folder name first; the page sorts.
 */
export interface DiskUse {
  videos: DiskVideo[];
  /** The sums over the videos that have `sizes`. */
  totals: DiskSizes;
  /** At least one video is still being measured. */
  measuring: boolean;
}

/** The answer of `cleanWorkingFiles`. */
export interface CleanResult {
  /** Bytes that were really freed. */
  freedBytes: number;
  /** Files and folders that could not be removed (in use, no permission); 0 when all went. */
  leftover: number;
}
