import assert from "node:assert/strict";
import { test } from "node:test";
import { fpsOf } from "./noteSupport.js";
import { frameMiddle, frameMiddleText } from "../../src/timeline/noteTimes.js";

/** @type {Array<[string, import("../../src/timeline/frames.js").Fps]>} */
const rates = [
  ["24", fpsOf(24, 1)],
  ["25", fpsOf(25, 1)],
  ["30", fpsOf(30, 1)],
  ["30000/1001", fpsOf(30000, 1001)],
  ["60", fpsOf(60, 1)],
  ["24000/1001", fpsOf(24000, 1001)],
];

for (const [name, fps] of rates) {
  test(`the instant of a frame lies inside the frame at ${name} fps`, () => {
    for (const frame of [0, 1, 2, 29, 30, 31, 1000, 17999, 107999]) {
      const text = frameMiddleText(frame, fps);
      assert.match(text, /^\d+\.\d{6}$/);
      const start = (frame * fps.den) / fps.num;
      const end = ((frame + 1) * fps.den) / fps.num;
      const seconds = Number(text);
      assert.ok(seconds > start && seconds < end, `${frame}: ${text} not in ${start}..${end}`);
      // The nearest frame boundary is a quarter of a frame away at least (rounding of the text is ~1e-6).
      const margin = Math.min(seconds - start, end - seconds);
      assert.ok(margin > (0.4 * fps.den) / fps.num, `${frame}: margin ${margin}`);
      // The frame a renderer would pick for that instant.
      assert.equal(Math.floor((seconds * fps.num) / fps.den), frame);
    }
  });
}

test("known values", () => {
  assert.equal(frameMiddleText(0, fpsOf(30, 1)), "0.016667");
  assert.equal(frameMiddleText(75, fpsOf(30, 1)), "2.516667");
  assert.equal(frameMiddleText(0, fpsOf(24, 1)), "0.020833");
  assert.equal(frameMiddleText(0, fpsOf(60, 1)), "0.008333");
  assert.equal(frameMiddleText(1, fpsOf(25, 1)), "0.060000");
  // 30000/1001: 1001 * 3 / 60000 = 0.05005 for frame 1's middle (1.5 frames).
  assert.equal(frameMiddleText(1, fpsOf(30000, 1001)), "0.050050");
  assert.equal(frameMiddle(3, fpsOf(24, 1)), 3.5 / 24);
});
