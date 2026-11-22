import { describe, expect, it } from "vitest";
import {
  clampFrame,
  clipLengthText,
  durationText,
  fpsValue,
  framesToSeconds,
  lastFrame,
  nominalFps,
  rulerLabel,
  secondsToFrames,
  timeCode,
} from "./time";

const F24 = { num: 24000, den: 1001 };
const F30 = { num: 30, den: 1 };
const F2997 = { num: 30000, den: 1001 };
const F60 = { num: 60, den: 1 };

describe("rates", () => {
  it.each([
    [F24, 24],
    [F30, 30],
    [F2997, 30],
    [F60, 60],
    [{ num: 1, den: 100 }, 1],
  ])("nominal rate of %j is %i", (fps, n) => {
    expect(nominalFps(fps)).toBe(n);
  });
  it("fpsValue is the exact rate", () => {
    expect(fpsValue(F2997)).toBeCloseTo(29.97, 2);
  });
});

describe("frames and seconds", () => {
  it.each([
    [0, F30, 0],
    [30, F30, 1],
    [45, F30, 1.5],
    [60, F60, 1],
    [30000, F2997, 1001],
    [24000, F24, 1001],
  ])("frame %i at %j starts at %f s", (frame, fps, seconds) => {
    expect(framesToSeconds(frame, fps)).toBeCloseTo(seconds, 6);
  });
  it.each([
    [0, F30, 0],
    [1.5, F30, 45],
    [1, F2997, 30],
    [1, F24, 24],
    [-3, F30, 0],
    [0.016, F60, 1],
  ])("%f s at %j is frame %i", (seconds, fps, frame) => {
    expect(secondsToFrames(seconds, fps)).toBe(frame);
  });
  it("round-trips every frame of a minute at 29.97", () => {
    for (let frame = 0; frame < 1800; frame += 1) {
      expect(secondsToFrames(framesToSeconds(frame, F2997), F2997)).toBe(frame);
    }
  });
  it("lastFrame and clampFrame", () => {
    expect(lastFrame(0)).toBe(0);
    expect(lastFrame(1)).toBe(0);
    expect(lastFrame(400)).toBe(399);
    expect(clampFrame(-5, 399)).toBe(0);
    expect(clampFrame(400.4, 399)).toBe(399);
    expect(clampFrame(10.6, 399)).toBe(11);
    expect(clampFrame(Number.NaN, 399)).toBe(0);
    expect(clampFrame(5, -1)).toBe(0);
  });
});

describe("time code (no drop frame, nominal rate)", () => {
  it.each([
    [0, F30, "00:00:00"],
    [29, F30, "00:00:29"],
    [30, F30, "00:01:00"],
    [1800, F30, "01:00:00"],
    [107_999, F30, "59:59:29"],
    [108_000, F30, "1:00:00:00"],
    [23, F24, "00:00:23"],
    [24, F24, "00:01:00"],
    [30, F2997, "00:01:00"],
    [59, F60, "00:00:59"],
    [60, F60, "00:01:00"],
    [-4, F30, "00:00:00"],
  ])("frame %i at %j reads %s", (frame, fps, text) => {
    expect(timeCode(frame, fps)).toBe(text);
  });
});

describe("ruler labels", () => {
  it.each([
    [0, F30, "0:00"],
    [150, F30, "0:05"],
    [1800, F30, "1:00"],
    [108_000, F30, "1:00:00"],
    [15, F30, "0:00:15"],
    [165, F30, "0:05:15"],
    [90, F60, "0:01:30"],
  ])("frame %i at %j is %s", (frame, fps, text) => {
    expect(rulerLabel(frame, fps)).toBe(text);
  });
});

describe("durations", () => {
  it.each([
    [0, F30, "0:00"],
    [15, F30, "0:01"],
    [14, F30, "0:00"],
    [1800, F30, "1:00"],
    [108_000, F30, "1:00:00"],
    [3600 * 30 + 61 * 30, F30, "1:01:01"],
  ])("%i frames at %j: %s", (frames, fps, text) => {
    expect(durationText(frames, fps)).toBe(text);
  });
  it.each([
    [1, "1 frame"],
    [2, "2 frames"],
    [29, "29 frames"],
    [30, "1.0 s"],
    [72, "2.4 s"],
    [299, "10.0 s"],
    [300, "0:10"],
    [1800, "1:00"],
  ])("clip length of %i frames at 30 fps: %s", (frames, text) => {
    expect(clipLengthText(frames, F30)).toBe(text);
  });
});
