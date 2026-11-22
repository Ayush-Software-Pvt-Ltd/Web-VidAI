import { describe, expect, it } from "vitest";
import {
  activeMsNow,
  formatBytes,
  formatCost,
  formatDuration,
  formatLocalDateTime,
  formatStartsIn,
  formatTimeAgo,
  formatTimecode,
  formatTimeUntil,
  naturalCompare,
  pluralize,
} from "./format";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatStartsIn", () => {
  const at = (ms: number) => NOW + ms;
  it.each([
    [40_000, "Starts in 40 s"],
    [59_000, "Starts in 59 s"],
    [1, "Starts in 1 s"],
    [59_001, "Starts in 1 min"],
    [60_000, "Starts in 1 min"],
    [60_001, "Starts in 2 min"],
    [5 * MIN + 30_000, "Starts in 6 min"],
    [59 * MIN, "Starts in 59 min"],
    [HOUR, "Starts in 1 h"],
    [65 * MIN, "Starts in 1 h 5 min"],
    [120 * MIN, "Starts in 2 h"],
  ])("counts %i ms as %s (rounded up)", (ms, text) => {
    expect(formatStartsIn(at(ms), NOW)).toBe(text);
  });
  it("says nothing once the time has come", () => {
    expect(formatStartsIn(at(0), NOW)).toBeNull();
    expect(formatStartsIn(at(-5_000), NOW)).toBeNull();
    expect(formatStartsIn(Number.NaN, NOW)).toBeNull();
  });
  it("says Earliest start when the job also waits for a free slot", () => {
    expect(formatStartsIn(at(40_000), NOW, true)).toBe("Earliest start in 40 s");
    expect(formatStartsIn(at(5 * MIN + 30_000), NOW, true)).toBe("Earliest start in 6 min");
    expect(formatStartsIn(at(65 * MIN), NOW, true)).toBe("Earliest start in 1 h 5 min");
    expect(formatStartsIn(at(0), NOW, true)).toBeNull();
  });
});

describe("durations and relative times", () => {
  it("sorts naturally", () => {
    expect(["10 b", "9 a", "100 c"].sort(naturalCompare)).toEqual(["9 a", "10 b", "100 c"]);
  });
  it.each([
    [-5, "0s"],
    [0, "0s"],
    [999, "0s"],
    [42_000, "42s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [725_000, "12m 05s"],
    [3_599_000, "59m 59s"],
    [HOUR, "1h 00m"],
    [4_020_000, "1h 07m"],
    [27 * HOUR + 5 * MIN, "27h 05m"],
  ])("formats %i ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
  it("adds the running stretch to active time", () => {
    const now = NOW + 10 * MIN;
    expect(activeMsNow({ activeMs: 1000, runningSince: now - MIN }, now)).toBe(61_000);
    expect(activeMsNow({ activeMs: 1000, runningSince: null }, now)).toBe(1000);
    // A clock that is a little behind the server never makes the time shrink.
    expect(activeMsNow({ activeMs: 1000, runningSince: now + 5000 }, now)).toBe(1000);
  });
  it.each([
    [3 * HOUR + 12 * MIN, "in 3h 12m"],
    [4 * DAY + 2 * HOUR, "in 4d 2h"],
    [5 * MIN, "in 5m"],
    [1, "in 1m"],
    [0, "now"],
    [-DAY, "now"],
  ])("formats a time %i ms ahead as %s", (ms, text) => {
    expect(formatTimeUntil(NOW + ms, NOW)).toBe(text);
  });
  it("formats times ago", () => {
    expect(formatTimeAgo(NOW - 10_000, NOW)).toBe("just now");
    expect(formatTimeAgo(NOW - 5 * MIN, NOW)).toMatch(/5 minutes ago/);
    expect(formatTimeAgo(NOW - 3 * HOUR, NOW)).toMatch(/3 hours ago/);
    expect(formatTimeAgo(NOW - 2 * DAY, NOW)).toMatch(/2 days ago/);
  });
  it("formats a local date and time from milliseconds", () => {
    const text = formatLocalDateTime(Date.parse("2026-11-14T16:30:00"));
    expect(text).toMatch(/14/);
    expect(text).toMatch(/16:30|4:30/);
  });
  it("pluralizes", () => {
    expect(pluralize(1, "video")).toBe("1 video");
    expect(pluralize(0, "video")).toBe("0 videos");
    expect(pluralize(2, "box", "boxes")).toBe("2 boxes");
  });
});

describe("formatBytes (as the server's Disk Cleanup formats it)", () => {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  it.each([
    [0, "0 B"],
    [-1, "0 B"],
    [Number.NaN, "0 B"],
    [1, "1 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1023.6, "1 KB"],
    [KB, "1 KB"],
    [1536, "2 KB"],
    [3 * KB, "3 KB"],
    [1023 * KB, "1023 KB"],
    [1023.6 * KB, "1.0 MB"],
    [MB, "1.0 MB"],
    [1.5 * MB, "1.5 MB"],
    [1023 * MB, "1023.0 MB"],
    [1023.97 * MB, "1.0 GB"],
    [GB, "1.0 GB"],
    [12.3 * GB, "12.3 GB"],
    [5000 * GB, "5000.0 GB"],
  ])("formats %d bytes as %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("formatTimecode", () => {
  it.each([
    // [fps, frame, text]
    [24, 0, "00:00:00:00"],
    [24, 23, "00:00:00:23"],
    [24, 24, "00:00:01:00"],
    [24, 24 * 60 + 5, "00:01:00:05"],
    [25, 24, "00:00:00:24"],
    [25, 25, "00:00:01:00"],
    [25, 25 * 3600 + 25 * 61 + 7, "01:01:01:07"],
    [30, 29, "00:00:00:29"],
    [30, 30, "00:00:01:00"],
    [30, 30 * 3599 + 29, "00:59:59:29"],
    [30, 30 * 3600, "01:00:00:00"],
    [60, 59, "00:00:00:59"],
    [60, 60, "00:00:01:00"],
    [60, 60 * 90 + 1, "00:01:30:01"],
  ])("at %i fps frame %i is %s", (fps, frame, text) => {
    expect(formatTimecode(frame, fps)).toBe(text);
  });
  it("counts 30000/1001 as 30 frames per second, without dropping frames", () => {
    const fps = { num: 30000, den: 1001 };
    expect(formatTimecode(29, fps)).toBe("00:00:00:29");
    expect(formatTimecode(30, fps)).toBe("00:00:01:00");
    // Drop-frame would skip 00 and 01 at minute 1; plain counting does not.
    expect(formatTimecode(1800, fps)).toBe("00:01:00:00");
    expect(formatTimecode(1801, fps)).toBe("00:01:00:01");
    expect(formatTimecode(107_892, fps)).toBe("00:59:56:12");
    expect(formatTimecode(108_000, fps)).toBe("01:00:00:00");
  });
  it("counts 24000/1001 as 24", () => {
    expect(formatTimecode(24, { num: 24000, den: 1001 })).toBe("00:00:01:00");
  });
  it("accepts a whole-number rate as a fraction too", () => {
    expect(formatTimecode(61, { num: 60, den: 1 })).toBe("00:00:01:01");
  });
  it("clamps odd frames", () => {
    expect(formatTimecode(-5, 30)).toBe("00:00:00:00");
    expect(formatTimecode(Number.NaN, 30)).toBe("00:00:00:00");
    expect(formatTimecode(31.9, 30)).toBe("00:00:01:01");
  });
});

describe("formatCost", () => {
  it.each([
    [null, ""],
    [Number.NaN, ""],
    [-1, ""],
    [0, "$0.00"],
    [0.001, "<$0.01"],
    [0.004, "<$0.01"],
    [0.005, "$0.01"],
    [0.42, "$0.42"],
    [1, "$1.00"],
    [12.3, "$12.30"],
    [1234.567, "$1234.57"],
  ])("formats %s as %j", (usd, text) => {
    expect(formatCost(usd)).toBe(text);
  });
});
