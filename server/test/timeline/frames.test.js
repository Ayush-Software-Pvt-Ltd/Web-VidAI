import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fpsToNumber,
  fpsToString,
  framesToSeconds,
  framesToSecondsText,
  isOnFrameBoundary,
  makeFps,
  parseFps,
  readSeconds,
  secondsToFrames,
} from "../../src/timeline/frames.js";

/** @param {string} text */
const fps = (text) => {
  const value = parseFps(text);
  assert.ok(value, `parseFps(${text})`);
  return value;
};

test("frame rates: integers, rationals and decimals", () => {
  assert.deepEqual(parseFps("30"), { num: 30, den: 1 });
  assert.deepEqual(parseFps(25), { num: 25, den: 1 });
  assert.deepEqual(parseFps("30000/1001"), { num: 30000, den: 1001 });
  assert.deepEqual(parseFps("24000 / 1001"), { num: 24000, den: 1001 });
  assert.deepEqual(parseFps("60/2"), { num: 30, den: 1 });
  assert.deepEqual(parseFps("29.97"), { num: 30000, den: 1001 });
  assert.deepEqual(parseFps("23.976"), { num: 24000, den: 1001 });
  assert.deepEqual(parseFps("59.94"), { num: 60000, den: 1001 });
  assert.deepEqual(parseFps(29.97), { num: 30000, den: 1001 });
  assert.deepEqual(parseFps("12.5"), { num: 25, den: 2 });
  assert.deepEqual(parseFps("30.0"), { num: 30, den: 1 });
  assert.equal(fpsToString(fps("30000/1001")), "30000/1001");
  assert.equal(fpsToString(fps("30")), "30");
  assert.ok(Math.abs(fpsToNumber(fps("29.97")) - 29.97003) < 1e-5);
});

test("bad frame rates are refused", () => {
  for (const bad of [
    "",
    "abc",
    "0",
    "-30",
    "30/0",
    "0/1",
    "1000",
    "0.5",
    "30fps",
    "1e2",
    null,
    undefined,
    NaN,
    0,
    "12.5000001",
  ]) {
    assert.equal(parseFps(/** @type {never} */ (bad)), null, String(bad));
  }
  assert.equal(makeFps(1.5, 1), null);
});

test("seconds read as frames, with the boundary test", () => {
  const f30 = fps("30");
  assert.equal(secondsToFrames("1", f30), 30);
  assert.equal(secondsToFrames("0", f30), 0);
  assert.equal(secondsToFrames(".5", f30), 15);
  assert.equal(secondsToFrames("1.0333333333", f30), 31);
  assert.equal(secondsToFrames("1.033333", f30), 31, "six decimals still read as the same frame");
  assert.equal(secondsToFrames(2, f30), 60);
  assert.equal(secondsToFrames("x", f30), null);
  assert.equal(secondsToFrames("-1", f30), null);
  assert.equal(secondsToFrames("1s", f30), null);
  assert.equal(secondsToFrames("1e3", f30), null);
  assert.equal(secondsToFrames(null, f30), null);
  assert.equal(secondsToFrames("", f30), null);
  assert.equal(secondsToFrames("1.", f30), 30);
});

test("a time falls on a frame boundary within 1/100 of a frame", () => {
  const f30 = fps("30");
  const frame = 1 / 30;
  assert.equal(isOnFrameBoundary("1", f30), true);
  assert.equal(isOnFrameBoundary(String(frame), f30), true);
  assert.equal(isOnFrameBoundary("0.033333", f30), true);
  assert.equal(isOnFrameBoundary("0.0334", f30), true);
  assert.equal(isOnFrameBoundary(String(frame + 0.0099 * frame), f30), true);
  assert.equal(isOnFrameBoundary(String(frame + 0.011 * frame), f30), false);
  assert.equal(isOnFrameBoundary("0.5", f30), true);
  assert.equal(isOnFrameBoundary("0.51", f30), false);
  assert.equal(isOnFrameBoundary("1.01", f30), false);
  assert.equal(isOnFrameBoundary("abc", f30), false);
  const reading = readSeconds("0.51", f30);
  assert.equal(reading?.frames, 15);
  assert.ok(Math.abs((reading?.exact ?? 0) - 15.3) < 1e-9);
});

test("seconds are written as the shortest text of at most 9 decimals", () => {
  const f30 = fps("30");
  assert.equal(framesToSecondsText(0, f30), "0");
  assert.equal(framesToSecondsText(30, f30), "1");
  assert.equal(framesToSecondsText(15, f30), "0.5");
  assert.equal(framesToSecondsText(1, f30), "0.033333333");
  assert.equal(framesToSecondsText(2, f30), "0.066666667");
  assert.equal(framesToSecondsText(45, f30), "1.5");
  assert.equal(framesToSecondsText(7, fps("25")), "0.28");
  assert.equal(framesToSecondsText(1, fps("30000/1001")), "0.033366667");
  assert.equal(framesToSecondsText(1, fps("24000/1001")), "0.041708333");
  assert.equal(framesToSecondsText(1, fps("60")), "0.016666667");
  assert.throws(() => framesToSecondsText(-1, f30));
  assert.throws(() => framesToSecondsText(Number.NaN, f30));
});

test("a fractional frame count (an in-point between frames) is written within 1e-9 seconds", () => {
  const f25 = fps("25");
  assert.equal(framesToSecondsText(1062.5, f25), "42.5");
  const f = fps("30000/1001");
  const text = framesToSecondsText(299.7003, f);
  assert.ok(Math.abs(Number(text) - 299.7003 * (1001 / 30000)) <= 1e-9);
});

for (const rate of ["25", "30", "60", "30000/1001", "24000/1001"]) {
  test(`every frame of a 30 minute video round-trips at ${rate} fps and is written within 1e-9 s`, () => {
    const f = fps(rate);
    const total = Math.ceil(30 * 60 * fpsToNumber(f));
    for (let frame = 0; frame <= total; frame++) {
      const text = framesToSecondsText(frame, f);
      assert.ok(text.split(".")[1]?.length ?? 0 <= 9, text);
      assert.equal(secondsToFrames(text, f), frame, `frame ${frame} as ${text}`);
      assert.equal(isOnFrameBoundary(text, f), true, `frame ${frame} as ${text}`);
      const error = Math.abs(Number(text) - framesToSeconds(frame, f));
      assert.ok(error <= 1e-9 + 1e-12, `frame ${frame} as ${text} is ${error} s off`);
    }
  });
}

test("the written text is the shortest that meets the tolerance", () => {
  const f = fps("30000/1001");
  for (let frame = 1; frame < 3000; frame += 7) {
    const text = framesToSecondsText(frame, f);
    const decimals = text.split(".")[1]?.length ?? 0;
    if (decimals === 0) continue;
    const exact = framesToSeconds(frame, f);
    const shorter = Number(exact.toFixed(decimals - 1));
    assert.ok(
      Math.abs(shorter - exact) > 1e-9,
      `${frame}: ${decimals - 1} decimals would have done`,
    );
  }
});
