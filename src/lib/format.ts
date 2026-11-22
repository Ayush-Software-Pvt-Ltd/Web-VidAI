/**
 * Small formatting helpers shared by the UI. Presentation only, no business rules. Every time the
 * server sends is a number of milliseconds since 1970 (a duration is a number of milliseconds),
 * and every function here takes it that way; `now` is injectable for tests and ticking clocks.
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural sort order ("2 x" before "10 x"); use `(a, b) => naturalCompare(b, a)` for newest first. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Elapsed time as "42s", "12m 05s", "1h 07m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

/** Active time of a job including the current running stretch. */
export function activeMsNow(
  job: { activeMs: number; runningSince: number | null },
  now = Date.now(),
): number {
  if (job.runningSince === null) return job.activeMs;
  return job.activeMs + Math.max(0, now - job.runningSince);
}

/** "in 3h 12m", "in 4d 2h", "in 5m", or "now" for times in the past. */
export function formatTimeUntil(at: number, now = Date.now()): string {
  const diff = at - now;
  if (!(diff > 0)) return "now";
  const minutes = Math.ceil(diff / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

/**
 * The countdown of a job the start delay holds back: "Starts in 40 s" under a minute, then
 * "Starts in 6 min" and "Starts in 1 h 5 min", rounded up so it never says less than is left.
 * With `earliest` (the job also needs a slot to become free, so it may start later) it says
 * "Earliest start in 6 min" instead. `null` once the time has come.
 */
export function formatStartsIn(at: number, now = Date.now(), earliest = false): string | null {
  const ms = at - now;
  if (!(ms > 0)) return null;
  const prefix = earliest ? "Earliest start in" : "Starts in";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${prefix} ${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${prefix} ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${prefix} ${h} h` : `${prefix} ${h} h ${m} min`;
}

/** "2 minutes ago" style text for past times. */
export function formatTimeAgo(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

/** Local date and time, for example "Fri 14 Nov, 16:30". */
export function formatLocalDateTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Whole numbers for B and KB, one decimal from MB up (what the server prints for Disk Cleanup). */
const roundForUnit = (value: number, unit: number) =>
  unit >= 2 ? Math.round(value * 10) / 10 : Math.round(value);

/**
 * A size as the server's Disk Cleanup formats it: steps of 1024, whole numbers for B and KB, one
 * decimal from MB up, GB the top unit ("0 B", "512 B", "3 KB", "1.5 MB", "12.3 GB"). A value that
 * rounds up to the next unit's first step is shown there ("1023.97 MB" is "1.0 GB").
 */
export function formatBytes(bytes: number): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && roundForUnit(value, unit) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const rounded = roundForUnit(value, unit);
  return `${unit >= 2 ? rounded.toFixed(1) : String(rounded)} ${BYTE_UNITS[unit]}`;
}

/** A frame rate as the timeline carries it: a fraction (`30000/1001` is 29.97) or a plain number. */
export type FrameRate = number | { num: number; den: number };

/**
 * A frame number as the time code `HH:MM:SS:FF`. Frames are counted plainly, drop-frame is not
 * used: the rate is rounded to whole frames per second (30000/1001 counts 30, 24000/1001 counts
 * 24), so the frame field runs from 0 up to one less than that and the code is exact for every
 * frame number. Negative or fractional frames are clamped to a whole number of at least 0.
 */
export function formatTimecode(frame: number, fps: FrameRate): string {
  const rate = typeof fps === "number" ? fps : fps.num / fps.den;
  const base = Math.max(1, Math.round(rate));
  const total = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  const ff = total % base;
  const seconds = Math.floor(total / base);
  const ss = seconds % 60;
  const mm = Math.floor(seconds / 60) % 60;
  const hh = Math.floor(seconds / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

/**
 * What the model calls cost: "$0.42" (always two decimals), "<$0.01" for less than half a cent
 * but more than nothing, and "" when the program reported no cost.
 */
export function formatCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd) || usd < 0) return "";
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
