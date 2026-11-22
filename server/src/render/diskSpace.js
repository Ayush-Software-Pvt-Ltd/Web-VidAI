// The room a render needs (docs/SPEC.md section 12) on the disk that holds `cache/`: at 1080,
// 1 GB per minute of video plus 5 GB; at 2160, 5 GB per minute plus 8 GB (measured: 2 to 5 GB of
// temporary files per minute at 4K). A render is refused with a sentence that names the
// resolution and both numbers.

const GB = 1024 ** 3;

/** @typedef {1080 | 2160} RenderResolution */

/**
 * The room per resolution: the part that does not depend on the length and the part per minute
 * of video, in bytes.
 * @type {Record<RenderResolution, { baseBytes: number, perMinuteBytes: number }>}
 */
export const ROOM = {
  1080: { baseBytes: 5 * GB, perMinuteBytes: 1 * GB },
  2160: { baseBytes: 8 * GB, perMinuteBytes: 5 * GB },
};

/** The part of the need at 1080 that does not depend on the length, in bytes. */
export const BASE_BYTES = ROOM[1080].baseBytes;
/** The part of the need at 1080 per minute of video, in bytes. */
export const PER_MINUTE_BYTES = ROOM[1080].perMinuteBytes;

/**
 * @param {number} seconds Length of the video.
 * @param {RenderResolution} [resolution] `1080` (default) or `2160`.
 * @returns {number} Free bytes the render needs.
 */
export function requiredBytes(seconds, resolution = 1080) {
  const { baseBytes, perMinuteBytes } = ROOM[resolution];
  return baseBytes + (Math.max(seconds, 0) / 60) * perMinuteBytes;
}

/** @param {number} bytes @returns {string} `12.3 GB`. */
export function gigabytes(bytes) {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** @param {number} seconds @returns {string} `15:00` or `1:02:03`. */
export function clockText(seconds) {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The refusal for a disk with too little room, or `null` when there is enough.
 * @param {{ seconds: number, freeBytes: number, resolution?: RenderResolution }} input
 * @returns {string | null}
 */
export function diskRefusal({ seconds, freeBytes, resolution = 1080 }) {
  const needed = requiredBytes(seconds, resolution);
  if (freeBytes >= needed) return null;
  const { baseBytes, perMinuteBytes } = ROOM[resolution];
  return (
    `There is not enough free disk space to render this video at ${resolution}p: it needs ` +
    `${gigabytes(needed)} (${perMinuteBytes / GB} GB for each minute of its ` +
    `${clockText(seconds)} plus ${baseBytes / GB} GB) and only ` +
    `${gigabytes(freeBytes)} are free. Free some space on the server and try again.`
  );
}
