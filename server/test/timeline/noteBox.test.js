import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeupBox,
  CLOSEUP_MARGIN,
  fitBetween,
  fitLongSide,
  outlineCondition,
} from "../../src/timeline/noteBox.js";

test("the close-up is the ellipse's bounding box plus 15 percent on every side", () => {
  assert.equal(CLOSEUP_MARGIN, 0.15);
  // Box x 0.4..0.6 (0.2 wide), y 0.4..0.6; margin 0.03 each side: 0.37..0.63 = 0.26.
  const box = closeupBox({ cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 }, 1000, 1000);
  assert.deepEqual(box, { x: 370, y: 370, w: 260, h: 260 });
});

test("the close-up is clamped to the frame at every edge and keeps its size", () => {
  const w = 1920;
  const h = 1080;
  const left = closeupBox({ cx: 0.02, cy: 0.5, rx: 0.1, ry: 0.1 }, w, h);
  assert.equal(left.x, 0);
  assert.equal(left.w, Math.ceil(0.26 * w));
  const right = closeupBox({ cx: 0.99, cy: 0.5, rx: 0.1, ry: 0.1 }, w, h);
  assert.equal(right.x + right.w, w);
  assert.equal(right.w, 500);
  const top = closeupBox({ cx: 0.5, cy: 0, rx: 0.1, ry: 0.1 }, w, h);
  assert.equal(top.y, 0);
  const bottom = closeupBox({ cx: 0.5, cy: 1, rx: 0.1, ry: 0.1 }, w, h);
  assert.equal(bottom.y + bottom.h, h);
  for (const b of [left, right, top, bottom]) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h && b.w >= 1 && b.h >= 1);
  }
});

test("an ellipse as big as the frame gives the whole frame", () => {
  assert.deepEqual(closeupBox({ cx: 0.5, cy: 0.5, rx: 1, ry: 1 }, 1920, 1080), {
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
  });
  assert.deepEqual(closeupBox({ cx: 1, cy: 1, rx: 0.9, ry: 0.9 }, 640, 360), {
    x: 0,
    y: 0,
    w: 640,
    h: 360,
  });
});

test("a tiny ellipse still gives a close-up of at least a tenth of the frame", () => {
  const box = closeupBox({ cx: 0.5, cy: 0.5, rx: 0.001, ry: 0.001 }, 1920, 1080);
  assert.equal(box.w, 192);
  assert.equal(box.h, 108);
  assert.equal(box.x, 864);
  const corner = closeupBox({ cx: 0, cy: 0, rx: 0.001, ry: 0.001 }, 1920, 1080);
  assert.deepEqual(corner, { x: 0, y: 0, w: 192, h: 108 });
});

test("a Short frame and a thin ellipse", () => {
  const box = closeupBox({ cx: 0.5, cy: 0.3, rx: 0.4, ry: 0.02 }, 1080, 1920);
  assert.equal(box.x, 0);
  assert.equal(box.w, 1080);
  assert.equal(box.h, 192);
  assert.equal(box.y, 480);
});

test("sizes of the pictures", () => {
  assert.deepEqual(fitLongSide(3840, 2160, 1280), { w: 1280, h: 720 });
  assert.deepEqual(fitLongSide(1080, 1920, 1280), { w: 720, h: 1280 });
  assert.deepEqual(fitLongSide(640, 360, 1280), { w: 640, h: 360 });
  assert.deepEqual(fitBetween(200, 100, 800, 1600), { w: 800, h: 400 });
  assert.deepEqual(fitBetween(3000, 1500, 800, 1600), { w: 1600, h: 800 });
  assert.deepEqual(fitBetween(1000, 500, 800, 1600), { w: 1000, h: 500 });
});

test("the outline condition names the centre and radii in pixels of the picture", () => {
  const text = outlineCondition({ cx: 0.5, cy: 0.25, rx: 0.1, ry: 0.2 }, 1280, 720);
  assert.match(text, /^lt\(abs\(hypot\(/);
  assert.ok(text.includes("(X-640.000)/128.000"));
  assert.ok(text.includes("(Y-180.000)/144.000"));
  // 4 pixels at 1280 wide: half is 2.
  assert.ok(text.includes(",2.000*hypot("));
  // A bigger picture gets a thicker line.
  assert.ok(
    outlineCondition({ cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 }, 2560, 1440).includes(",4.000*hypot("),
  );
});
