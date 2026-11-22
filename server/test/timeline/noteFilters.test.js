import assert from "node:assert/strict";
import { test } from "node:test";
import { pictureArgs } from "../../src/timeline/noteFilters.js";

const base = {
  input: "/work/still.png",
  inputWidth: 3840,
  inputHeight: 2160,
  frameFile: "/n/frame.png",
  markedFile: "/n/frame-marked.png",
  closeupFile: "/n/closeup.png",
};

test("without a shape only the whole frame is made, reduced to 1280 on the long side", () => {
  const args = pictureArgs({ ...base, shape: null });
  assert.deepEqual(args, [
    "-v",
    "error",
    "-y",
    "-i",
    "/work/still.png",
    "-filter_complex",
    "[0:v]scale=1280:720:flags=lanczos[f]",
    "-map",
    "[f]",
    "-frames:v",
    "1",
    "-update",
    "1",
    "/n/frame.png",
  ]);
});

test("a normal-density capture is not enlarged", () => {
  const args = pictureArgs({ ...base, inputWidth: 1000, inputHeight: 500, shape: null });
  assert.ok(args.includes("[0:v]scale=1000:500:flags=lanczos[f]"));
});

test("a Short frame is reduced on its height", () => {
  const args = pictureArgs({ ...base, inputWidth: 2160, inputHeight: 3840, shape: null });
  assert.ok(args.includes("[0:v]scale=720:1280:flags=lanczos[f]"));
});

test("with a shape the frame, the marked copy and the close-up come from one read", () => {
  const args = pictureArgs({ ...base, shape: { cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 } });
  assert.equal(args.filter((a) => a === "-i").length, 1);
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(graph.startsWith("[0:v]split=3[s1][s2][s3];"));
  assert.ok(graph.includes("[s1]scale=1280:720:flags=lanczos[f]"));
  assert.ok(graph.includes("format=gbrp,geq=r='if(lt(abs(hypot("));
  // The close-up is cut from the full-density capture: 26 percent of 3840 x 2160.
  assert.ok(graph.includes("[s3]crop=1000:562:1420:799,scale=1000:562:flags=lanczos[c]"), graph);
  assert.deepEqual(args.slice(-21), [
    "-map",
    "[f]",
    "-frames:v",
    "1",
    "-update",
    "1",
    "/n/frame.png",
    "-map",
    "[m]",
    "-frames:v",
    "1",
    "-update",
    "1",
    "/n/frame-marked.png",
    "-map",
    "[c]",
    "-frames:v",
    "1",
    "-update",
    "1",
    "/n/closeup.png",
  ]);
});
